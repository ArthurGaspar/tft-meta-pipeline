"""Stack templates: infrastructure as code for minicloud, in the spirit of CloudFormation.

A template declares named resources. Values can reference other resources with
`${Resource.attribute}` and environment variables with `${env:NAME}` or
`${env:NAME:default}`. Loading resolves every reference and validates every
resource before anything is created, so a bad template fails as a whole.
"""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

REF = re.compile(r"\$\{([^}]+)\}")

# Allowed and required properties per resource type.
SCHEMA: dict[str, dict[str, set[str]]] = {
    "bucket": {"required": {"name"}, "optional": set()},
    "queue": {"required": {"name"}, "optional": set()},
    "database": {"required": {"engine", "host", "port", "name", "user"}, "optional": {"password", "schema"}},
    "function": {
        "required": {"handler"},
        "optional": {"timeout", "memory", "environment", "retries", "dead_letter", "description"},
    },
    "trigger": {"required": {"source", "target"}, "optional": {"events", "prefix", "suffix"}},
    "schedule": {"required": {"expression", "target"}, "optional": {"description"}},
}

RATE = re.compile(r"^rate\((\d+) (minute|minutes|hour|hours)\)$")


class TemplateError(ValueError):
    pass


@dataclass
class Resource:
    name: str
    type: str
    props: dict[str, Any]


@dataclass
class Stack:
    name: str
    region: str
    resources: dict[str, Resource] = field(default_factory=dict)

    def of_type(self, kind: str) -> list[Resource]:
        return [r for r in self.resources.values() if r.type == kind]


def _resolve(value: Any, raw: dict[str, dict], seen: tuple[str, ...] = ()) -> Any:
    if isinstance(value, dict):
        return {k: _resolve(v, raw, seen) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve(v, raw, seen) for v in value]
    if not isinstance(value, str):
        return value

    def sub(m: re.Match) -> str:
        expr = m.group(1)
        if expr.startswith("env:"):
            name, _, default = expr[4:].partition(":")
            if name in os.environ:
                return os.environ[name]
            if default or expr.count(":") == 2:
                return default
            raise TemplateError(f"environment variable {name} is not set and has no default")
        res, _, attr = expr.partition(".")
        if res not in raw:
            raise TemplateError(f"${{{expr}}} refers to unknown resource {res}")
        if res in seen:
            raise TemplateError(f"circular reference through {res}")
        target = raw[res]
        if attr in ("", "name") and "name" in target:
            return str(_resolve(target["name"], raw, seen + (res,)))
        if attr not in target:
            raise TemplateError(f"${{{expr}}}: {res} has no attribute {attr}")
        return str(_resolve(target[attr], raw, seen + (res,)))

    # A value that is exactly one reference keeps the referenced type (e.g. a port number).
    whole = REF.fullmatch(value)
    if whole and not whole.group(1).startswith("env:"):
        res, _, attr = whole.group(1).partition(".")
        if res in raw and attr and attr != "name" and attr in raw[res] and not isinstance(raw[res][attr], str):
            return raw[res][attr]
    return REF.sub(sub, value)


def load(path: Path) -> Stack:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict) or "resources" not in doc:
        raise TemplateError("a template needs a top-level 'resources' map")
    raw: dict[str, dict] = doc["resources"]
    stack = Stack(name=doc.get("stack", path.stem), region=doc.get("region", "local-1"))

    errors: list[str] = []
    for name, spec in raw.items():
        kind = spec.get("type")
        if kind not in SCHEMA:
            errors.append(f"{name}: unknown type {kind!r}")
            continue
        props = {k: v for k, v in spec.items() if k != "type"}
        missing = SCHEMA[kind]["required"] - props.keys()
        extra = props.keys() - SCHEMA[kind]["required"] - SCHEMA[kind]["optional"]
        if missing:
            errors.append(f"{name}: missing {', '.join(sorted(missing))}")
        if extra:
            errors.append(f"{name}: unknown {', '.join(sorted(extra))}")
        try:
            stack.resources[name] = Resource(name, kind, _resolve(props, raw))
        except TemplateError as e:
            errors.append(f"{name}: {e}")

    # Cross-resource checks, the way a deployment would reject them.
    bucket_names = {r.props["name"] for r in stack.of_type("bucket")}
    functions = {r.name for r in stack.of_type("function")}
    queues = {r.name for r in stack.of_type("queue")}
    for r in stack.of_type("trigger"):
        if r.props["source"] not in bucket_names:
            errors.append(f"{r.name}: source {r.props['source']!r} is not a bucket in this stack")
        if r.props["target"] not in functions:
            errors.append(f"{r.name}: target {r.props['target']!r} is not a function in this stack")
    for r in stack.of_type("schedule"):
        if r.props["target"] not in functions:
            errors.append(f"{r.name}: target {r.props['target']!r} is not a function in this stack")
        if not RATE.match(r.props["expression"]):
            errors.append(f"{r.name}: expression must look like 'rate(15 minutes)'")
    for r in stack.of_type("function"):
        dlq = r.props.get("dead_letter")
        if dlq and dlq not in queues:
            errors.append(f"{r.name}: dead_letter {dlq!r} is not a queue in this stack")
        if not 1 <= int(r.props.get("timeout", 3)) <= 900:
            errors.append(f"{r.name}: timeout must be 1-900 seconds")
        if not 128 <= int(r.props.get("memory", 128)) <= 10240:
            errors.append(f"{r.name}: memory must be 128-10240 MB")
    if errors:
        raise TemplateError("invalid template:\n  " + "\n  ".join(errors))
    return stack


def rate_minutes(expression: str) -> int:
    n, unit = RATE.match(expression).groups()
    return int(n) * (60 if unit.startswith("hour") else 1)
