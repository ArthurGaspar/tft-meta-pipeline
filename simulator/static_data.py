"""Extracts the game data the simulator needs from Community Dragon, one snapshot per patch.

    python -m simulator.static_data                 # stores new Set 18 patches, refreshes data/set18.json
    python -m simulator.static_data --cache DIR     # reads DIR/<client version>.json instead of downloading

Riot names TFT patches by set: Set 18's are 18.1, 18.2, ... The game data, though, is
versioned by the game client: Community Dragon keeps one folder per client version
(16.17, 16.18, ...), and Riot's match API reports that version too ("Version 16.21.…").
A set's first patch is the first client version with its full roster, and each later
version is the next patch: client 16.17 is patch 18.1, 16.21 is 18.5.

Each version's file is ~24 MB and covers every set and mode, so a compact snapshot of
the set is kept per patch in data/set18/<patch>.json, recording its client version.
Stored patches are never overwritten (pass --refresh to redo them), so old patches stay
as they were when Riot shipped them. data/set18.json is a copy of the latest one, plus
the table from client version to patch the pipeline uses to name a match's patch.
"""

import argparse
import hashlib
import json
import re
import urllib.request
from pathlib import Path

CDRAGON = "https://raw.communitydragon.org/"
ASSETS = CDRAGON + "latest/game/"
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


def patch_key(patch: str) -> tuple[int, ...]:
    """Orders patch numbers numerically: 16.9 < 16.10."""
    return tuple(int(x) for x in patch.split("."))


def client_versions() -> list[str]:
    """Every game client version Community Dragon keeps, newest first."""
    with urllib.request.urlopen(CDRAGON, timeout=60) as resp:
        html = resp.read().decode("utf-8")
    return sorted(set(re.findall(r'href="(\d+\.\d+)/"', html)), key=patch_key, reverse=True)


def raw_for(version: str, cache: Path | None) -> dict:
    if cache and (cache / f"{version}.json").exists():
        return json.loads((cache / f"{version}.json").read_text(encoding="utf-8"))
    with urllib.request.urlopen(f"{CDRAGON}{version}/cdragon/tft/en_us.json", timeout=300) as resp:
        return json.load(resp)


def write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")


def store_patches(mutator: str, versions: list[str], cache: Path | None = None, refresh: bool = False) -> dict[str, str]:
    """Finds the client versions the set is live in and stores each as a patch; returns {client version: patch}.

    Walks back from the newest version until one doesn't carry the set's full roster (the
    version before launch ships a couple of placeholder champions). Patches are numbered
    from the set's launch: the first live version is <set>.1."""
    number = re.sub(r"\D", "", mutator)
    folder = ROOT / "data" / f"set{number}"
    stored = {}
    for f in folder.glob("*.json"):
        snap = json.loads(f.read_text(encoding="utf-8"))
        if snap.get("client"):
            stored[snap["client"]] = snap
    found: dict[str, dict] = {}
    roster = 0
    for version in versions:
        if version in stored and not refresh:
            data = stored[version]
        else:
            try:
                data = extract(raw_for(version, cache), mutator)
            except StopIteration:  # the set isn't in this version at all
                break
        roster = max(roster, len(data["champions"]))
        if len(data["champions"]) < 0.8 * roster:
            break
        found[version] = data
    clients = sorted(found, key=patch_key)
    names = {client: f"{number}.{i + 1}" for i, client in enumerate(clients)}
    for client in clients:
        if client in stored and not refresh:
            continue
        data = {**found[client], "patch": names[client], "client": client}
        write(folder / f"{names[client]}.json", data)
        print(f"stored patch {names[client]} (client {client}): {len(data['champions'])} champions, {len(data['traits'])} traits, {len(data['items'])} items")
    return names


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mutator", default="TFTSet18")
    parser.add_argument("--cache", type=Path, help="folder of <client version>.json files to read instead of downloading")
    parser.add_argument("--refresh", action="store_true", help="re-extract patches already stored")
    args = parser.parse_args()
    if args.cache:
        versions = sorted((p.stem for p in args.cache.glob("*.json") if re.fullmatch(r"\d+\.\d+", p.stem)), key=patch_key, reverse=True)
    else:
        versions = client_versions()
    names = store_patches(args.mutator, versions, args.cache, args.refresh)
    if not names:
        raise SystemExit(f"no client version has {args.mutator}")
    number = re.sub(r"\D", "", args.mutator)
    latest = names[max(names, key=patch_key)]
    data = json.loads((ROOT / "data" / f"set{number}" / f"{latest}.json").read_text(encoding="utf-8"))
    data["patches"] = names
    write(ROOT / "data" / f"set{number}.json", data)
    print(f"set {number} patches: " + ", ".join(f"{n} (client {c})" for c, n in names.items()) + f"; data/set{number}.json is patch {latest}")

if __name__ == "__main__":
    main()
