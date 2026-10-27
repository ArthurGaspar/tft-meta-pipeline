"""One end-to-end run of the TFT meta pipeline on minicloud.

    python run.py                    # 3,000 simulated matches into a fresh stack
    python run.py --matches 600      # a quicker run

1. Deploys infra/stack.yaml (buckets, queue, database schema, functions, triggers).
2. Simulates matches and uploads the raw files to the raw bucket. Each upload
   fires an S3-style event: Validate stages or quarantines the records, and each
   staged file fires Load, which writes MySQL.
3. Advances the simulated clock by an hour, so the hourly Aggregate runs and
   publishes the tier lists to the public bucket.
4. Copies the published files to web/public/data and adds two reports the
   website shows: the pipeline run itself, and a truth check that compares the
   tier lists with the simulator's hidden values (which the ETL never sees).
"""

import argparse
import json
import shutil
import time
from pathlib import Path

import pymysql

from minicloud.cloud import Cloud
from minicloud.template import load
from simulator.simulate import simulate

ROOT = Path(__file__).resolve().parent
TABLES = ["entity_stats", "load_log", "participant_augments", "participant_traits", "unit_items", "participant_units", "participants", "matches"]


def db_connector(props: dict):
    def connect():
        return pymysql.connect(
            host=props["host"], port=int(props["port"]), user=props["user"], password=props.get("password", ""),
            database=props["name"], charset="utf8mb4",
        )

    return connect


def spearman(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3:
        return None

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        for k, i in enumerate(order):
            r[i] = k
        return r

    rx, ry = ranks(xs), ranks(ys)
    return round(1 - 6 * sum((a - b) ** 2 for a, b in zip(rx, ry)) / (n * (n * n - 1)), 3)


def truth_check(tierlists: dict, changes: list, truth: dict) -> dict:
    """How well the published tier lists recover the simulator's hidden meta."""
    out: dict = {"patches": {}, "changes": {}}
    for patch, lists in tierlists.items():
        hidden = truth["patches"].get(patch)
        if not hidden:
            continue
        out["patches"][patch] = {}
        for kind in ("champion", "item", "augment"):
            rows = [r for r in lists[kind] if r["tier"] is not None and r["id"] in hidden[kind]]
            out["patches"][patch][kind] = {
                "entities": len(rows),
                # Higher hidden power should mean a lower (better) score.
                "spearman": spearman([hidden[kind][r["id"]] for r in rows], [-r["score"] for r in rows]),
                "points": [{"id": r["id"], "name": r["name"], "power": round(hidden[kind][r["id"]], 3), "score": r["score"], "tier": r["tier"]} for r in rows],
            }
    for patch, change in truth["changes"].items():
        flagged = {(c["kind"], c["id"]) for c in changes if c["to"] == patch and c["significant"]}
        actual = {(k, i) for k, ids in change.items() for i in ids}
        right_direction = sum(
            1 for c in changes if c["to"] == patch and c["significant"] and (c["kind"], c["id"]) in actual
            and (change[c["kind"]][c["id"]] > 0) == (c["delta"] < 0)
        )
        out["changes"][patch] = {
            "trueChanges": len(actual),
            "flagged": len(flagged),
            "flaggedAndReal": len(flagged & actual),
            "rightDirection": right_direction,
            "missed": sorted(f"{k}:{i}" for k, i in actual - flagged),
        }
    return out


def quality_report(cloud: Cloud, bucket: str) -> dict:
    reasons: dict[str, int] = {}
    records = 0
    for obj in cloud.store.list_objects(bucket):
        for line in cloud.store.get_object(bucket, obj.key).decode("utf-8").splitlines():
            rec = json.loads(line)
            records += 1
            for r in rec["reasons"]:
                reasons[r] = reasons.get(r, 0) + 1
    return {"quarantined": records, "reasons": dict(sorted(reasons.items(), key=lambda kv: -kv[1]))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--matches", type=int, default=3000)
    parser.add_argument("--seed", type=int, default=18)
    parser.add_argument("--out", default="web/public/data")
    args = parser.parse_args()
    started = time.perf_counter()

    stack = load(ROOT / "infra" / "stack.yaml")
    db = db_connector(stack.resources["MetaDb"].props)
    cloud_root = ROOT / ".cloud"
    shutil.rmtree(cloud_root, ignore_errors=True)
    conn = db()
    with conn.cursor() as cur:  # a run starts from an empty database
        for t in TABLES:
            cur.execute(f"DROP TABLE IF EXISTS {t}")
    conn.commit()
    conn.close()

    cloud = Cloud(cloud_root, stack)
    state = cloud.deploy(db_connect=db)
    print(f"deployed {len(state['resources'])} resources")

    work = ROOT / ".work"
    shutil.rmtree(work, ignore_errors=True)
    files = simulate(json.loads((ROOT / "data" / "set18.json").read_text(encoding="utf-8")), work, matches=args.matches, seed=args.seed)
    print(f"simulated {args.matches} matches into {len(files)} files")

    raw = stack.resources["RawBucket"].props["name"]
    for f in files:
        cloud.store.put_object(raw, f.relative_to(work).as_posix(), f.read_bytes())
    cloud.drain()
    cloud.tick(minutes=60)
    cloud.drain()

    out = ROOT / args.out
    out.mkdir(parents=True, exist_ok=True)
    public = stack.resources["PublicBucket"].props["name"]
    for obj in cloud.store.list_objects(public, "site/"):
        (out / obj.key.removeprefix("site/")).write_bytes(cloud.store.get_object(public, obj.key))

    report = cloud.report()
    report["stack"] = state
    report["quality"] = quality_report(cloud, stack.resources["QuarantineBucket"].props["name"])
    report["rawFiles"] = len(files)
    report["wallSeconds"] = round(time.perf_counter() - started, 1)
    (out / "pipeline.json").write_text(json.dumps(report, indent=1), encoding="utf-8")

    truth = json.loads((work / "truth.json").read_text(encoding="utf-8"))
    check = truth_check(json.loads((out / "tierlists.json").read_text(encoding="utf-8")), json.loads((out / "patch-changes.json").read_text(encoding="utf-8")), truth)
    (out / "truth-check.json").write_text(json.dumps(check, indent=1), encoding="utf-8")

    fns = report["functions"]
    print(
        f"done in {report['wallSeconds']} s: "
        + ", ".join(f"{name} {f['invocations']} calls/{f['errors']} errors" for name, f in fns.items())
        + f"; {report['quality']['quarantined']} records quarantined, {len(report['deadLetters'])} dead-lettered"
    )
    for patch, kinds in check["patches"].items():
        print(f"  {patch}: " + ", ".join(f"{k} spearman {v['spearman']}" for k, v in kinds.items()))


if __name__ == "__main__":
    main()
