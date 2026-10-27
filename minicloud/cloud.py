"""The minicloud control plane: deploys a stack and moves events between services.

- deploy() creates buckets and queues, applies the database schema, registers
  functions and wires triggers. It records the result in state.json, like a
  CloudFormation stack.
- Bucket writes produce S3-style events. Triggers whose bucket, event name,
  prefix and suffix match queue an asynchronous invocation of their function.
- drain() works through the queue. A failed asynchronous invocation is retried
  twice by default (as Lambda does); after the last failure the event goes to
  the function's dead-letter queue.
- tick() advances a simulated clock and fires `rate(...)` schedules with an
  EventBridge-style scheduled event.
"""

import json
import urllib.parse
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import pricing, sdk
from .functions import FunctionSpec, Invocation, Runtime
from .storage import ObjectStore
from .template import Stack, rate_minutes


@dataclass
class Pending:
    function: str
    event: dict
    attempt: int = 0


class Cloud:
    def __init__(self, root: Path, stack: Stack):
        self.root = root
        self.stack = stack
        self.store = ObjectStore(root / "s3", stack.region, on_event=self._route)
        self.queue: deque[Pending] = deque()
        self.runtimes: dict[str, Runtime] = {}
        self.invocations: list[Invocation] = []
        self.dead_letters: list[dict] = []
        self.clock = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self._last_fired: dict[str, datetime] = {}
        sdk.bind(self)

    # ---- deployment -------------------------------------------------------------------------

    def deploy(self, db_connect=None) -> dict:
        """Creates every resource; `db_connect` returns a DB-API connection for database resources."""
        state = {"stack": self.stack.name, "region": self.stack.region, "deployedAt": _now(), "resources": {}}
        for r in self.stack.resources.values():
            physical = r.name
            if r.type == "bucket":
                self.store.create_bucket(r.props["name"])
                physical = f"arn:minicloud:s3:::{r.props['name']}"
            elif r.type == "queue":
                (self.root / "queues" / r.props["name"]).mkdir(parents=True, exist_ok=True)
                physical = f"arn:minicloud:sqs:{self.stack.region}:000000000000:{r.props['name']}"
            elif r.type == "database":
                if db_connect is None:
                    raise RuntimeError(f"{r.name}: deploying a database needs a db_connect function")
                self._apply_schema(r.props, db_connect)
                physical = f"{r.props['engine']}://{r.props['host']}:{r.props['port']}/{r.props['name']}"
            elif r.type == "function":
                spec = FunctionSpec(
                    name=r.name,
                    handler=r.props["handler"],
                    timeout=int(r.props.get("timeout", 3)),
                    memory=int(r.props.get("memory", 128)),
                    environment={k: str(v) for k, v in (r.props.get("environment") or {}).items()},
                    retries=int(r.props.get("retries", 2)),
                    dead_letter=r.props.get("dead_letter"),
                )
                self.runtimes[r.name] = Runtime(spec, self.stack.region, self.root / "logs")
                physical = f"arn:minicloud:lambda:{self.stack.region}:000000000000:function:{r.name}"
            state["resources"][r.name] = {"type": r.type, "physicalId": physical, "status": "CREATE_COMPLETE"}
        (self.root / "state.json").write_text(json.dumps(state, indent=1), encoding="utf-8")
        return state

    def _apply_schema(self, props: dict, db_connect) -> None:
        if not props.get("schema"):
            return
        statements = [s.strip() for s in Path(props["schema"]).read_text(encoding="utf-8").split(";") if s.strip()]
        conn = db_connect()
        try:
            with conn.cursor() as cur:
                for s in statements:
                    cur.execute(s)
            conn.commit()
        finally:
            conn.close()

    # ---- events -----------------------------------------------------------------------------

    def _route(self, event: dict) -> None:
        for record in event.get("Records", []):
            bucket = record["s3"]["bucket"]["name"]
            key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
            name = record["eventName"]
            for t in self.stack.of_type("trigger"):
                p = t.props
                events = p.get("events") or ["ObjectCreated:*"]
                if (
                    p["source"] == bucket
                    and key.startswith(p.get("prefix", ""))
                    and key.endswith(p.get("suffix", ""))
                    and any(name == e or (e.endswith(":*") and name.startswith(e[:-1])) for e in events)
                ):
                    self.queue.append(Pending(p["target"], {"Records": [record]}))

    def tick(self, minutes: int) -> None:
        """Advances the clock and queues every schedule that comes due."""
        end = self.clock + timedelta(minutes=minutes)
        for s in self.stack.of_type("schedule"):
            every = timedelta(minutes=rate_minutes(s.props["expression"]))
            last = self._last_fired.get(s.name, self.clock)
            while last + every <= end:
                last += every
                self.queue.append(Pending(s.props["target"], _scheduled_event(self.stack.region, s.name, last)))
            self._last_fired[s.name] = last
        self.clock = end

    def drain(self, max_invocations: int = 10_000) -> None:
        """Delivers queued events until none are left, with retries and dead-lettering."""
        for _ in range(max_invocations):
            if not self.queue:
                return
            item = self.queue.popleft()
            runtime = self.runtimes[item.function]
            inv = runtime.invoke(item.event)
            self.invocations.append(inv)
            if inv.ok:
                continue
            if item.attempt < runtime.spec.retries:
                self.queue.append(Pending(item.function, item.event, item.attempt + 1))
            else:
                self._dead_letter(runtime, item, inv)
        raise RuntimeError("drain() stopped after max_invocations; is a function re-triggering itself?")

    def _dead_letter(self, runtime: Runtime, item: Pending, inv: Invocation) -> None:
        message = {
            "messageId": str(uuid.uuid4()),
            "function": item.function,
            "attempts": item.attempt + 1,
            "lastRequestId": inv.request_id,
            "error": inv.error,
            "event": item.event,
        }
        self.dead_letters.append(message)
        queue = next((q for q in self.stack.of_type("queue") if q.name == runtime.spec.dead_letter), None)
        if queue:
            path = self.root / "queues" / queue.props["name"] / f"{message['messageId']}.json"
            path.write_text(json.dumps(message, indent=1), encoding="utf-8")

    def invoke(self, function: str, event: dict) -> Invocation:
        """A synchronous invocation (RequestResponse): no retries, the caller sees the error."""
        inv = self.runtimes[function].invoke(event)
        self.invocations.append(inv)
        return inv

    # ---- reporting --------------------------------------------------------------------------

    def report(self) -> dict:
        per_fn: dict[str, dict] = {}
        for inv in self.invocations:
            f = per_fn.setdefault(
                inv.function, {"invocations": 0, "errors": 0, "coldStarts": 0, "durationMs": 0.0, "billedMs": 0, "gbSeconds": 0.0}
            )
            f["invocations"] += 1
            f["errors"] += 0 if inv.ok else 1
            f["coldStarts"] += 1 if inv.init_ms is not None else 0
            f["durationMs"] = round(f["durationMs"] + inv.duration_ms, 2)
            f["billedMs"] += inv.billed_ms
            f["gbSeconds"] = round(f["gbSeconds"] + inv.billed_ms / 1000 * inv.memory_mb / 1024, 4)
        return {
            "functions": per_fn,
            "deadLetters": [{k: m[k] for k in ("function", "attempts", "error")} for m in self.dead_letters],
            "s3": {"requests": dict(self.store.requests), "bytesStored": self.store.total_bytes()},
            "cost": pricing.estimate(per_fn, self.store.requests, self.store.total_bytes()),
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _scheduled_event(region: str, rule: str, at: datetime) -> dict:
    return {
        "version": "0",
        "id": str(uuid.uuid4()),
        "detail-type": "Scheduled Event",
        "source": "minicloud.events",
        "account": "000000000000",
        "time": at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "region": region,
        "resources": [f"arn:minicloud:events:{region}:000000000000:rule/{rule}"],
        "detail": {},
    }
