"""Real patches: the set as Riot shipped it in each one, and what changed between them.

`python -m simulator.static_data` stores one snapshot per patch in data/set18/<patch>.json.
Here those snapshots are compared stat by stat, the way patch notes read ("Akali mana
30 -> 25"), and each change is turned into a shift of the simulator's hidden power:
the lobbies are played with the hidden meta, so a real buff makes a champion, trait or
item stronger in them, and the pipeline has to find it.

How much a change moves hidden power is a modeling choice, not Riot data: a relative
change in a stat that helps (Health, Attack Damage, a trait's bonus) counts as a buff, in
one that hurts (a higher mana cost, a longer wait) as a nerf.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Weight of a relative stat change on a champion's strength; negative: lower is better.
CHAMPION_STATS = {"hp": 1.0, "ad": 1.0, "as": 1.0, "armor": 0.5, "mr": 0.5, "range": 0.3, "mana": -0.8}
# A champion's hidden power is about 0.3 x its cost, so a change moves it in proportion:
# +10% Attack Damage on a 3-cost adds CHAMPION_PER_REL x 0.10 x 0.9.
CHAMPION_PER_REL = 1.5
TRAIT_PER_REL = 1.5
ITEM_PER_REL = 1.0
SPELL_PER_REL = 1.0
# Trait and item values where a smaller number is the buff (a shorter wait, fewer stacks needed).
LOWER_IS_BETTER = {"HunterDuration", "RengarStackReq", "RengarADStackReq", "EssenceForRitualTooltip", "PlantNumThreshold", "ICD", "IntervalSeconds", "HealthRegenInterval"}


def patch_key(patch: str) -> tuple[int, ...]:
    return tuple(int(x) for x in patch.split("."))


def load_patches(set_number: int = 18) -> dict[str, dict]:
    """Every stored patch of the set, oldest first."""
    folder = ROOT / "data" / f"set{set_number}"
    files = sorted(folder.glob("*.json"), key=lambda p: patch_key(p.stem))
    if not files:
        raise FileNotFoundError(f"no patches in {folder}; run `python -m simulator.static_data`")
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in files}


def _rel(before: float, after: float) -> float:
    if before == after:
        return 0.0
    return (after - before) / (abs(before) if before else max(abs(after), 1.0))


def _signed(name: str, before: float, after: float) -> float:
    r = _rel(before, after)
    return -r if name in LOWER_IS_BETTER else r


def changes_between(before: dict, after: dict) -> list[dict]:
    """Riot's changes from one patch to the next, one row per stat: {kind, id, name, stat, before, after}."""
    out: list[dict] = []

    def row(kind: str, entity: dict, stat: str, a, b) -> None:
        out.append({"kind": kind, "id": entity["id"], "name": entity["name"], "stat": stat, "before": a, "after": b})

    old = {c["id"]: c for c in before["champions"]}
    for c in after["champions"]:
        p = old.get(c["id"])
        if not p:
            continue
        if p["cost"] != c["cost"]:
            row("champion", c, "cost", p["cost"], c["cost"])
        for k, v in c["stats"].items():
            if p["stats"].get(k) != v:
                row("champion", c, k, p["stats"].get(k), v)
        for k, v in (c.get("spell") or {}).get("vars", {}).items():
            pv = (p.get("spell") or {}).get("vars", {}).get(k)
            if pv != v:
                row("spell", c, k, pv, v)
    old_t = {t["id"]: t for t in before["traits"]}
    for t in after["traits"]:
        p = old_t.get(t["id"])
        if not p:
            continue
        prev = {e["minUnits"]: e["values"] for e in p.get("effects", [])}
        for e in t.get("effects", []):
            for k, v in e["values"].items():
                pv = prev.get(e["minUnits"], {}).get(k)
                if pv != v:
                    row("trait", t, f"{e['minUnits']}: {k}", pv, v)
    old_i = {i["id"]: i for i in before["items"]}
    for i in after["items"]:
        p = old_i.get(i["id"])
        if not p:
            continue
        for k, v in i.get("effects", {}).items():
            if p.get("effects", {}).get(k) != v:
                row("item", i, k, p.get("effects", {}).get(k), v)
    return out


def power_shifts(before: dict, after: dict) -> dict[str, dict]:
    """How Riot's changes move the hidden meta: per champion and item one shift, per trait one per breakpoint."""
    champion: dict[str, float] = {}
    trait: dict[str, dict[int, list[float]]] = {}
    item: dict[str, list[float]] = {}
    mana_of = {c["id"]: c["stats"]["mana"] or 60 for c in after["champions"]}
    scale = {c["id"]: 0.3 * c["cost"] for c in after["champions"]}
    for ch in changes_between(before, after):
        a, b = ch["before"], ch["after"]
        if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
            if ch["kind"] == "spell" and isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
                # a spell value changed: the average relative change over star levels
                rels = [_rel(x, y) for x, y in zip(a[1:4], b[1:4]) if x]
                if rels:
                    champion[ch["id"]] = champion.get(ch["id"], 0.0) + SPELL_PER_REL * scale[ch["id"]] * sum(rels) / len(rels)
            continue
        if ch["kind"] == "champion":
            if ch["stat"] == "startMana":
                shift = 0.6 * (b - a) / mana_of[ch["id"]]
            else:
                shift = CHAMPION_STATS.get(ch["stat"], 0.0) * _rel(a, b)
            champion[ch["id"]] = champion.get(ch["id"], 0.0) + CHAMPION_PER_REL * scale[ch["id"]] * shift
        elif ch["kind"] == "trait":
            units, name = ch["stat"].split(": ", 1)
            trait.setdefault(ch["id"], {}).setdefault(int(units), []).append(_signed(name, a, b))
        elif ch["kind"] == "item":
            item.setdefault(ch["id"], []).append(_signed(ch["stat"], a, b))
    return {
        "champion": {k: round(v, 3) for k, v in champion.items() if abs(v) > 1e-6},
        "trait": {t: {u: round(TRAIT_PER_REL * sum(r) / len(r), 3) for u, r in per.items()} for t, per in trait.items()},
        "item": {k: round(ITEM_PER_REL * sum(r) / len(r), 3) for k, r in item.items()},
    }
