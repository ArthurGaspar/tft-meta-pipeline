"""Stage valid match records; quarantine bad lines and raise on unreadable files."""

import json
import math
import os
from datetime import datetime, timezone

from functions.common import object_from_event, patch_name, patch_of, static_data
from minicloud import sdk


def _integer(value, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def _text(value, limit: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= limit


def _strings(value, limit: int) -> bool:
    return isinstance(value, list) and all(_text(v, limit) for v in value)


def _loadable(info: dict, participants: list) -> bool:
    """Check the fields Load consumes before a record can enter the staged bucket."""
    timestamp, duration = info.get("game_datetime"), info.get("game_length")
    if not all(type(v) is int or type(v) is float and math.isfinite(v) for v in (timestamp, duration)):
        return False
    if not 0 < duration <= 99999.99:
        return False
    try:
        if datetime.fromtimestamp(timestamp / 1000, timezone.utc).year < 1000:
            return False
    except (ValueError, OverflowError, OSError):
        return False
    for p in participants:
        if not isinstance(p, dict) or not _text(p.get("puuid"), 64):
            return False
        for field, low, high in (("level", 1, 10), ("gold_left", 0, 32767), ("last_round", 0, 127), ("total_damage_to_players", 0, 32767)):
            if not _integer(p.get(field), low, high):
                return False
        if not _strings(p.get("augments"), 96):
            return False
        units, traits = p.get("units"), p.get("traits")
        if not isinstance(units, list) or not 1 <= len(units) <= 127 or not isinstance(traits, list):
            return False
        for u in units:
            if not isinstance(u, dict) or not _text(u.get("character_id"), 64):
                return False
            if not _integer(u.get("tier"), 1, 3) or not _integer(u.get("rarity"), 0, 4):
                return False
            if not _strings(u.get("itemNames"), 64) or len(u["itemNames"]) > 3:
                return False
        for t in traits:
            if not isinstance(t, dict) or not _text(t.get("name"), 64):
                return False
            if not _integer(t.get("num_units"), 0, 127) or not _integer(t.get("tier_current"), 0, 127):
                return False
        if len({t["name"] for t in traits}) != len(traits):
            return False
    return True


def problems(match: object, data: dict) -> list[str]:
    if not isinstance(match, dict):
        return ["invalid_schema"]
    try:
        info = match["info"]
        match_id = match["metadata"]["match_id"]
        participants = info["participants"]
    except (KeyError, TypeError):
        return ["missing_field"]
    if not isinstance(info, dict) or not isinstance(participants, list):
        return ["invalid_schema"]
    if not _loadable(info, participants):
        return ["invalid_schema"]
    out = []
    if not _text(match_id, 32):
        out.append("missing_field")
    if info.get("tft_set_number") != data["set"]:
        out.append("wrong_set")
    if patch_of(info.get("game_version", "")) is None:
        out.append("unknown_version")
    elif patch_name(info["game_version"], data) is None:
        out.append("unknown_patch")  # a client version the static data doesn't know: refresh it
    if len(participants) != 8:
        out.append("wrong_lobby_size")
    placements = [p.get("placement") for p in participants]
    if None in placements:
        out.append("missing_placement")
    elif not all(_integer(p, 1, 8) for p in placements) or sorted(placements) != list(range(1, len(participants) + 1)):
        out.append("invalid_placements")
    if len({p["puuid"] for p in participants}) != len(participants):
        out.append("duplicate_player")
    for p in participants:
        if any(u.get("character_id") not in data["champions"] for u in p.get("units", [])):
            out.append("unknown_champion")
        if any(i not in data["items"] for u in p.get("units", []) for i in u.get("itemNames", [])):
            out.append("unknown_item")
        if any(a not in data["augments"] for a in p.get("augments", [])):
            out.append("unknown_augment")
        if any(t["name"] not in data["traits"] for t in p["traits"]):
            out.append("unknown_trait")
    return sorted(set(out))


def handler(event, context):
    bucket, key = object_from_event(event)
    s3 = sdk.client("s3")
    raw = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    text = raw.decode("utf-8")  # not text at all: let it fail, retry and dead-letter
    data = static_data()

    good: list[str] = []
    bad: list[str] = []
    seen: set[str] = set()
    for n, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            match = json.loads(line)
        except json.JSONDecodeError:
            bad.append(json.dumps({"source": key, "line": n, "reasons": ["malformed_json"], "raw": line[:200]}))
            continue
        reasons = problems(match, data)
        metadata = match.get("metadata") if isinstance(match, dict) else None
        match_id = metadata.get("match_id") if isinstance(metadata, dict) else None
        if not reasons and match_id in seen:
            reasons = ["duplicate_in_file"]
        if reasons:
            bad.append(json.dumps({"source": key, "line": n, "match_id": match_id, "reasons": reasons}))
            continue
        seen.add(match_id)
        good.append(line)

    staged_key = key.replace("raw/", "staged/", 1)
    if good:
        s3.put_object(Bucket=os.environ["STAGED_BUCKET"], Key=staged_key, Body="\n".join(good) + "\n")
    if bad:
        s3.put_object(Bucket=os.environ["QUARANTINE_BUCKET"], Key=key.replace("raw/", "quarantine/", 1), Body="\n".join(bad) + "\n")
    print(json.dumps({"source": key, "valid": len(good), "quarantined": len(bad)}))
    return {"valid": len(good), "quarantined": len(bad)}
