"""Extracts the game data the simulator needs from Community Dragon.

    python -m simulator.static_data            # writes data/set18.json

Community Dragon publishes Riot's static TFT data (no API key). The full file is
~24 MB and includes other sets and modes, so a compact snapshot of one set is
kept in the repository and this script refreshes it.
"""

import argparse
import hashlib
import json
import re
import urllib.request
from pathlib import Path

SOURCE = "https://raw.communitydragon.org/latest/cdragon/tft/en_us.json"
ASSETS = "https://raw.communitydragon.org/latest/game/"
ROOT = Path(__file__).resolve().parent.parent
AUGMENT_POOL = 72


def icon_url(path: str | None) -> str | None:
    if not path or not path.endswith(".tex"):
        return None
    return ASSETS + path.lower()[: -len(".tex")] + ".png"


# Item stats the browser simulator models, in Community Dragon's units: AD, StatOmnivamp and
# DamageAmp are fractions; AP, AS and CritChance percentage points; the rest flat.
ITEM_STATS = ("AD", "AP", "AS", "Armor", "MagicResist", "Health", "CritChance", "ManaRegen", "StatOmnivamp", "DamageAmp", "CombatStartMana")


def champion_stats(s: dict) -> dict:
    return {
        "hp": s["hp"], "ad": s["damage"], "as": round(s["attackSpeed"], 3), "armor": s["armor"], "mr": s["magicResist"],
        "range": int(s["range"]), "mana": s["mana"], "startMana": s["initialMana"],
        "crit": round(s["critChance"], 3), "critMult": round(s["critMultiplier"], 3),
    }


def fnv1a(name: str) -> str:
    """Riot hashes some variable names (FNV-1a over the lowercased name); Community Dragon prints the hash."""
    h = 0x811C9DC5
    for b in name.lower().encode():
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return "{%08x}" % h


def named(values: dict, desc: str | None) -> dict:
    """A {name: number} dict with hashed keys turned back into the names the description uses.
    Keys that can't be decoded are dropped: nothing could read them anyway."""
    known = {fnv1a(n): n for n in re.findall(r"@([A-Za-z0-9_]+)", desc or "")}
    out = {}
    for k, v in (values or {}).items():
        name = known.get(k, k) if k.startswith("{") else k
        if not name.startswith("{") and isinstance(v, (int, float)):
            out[name] = round(v, 4)
    return out


def clean(desc: str | None) -> str:
    """Tooltip text without markup or icon codes; @Variable@ placeholders are kept."""
    text = re.sub(r"<br\s*/?>|\\n|\n", "\n", desc or "")
    text = re.sub(r"<[^>]+>|%i:[A-Za-z0-9]+%|\{\{[^}]*\}\}|\{[A-Za-z.]+\}", "", text)
    return "\n".join(re.sub(r"\s+", " ", line).strip() for line in text.split("\n")).strip()


def spell(ability: dict) -> dict:
    """The ability's tooltip and whatever per-star values Riot ships ([0, 1-star, 2-star, 3-star, ...])."""
    variables = {v["name"]: [round(x, 4) for x in v["value"]] for v in ability.get("variables") or [] if v.get("value")}
    return {"name": ability.get("name"), "desc": clean(ability.get("desc")), "vars": variables}


def stable_sample(names: list[str], k: int) -> list[str]:
    """The same k names on every refresh, independent of list order."""
    return sorted(names, key=lambda n: hashlib.sha1(n.encode()).hexdigest())[:k]


def extract(raw: dict, mutator: str) -> dict:
    s = next(x for x in raw["setData"] if x["mutator"] == mutator)
    items = {i["apiName"]: i for i in raw["items"]}

    # Shop champions: costs 1-5 with traits (drops neutral monsters and summons).
    champions = [c for c in s["champions"] if 1 <= (c.get("cost") or 0) <= 5 and c.get("traits")]
    used_traits = {t for c in champions for t in c["traits"]}
    traits = [t for t in s["traits"] if t["name"] in used_traits]
    trait_api = {t["name"]: t["apiName"] for t in traits}

    completed = [
        items[a]
        for a in s["items"]
        if a in items
        and a.startswith("TFT_Item_")
        and len(items[a].get("composition") or []) == 2
        and "Emblem" not in a
    ]
    augment_names = [a for a in s["augments"] if a in items]

    return {
        "set": s["number"],
        "mutator": mutator,
        "champions": [
            {
                "id": c["apiName"],
                "name": c["name"],
                "cost": c["cost"],
                "traits": [trait_api[t] for t in c["traits"]],
                "icon": icon_url(c.get("squareIcon")),
                "stats": champion_stats(c["stats"]),
                "spell": spell(c["ability"]),
            }
            for c in sorted(champions, key=lambda c: (c["cost"], c["name"]))
        ],
        "traits": [
            {
                "id": t["apiName"],
                "name": t["name"],
                "breakpoints": sorted({e["minUnits"] for e in t["effects"] if e.get("minUnits")}),
                "icon": icon_url(t.get("icon")),
                "desc": clean(t.get("desc")),
                "effects": [
                    {"minUnits": e["minUnits"], "values": named(e.get("variables"), t.get("desc"))}
                    for e in t["effects"] if e.get("minUnits")
                ],
            }
            for t in sorted(traits, key=lambda t: t["name"])
        ],
        "items": [
            {
                "id": i["apiName"], "name": i["name"], "icon": icon_url(i.get("icon")),
                "stats": {k: round(v, 3) for k, v in (i.get("effects") or {}).items() if k in ITEM_STATS and v},
                "effects": named(i.get("effects"), i.get("desc")),
                "desc": clean(i.get("desc")),
            }
            for i in sorted(completed, key=lambda i: i["name"])
        ],
        "augments": [
            {"id": a, "name": items[a]["name"], "icon": icon_url(items[a].get("icon"))}
            for a in sorted(stable_sample(augment_names, AUGMENT_POOL), key=lambda a: items[a]["name"])
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mutator", default="TFTSet18")
    parser.add_argument("--source", default=SOURCE, help="URL or local path of en_us.json")
    args = parser.parse_args()
    if args.source.startswith("http"):
        with urllib.request.urlopen(args.source, timeout=120) as resp:
            raw = json.load(resp)
    else:
        raw = json.loads(Path(args.source).read_text(encoding="utf-8"))
    data = extract(raw, args.mutator)
    out = ROOT / "data" / f"set{data['set']}.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    print(
        f"wrote {out.relative_to(ROOT)}: {len(data['champions'])} champions, {len(data['traits'])} traits, "
        f"{len(data['items'])} items, {len(data['augments'])} augments"
    )


if __name__ == "__main__":
    main()
