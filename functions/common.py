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
        "patches": raw.get("patches", {}),  # client version -> patch, e.g. "16.21" -> "18.5"
    }


def object_from_event(event: dict) -> tuple[str, str]:
    record = event["Records"][0]["s3"]
    return record["bucket"]["name"], urllib.parse.unquote_plus(record["object"]["key"])


def patch_of(game_version: str) -> str | None:
    """"Version 16.21.512.4471 (...)" -> "16.21": the game client version a match was played on."""
    m = VERSION.match(game_version or "")
    return m.group(1) if m else None


def patch_name(game_version: str, data: dict) -> str | None:
    """The patch players know a match by: client 16.21 is Set 18's patch 18.5.

    Riot's match data only has the client version; the static data maps it to the
    set's patch. None when the version is unreadable or unknown (static data to refresh)."""
    client = patch_of(game_version)
    return data.get("patches", {}).get(client) if client else None


def patch_key(patch: str) -> tuple[int, ...]:
    """Orders patches numerically: 16.9 comes before 16.10."""
    return tuple(int(x) for x in patch.split("."))


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


PLAYSTYLES = {"reroll": "Reroll", "fast8": "Fast 8", "fast9": "Fast 9"}


def playstyle_of(participant: dict) -> str:
    """How the board was played, read from the board the way players read it: a 3-star
    1-3 cost below level 9 is a reroll comp, level 9 or more is fast 9, the rest fast 8.

    The match API doesn't record the plan, so a player knocked out before reaching it
    reads as what they had built by then.
    """
    if participant["level"] >= 9:
        return "fast9"
    if any(u["tier"] == 3 and u["rarity"] <= 2 for u in participant["units"]):
        return "reroll"
    return "fast8"


def champion_base(champion_id: str, champions: dict) -> str:
    """The pool a champion is drawn from: Set 18 Lux's ten forms share one ("Lux (Fae)" -> "Lux")."""
    return champions[champion_id]["name"].split(" (")[0]


def holders_in_lobby(participants: list[dict], champions: dict) -> dict[str, int]:
    """How many boards in the lobby hold each champion: they all draw copies from one shared pool."""
    out: dict[str, int] = {}
    for p in participants:
        for base in {champion_base(u["character_id"], champions) for u in p["units"]}:
            out[base] = out.get(base, 0) + 1
    return out
