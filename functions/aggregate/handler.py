"""Aggregate: MySQL -> stats, tier lists and patch changes, published as JSON.

Runs on a schedule. For every champion, item, augment, trait breakpoint and comp
it computes games, play rate, average placement, top-4 rate and win rate per
patch, then:

- score: average placement shrunk towards the lobby average (4.5) by PRIOR_GAMES
  pseudo-games, so a 12-game wonder can't top the list;
- tier: how many standard deviations the score sits from 4.5, measured within
  its own kind (champions against champions, comps against comps), only with
  at least MIN_GAMES games;
- patch changes: the shift in average placement between consecutive patches,
  flagged when it is unlikely to be noise (|z| >= Z_SIGNIFICANT; strict, because
  around a hundred entities are compared at once).
"""

import json
import math
import os
from datetime import datetime, timezone

from functions.common import static_data
from minicloud import sdk

PRIOR_GAMES = 50
MIN_GAMES = 40
Z_SIGNIFICANT = 3.0
# Upper bounds on (score - 4.5) / sd within the kind; anything above the last is D.
TIERS = [("S", -1.2), ("A", -0.4), ("B", 0.4), ("C", 1.2)]
BUILD_MIN_GAMES = 25

# One query per kind: the distinct (board, entity) pairs joined to the board's placement.
ENTITY_SQL = {
    "champion": "SELECT DISTINCT match_id, puuid, champion_id AS entity_id FROM participant_units",
    "item": "SELECT DISTINCT match_id, puuid, item_id AS entity_id FROM unit_items",
    "augment": "SELECT DISTINCT match_id, puuid, augment_id AS entity_id FROM participant_augments",
    "trait": "SELECT match_id, puuid, CONCAT(trait_id, ':', tier) AS entity_id FROM participant_traits WHERE tier > 0",
    "comp": "SELECT match_id, puuid, comp_key AS entity_id FROM participants",
}

STATS_SQL = """
SELECT m.patch, e.entity_id, COUNT(*) AS games, AVG(p.placement) AS avg_place,
       AVG(p.placement * p.placement) AS avg_sq, AVG(p.placement <= 4) AS top4, AVG(p.placement = 1) AS win
FROM ({entities}) e
JOIN participants p ON p.match_id = e.match_id AND p.puuid = e.puuid
JOIN matches m ON m.match_id = e.match_id
GROUP BY m.patch, e.entity_id
"""

BUILD_SQL = """
SELECT u.champion_id, i.item_id, COUNT(*) AS games, AVG(p.placement) AS avg_place
FROM (SELECT DISTINCT match_id, puuid, slot, item_id FROM unit_items) i
JOIN participant_units u ON u.match_id = i.match_id AND u.puuid = i.puuid AND u.slot = i.slot
JOIN participants p ON p.match_id = i.match_id AND p.puuid = i.puuid
GROUP BY u.champion_id, i.item_id
"""


def shrink(avg: float, n: int) -> float:
    return (avg * n + 4.5 * PRIOR_GAMES) / (n + PRIOR_GAMES)


def tier_of(score: float, n: int, sd: float) -> str | None:
    if n < MIN_GAMES or sd <= 0:
        return None
    z = (score - 4.5) / sd
    return next((t for t, bound in TIERS if z <= bound), "D")


def assign_tiers(stats: list[dict]) -> None:
    """Fills each entry's tier, using the spread of its own kind and patch."""
    groups: dict[tuple[str, str], list[dict]] = {}
    for s in stats:
        groups.setdefault((s["kind"], s["patch"]), []).append(s)
    for rows in groups.values():
        ranked = [r["score"] - 4.5 for r in rows if r["games"] >= MIN_GAMES]
        sd = math.sqrt(sum(d * d for d in ranked) / len(ranked)) if len(ranked) > 1 else 0.0
        for r in rows:
            r["tier"] = tier_of(r["score"], r["games"], sd)


def describe(kind: str, entity_id: str, data: dict) -> dict:
    """Display name and icon for the dashboard."""
    if kind == "trait":
        tid, tier = entity_id.rsplit(":", 1)
        t = data["traits"].get(tid, {})
        bps = t.get("breakpoints", [])
        units = bps[int(tier) - 1] if 0 < int(tier) <= len(bps) else "?"
        return {"name": f"{t.get('name', tid)} ({units})", "icon": t.get("icon")}
    if kind == "comp":
        trait, carry = entity_id.split("|")
        c = data["champions"].get(carry, {})
        return {"name": f"{data['traits'].get(trait, {}).get('name', trait)} {c.get('name', carry)}", "icon": c.get("icon"), "carry": c.get("name")}
    pool = {"champion": data["champions"], "item": data["items"], "augment": data["augments"]}[kind]
    e = pool.get(entity_id, {})
    out = {"name": e.get("name", entity_id), "icon": e.get("icon")}
    if kind == "champion":
        out["cost"] = e.get("cost")
    return out


