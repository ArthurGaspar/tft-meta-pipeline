"""Validate: raw match files -> staged files, with bad records quarantined.

Triggered by every new object under raw/ in the raw bucket. Each line must be a
complete 8-player match from this set with known champions, items and augments;
a line that isn't goes to the quarantine bucket with the reason. A file that
isn't text at all raises, so the platform retries it and finally dead-letters it:
that needs a human, not a filter.
"""

import json
import os

from functions.common import object_from_event, patch_name, patch_of, static_data
from minicloud import sdk


def problems(match: dict, data: dict) -> list[str]:
    try:
        info = match["info"]
        match_id = match["metadata"]["match_id"]
        participants = info["participants"]
    except (KeyError, TypeError):
        return ["missing_field"]
    out = []
    if not isinstance(match_id, str) or not match_id:
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
    elif sorted(placements) != list(range(1, len(participants) + 1)):
        out.append("invalid_placements")
    for p in participants:
        if any(u.get("character_id") not in data["champions"] for u in p.get("units", [])):
            out.append("unknown_champion")
        if any(i not in data["items"] for u in p.get("units", []) for i in u.get("itemNames", [])):
            out.append("unknown_item")
        if any(a not in data["augments"] for a in p.get("augments", [])):
            out.append("unknown_augment")
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
        match_id = (match.get("metadata") or {}).get("match_id")
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
