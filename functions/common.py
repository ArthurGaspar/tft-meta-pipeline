"""Helpers shared by the ETL functions (packaged with each, like a Lambda layer)."""

import json
import os
import re
import urllib.parse
from functools import lru_cache
from pathlib import Path

VERSION = re.compile(r"^Version (\d+\.\d+)\.")


@lru_cache(maxsize=1)
def static_data() -> dict:
    """The set's champions, traits, items and augments, keyed by id. Loaded once per warm environment."""
    raw = json.loads(Path(os.environ["STATIC_DATA"]).read_text(encoding="utf-8"))
    return {
        "set": raw["set"],
        "champions": {c["id"]: c for c in raw["champions"]},
        "traits": {t["id"]: t for t in raw["traits"]},
        "items": {i["id"]: i for i in raw["items"]},
        "augments": {a["id"]: a for a in raw["augments"]},
    }


def object_from_event(event: dict) -> tuple[str, str]:
    record = event["Records"][0]["s3"]
    return record["bucket"]["name"], urllib.parse.unquote_plus(record["object"]["key"])


def patch_of(game_version: str) -> str | None:
    m = VERSION.match(game_version or "")
    return m.group(1) if m else None


def comp_of(participant: dict) -> tuple[str, str]:
    """A board's comp, named the way players name them: its strongest active trait plus its
    carry (the unit holding the most items), e.g. "Inferno Akali".

    Returns (comp_key, carry_id). Ties prefer higher trait tiers, more units, then
    the costlier and higher-star carry, so the label is stable for the same board.
    """
    active = sorted(
        (t for t in participant["traits"] if t["tier_current"] > 0),
        key=lambda t: (-t["tier_current"], -t["num_units"], t["name"]),
    )
    units = participant["units"]
    carry = max(units, key=lambda u: (len(u["itemNames"]), u["rarity"], u["tier"], u["character_id"]))
    trait = active[0]["name"] if active else "none"
    return f"{trait}|{carry['character_id']}", carry["character_id"]
