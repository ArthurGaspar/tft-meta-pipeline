"""Load: staged match files -> normalized MySQL tables.

Triggered by every new object in the staged bucket. One file is one transaction.
Loading is idempotent at two levels: a file already in load_log (same key and
ETag) is skipped, and a match already in the database (re-delivered in another
file) is not inserted twice. The transform step happens here too: each board is
labeled with its comp, carry and playstyle, and each unit with how many other
boards in the lobby were competing for the same champion's copies.
"""

import json
from datetime import datetime, timezone

from functions.common import champion_base, comp_of, holders_in_lobby, object_from_event, patch_of, playstyle_of, static_data
from minicloud import sdk


def rows_for(match: dict, key: str, data: dict) -> dict[str, list[tuple]]:
    info = match["info"]
    mid = match["metadata"]["match_id"]
    out: dict[str, list[tuple]] = {k: [] for k in ("matches", "participants", "units", "items", "traits", "augments")}
    out["matches"].append(
        (mid, patch_of(info["game_version"]), datetime.fromtimestamp(info["game_datetime"] / 1000, timezone.utc).replace(tzinfo=None), info["game_length"], key)
    )
    holders = holders_in_lobby(info["participants"], data["champions"])
    for p in info["participants"]:
        comp_key, carry = comp_of(p)
        out["participants"].append(
            (mid, p["puuid"], p["placement"], p["level"], p["gold_left"], p["last_round"], p["total_damage_to_players"], comp_key, carry,
             playstyle_of(p), holders[champion_base(carry, data["champions"])] - 1)
        )
        for slot, u in enumerate(p["units"]):
            contested = holders[champion_base(u["character_id"], data["champions"])] - 1
            out["units"].append((mid, p["puuid"], slot, u["character_id"], u["tier"], data["champions"][u["character_id"]]["cost"], contested))
            for item_slot, item in enumerate(u["itemNames"]):
                out["items"].append((mid, p["puuid"], slot, item_slot, item))
        for t in p["traits"]:
            out["traits"].append((mid, p["puuid"], t["name"], t["num_units"], t["tier_current"]))
        for order, a in enumerate(p["augments"]):
            out["augments"].append((mid, p["puuid"], order, a))
    return out


INSERTS = {
    "matches": "INSERT IGNORE INTO matches (match_id, patch, game_datetime, game_length_s, source_key) VALUES (%s, %s, %s, %s, %s)",
    "participants": "INSERT IGNORE INTO participants (match_id, puuid, placement, level, gold_left, last_round, damage, comp_key, carry_id, playstyle, carry_contest)"
    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
    "units": "INSERT IGNORE INTO participant_units (match_id, puuid, slot, champion_id, star, cost, contested) VALUES (%s, %s, %s, %s, %s, %s, %s)",
    "items": "INSERT IGNORE INTO unit_items (match_id, puuid, slot, item_slot, item_id) VALUES (%s, %s, %s, %s, %s)",
    "traits": "INSERT IGNORE INTO participant_traits (match_id, puuid, trait_id, num_units, tier) VALUES (%s, %s, %s, %s, %s)",
    "augments": "INSERT IGNORE INTO participant_augments (match_id, puuid, pick_order, augment_id) VALUES (%s, %s, %s, %s)",
}


def handler(event, context):
    bucket, key = object_from_event(event)
    etag = event["Records"][0]["s3"]["object"]["eTag"]
    body = sdk.client("s3").get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8")
    matches = [json.loads(line) for line in body.splitlines() if line.strip()]
    data = static_data()

    conn = sdk.db_connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM load_log WHERE source_key = %s AND etag = %s", (key, etag))
            if cur.fetchone():
                print(json.dumps({"source": key, "skipped": "already loaded"}))
                return {"loaded": 0, "skipped": True}
            ids = [m["metadata"]["match_id"] for m in matches]
            existing: set[str] = set()
            for i in range(0, len(ids), 500):
                chunk = ids[i : i + 500]
                cur.execute(f"SELECT match_id FROM matches WHERE match_id IN ({', '.join(['%s'] * len(chunk))})", chunk)
                existing.update(r[0] for r in cur.fetchall())
            fresh = [m for m in matches if m["metadata"]["match_id"] not in existing]

            rows: dict[str, list[tuple]] = {k: [] for k in INSERTS}
            for m in fresh:
                for table, r in rows_for(m, key, data).items():
                    rows[table].extend(r)
            for table in INSERTS:  # parents before children, for the foreign keys
                if rows[table]:
                    cur.executemany(INSERTS[table], rows[table])
            cur.execute(
                "INSERT INTO load_log (source_key, etag, matches, loaded_at) VALUES (%s, %s, %s, %s)",
                (key, etag, len(fresh), datetime.now(timezone.utc).replace(tzinfo=None)),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(json.dumps({"source": key, "loaded": len(fresh), "duplicates": len(matches) - len(fresh)}))
    return {"loaded": len(fresh), "duplicates": len(matches) - len(fresh)}