def handler(event, context):
    data = static_data()
    conn = sdk.db_connect()
    stats: list[dict] = []
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT m.patch, COUNT(*) FROM participants p JOIN matches m ON m.match_id = p.match_id GROUP BY m.patch")
            boards = {patch: n for patch, n in cur.fetchall()}
            cur.execute("SELECT COUNT(*) FROM matches")
            total_matches = cur.fetchone()[0]
            for kind, entities in ENTITY_SQL.items():
                cur.execute(STATS_SQL.format(entities=entities))
                for patch, eid, games, avg, avg_sq, top4, win in cur.fetchall():
                    avg, avg_sq = float(avg), float(avg_sq)
                    score = shrink(avg, games)
                    stats.append(
                        {
                            "kind": kind,
                            "id": eid,
                            "patch": patch,
                            "games": games,
                            "playRate": round(games / boards[patch], 4),
                            "avgPlacement": round(avg, 3),
                            "variance": max(0.0, avg_sq - avg * avg),
                            "top4Rate": round(float(top4), 4),
                            "winRate": round(float(win), 4),
                            "score": round(score, 3),
                            "tier": None,
                        }
                    )
            assign_tiers(stats)
            cur.execute("DELETE FROM entity_stats")
            cur.executemany(
                "INSERT INTO entity_stats (kind, entity_id, patch, games, play_rate, avg_placement, top4_rate, win_rate, score, tier)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    (s["kind"], s["id"], s["patch"], s["games"], s["playRate"], s["avgPlacement"], s["top4Rate"], s["winRate"], s["score"], s["tier"])
                    for s in stats
                ],
            )
            cur.execute(BUILD_SQL)
            builds_raw = cur.fetchall()
        conn.commit()
    finally:
        conn.close()

    patches = sorted(boards)
    tierlists: dict[str, dict[str, list]] = {p: {k: [] for k in ENTITY_SQL} for p in patches}
    for s in stats:
        entry = {k: v for k, v in s.items() if k not in ("kind", "patch", "variance")}
        entry.update(describe(s["kind"], s["id"], data))
        tierlists[s["patch"]][s["kind"]].append(entry)
    for lists in tierlists.values():
        for kind, rows in lists.items():
            rows.sort(key=lambda r: (r["tier"] is None, r["score"]))

    changes = []
    by_key = {(s["kind"], s["id"], s["patch"]): s for s in stats}
    for before, after in zip(patches, patches[1:]):
        for (kind, eid, patch), b in by_key.items():
            a = by_key.get((kind, eid, after))
            if patch != before or a is None or kind not in ("champion", "item", "trait"):
                continue
            if min(a["games"], b["games"]) < MIN_GAMES:
                continue
            delta = a["avgPlacement"] - b["avgPlacement"]
            se = math.sqrt(a["variance"] / a["games"] + b["variance"] / b["games"]) or 1e-9
            z = delta / se
            changes.append(
                {
                    "kind": kind,
                    "id": eid,
                    "from": before,
                    "to": after,
                    **describe(kind, eid, data),
                    "before": b["avgPlacement"],
                    "after": a["avgPlacement"],
                    "delta": round(delta, 3),
                    "z": round(z, 2),
                    "significant": abs(z) >= Z_SIGNIFICANT,
                }
            )
    changes.sort(key=lambda c: c["z"])

    builds: dict[str, list] = {}
    for champion, item, games, avg in builds_raw:
        if games >= BUILD_MIN_GAMES:
            builds.setdefault(champion, []).append(
                {"id": item, "name": data["items"].get(item, {}).get("name", item), "icon": data["items"].get(item, {}).get("icon"),
                 "games": games, "avgPlacement": round(float(avg), 3), "score": round(shrink(float(avg), games), 3)}
            )
    for rows in builds.values():
        rows.sort(key=lambda r: r["score"])
        del rows[3:]

    meta = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "set": data["set"],
        "patches": patches,
        "matches": total_matches,
        "boards": boards,
        "method": {"priorGames": PRIOR_GAMES, "minGames": MIN_GAMES, "tiers": TIERS, "zSignificant": Z_SIGNIFICANT},
    }
    s3 = sdk.client("s3")
    bucket = os.environ["PUBLIC_BUCKET"]
    for name, body in [("meta.json", meta), ("tierlists.json", tierlists), ("patch-changes.json", changes), ("builds.json", builds)]:
        s3.put_object(Bucket=bucket, Key=f"site/{name}", Body=json.dumps(body, ensure_ascii=False, separators=(",", ":")), ContentType="application/json")
    print(json.dumps({"entities": len(stats), "patches": patches, "changes": sum(c["significant"] for c in changes)}))
    return {"entities": len(stats), "significantChanges": sum(c["significant"] for c in changes)}
