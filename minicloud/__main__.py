"""Inspect a deployed minicloud, the way you would use the AWS console or CLI.

    python -m minicloud status                 stack resources and their state
    python -m minicloud ls tft-quarantine      objects in a bucket (optionally a prefix)
    python -m minicloud logs Load              the latest log stream of a function
    python -m minicloud dlq                    messages in the dead-letter queues
    python -m minicloud validate infra/stack.yaml
"""

import json
import sys
from pathlib import Path

from .storage import ObjectStore
from .template import TemplateError, load

ROOT = Path(".cloud")


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 0
    cmd, *args = argv
    if cmd == "validate":
        try:
            stack = load(Path(args[0] if args else "infra/stack.yaml"))
        except TemplateError as e:
            print(e)
            return 1
        print(f"{stack.name}: {len(stack.resources)} resources, template is valid")
        return 0
    state_file = ROOT / "state.json"
    if not state_file.exists():
        print("Nothing deployed here yet; run `python run.py` first.")
        return 1
    state = json.loads(state_file.read_text(encoding="utf-8"))
    if cmd == "status":
        print(f"stack {state['stack']} ({state['region']}), deployed {state['deployedAt']}")
        for name, r in state["resources"].items():
            print(f"  {name:18s} {r['type']:9s} {r['status']:16s} {r['physicalId']}")
    elif cmd == "ls":
        store = ObjectStore(ROOT / "s3", state["region"])
        bucket, prefix = args[0], (args[1] if len(args) > 1 else "")
        for o in store.list_objects(bucket, prefix):
            print(f"{o.last_modified}  {o.size:>10,}  {o.key}")
    elif cmd == "logs":
        streams = sorted((ROOT / "logs" / args[0]).rglob("*.log"), key=lambda p: p.stat().st_mtime)
        if not streams:
            print(f"no logs for {args[0]}")
            return 1
        print(streams[-1].read_text(encoding="utf-8"))
    elif cmd == "dlq":
        for msg in sorted((ROOT / "queues").rglob("*.json")):
            m = json.loads(msg.read_text(encoding="utf-8"))
            key = m["event"].get("Records", [{}])[0].get("s3", {}).get("object", {}).get("key")
            print(f"{msg.parent.name}: {m['function']} failed {m['attempts']}x on {key}: {m['error']}")
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
