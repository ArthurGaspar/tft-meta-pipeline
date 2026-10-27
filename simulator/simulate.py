"""Plays simulated TFT lobbies with a hidden meta and writes raw match files.

Every champion, trait breakpoint, item and augment gets a hidden power. Players
build boards the way real players do: they lean towards what they believe is
strong (the truth plus noise), chase trait breakpoints and put items on a carry.
A board's strength is the sum of its parts plus luck, and the 8 placements in a
lobby are drawn from those strengths (a Plackett-Luce model).

Halfway through, a balance patch secretly buffs and nerfs a few champions,
traits and items. The ETL never sees any of this: it only gets the match files,
written in the shape of Riot's TFT match API, with a small share of deliberately
dirty records. `truth.json` keeps the hidden values to grade the tier lists.
"""

import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path

STAR_POWER = {1: 1.0, 2: 1.8, 3: 3.2}
LEVEL_SHARE = {7: 0.3, 8: 0.5, 9: 0.2}
# How closely players follow the true meta: lower means more meta-aware.
TEMPERATURE = 0.8


@dataclass
class Meta:
    """The hidden values for one patch."""

    champion: dict[str, float]
    trait: dict[str, list[float]]  # bonus per active breakpoint index
    item: dict[str, float]
    augment: dict[str, float]


@dataclass
class World:
    data: dict
    patches: dict[str, Meta]
    changes: dict[str, dict[str, dict[str, float]]] = field(default_factory=dict)


def build_world(data: dict, rng: random.Random, patches=("18.1", "18.2")) -> World:
    base = Meta(
        champion={c["id"]: 0.3 * c["cost"] + rng.gauss(0, 0.35) for c in data["champions"]},
        trait={
            t["id"]: [round((i + 1) * 0.3 + rng.gauss(0, 0.2), 3) for i in range(len(t["breakpoints"]))]
            for t in data["traits"]
        },
        item={i["id"]: rng.gauss(0, 0.3) for i in data["items"]},
        augment={a["id"]: rng.gauss(0, 0.35) for a in data["augments"]},
    )
    world = World(data=data, patches={patches[0]: base})
    prev = base
    for patch in patches[1:]:
        nxt = Meta(dict(prev.champion), {k: list(v) for k, v in prev.trait.items()}, dict(prev.item), dict(prev.augment))
        change: dict[str, dict[str, float]] = {"champion": {}, "item": {}, "trait": {}}
        for cid in rng.sample(sorted(nxt.champion), 12):
            delta = rng.choice([-1, 1]) * rng.uniform(0.35, 0.7)
            nxt.champion[cid] += delta
            change["champion"][cid] = round(delta, 3)
        for iid in rng.sample(sorted(nxt.item), 4):
            delta = rng.choice([-1, 1]) * rng.uniform(0.25, 0.5)
            nxt.item[iid] += delta
            change["item"][iid] = round(delta, 3)
        for tid in rng.sample(sorted(t for t, b in nxt.trait.items() if len(b) > 1), 3):
            delta = rng.choice([-1, 1]) * rng.uniform(0.25, 0.5)
            nxt.trait[tid] = [round(b + delta * (i + 1) / len(nxt.trait[tid]), 3) for i, b in enumerate(nxt.trait[tid])]
            change["trait"][tid] = round(delta, 3)
        world.patches[patch] = nxt
        world.changes[patch] = change
        prev = nxt
    return world


def _softmax_pick(options: list, scores: list[float], rng: random.Random):
    m = max(scores)
    weights = [math.exp((s - m) / TEMPERATURE) for s in scores]
    return rng.choices(options, weights=weights, k=1)[0]


def _perceived(value: float, rng: random.Random) -> float:
    return value + rng.gauss(0, 0.4)


def active_traits(units: list[dict], data: dict) -> list[dict]:
    """Riot-style trait entries: tier_current is the active breakpoint (0 = inactive)."""
    counts: dict[str, int] = {}
    for u in units:
        for t in u["traits"]:
            counts[t] = counts.get(t, 0) + 1
    out = []
    by_id = {t["id"]: t for t in data["traits"]}
    for tid, n in counts.items():
        bps = by_id[tid]["breakpoints"]
        tier = sum(1 for b in bps if n >= b)
        out.append({"name": tid, "num_units": n, "tier_current": tier, "tier_total": len(bps), "style": min(4, tier)})
    return sorted(out, key=lambda t: (-t["tier_current"], -t["num_units"], t["name"]))


def base_name(champion: dict) -> str:
    """"Lux (Fae)" -> "Lux"."""
    return champion["name"].split(" (")[0]


def _star(cost: int, level: int, rng: random.Random) -> int:
    three = {1: 0.25, 2: 0.15, 3: 0.06, 4: 0.02, 5: 0.0}[cost]
    two = {1: 0.65, 2: 0.65, 3: 0.55, 4: 0.35 + 0.1 * (level - 7), 5: 0.08}[cost]
    r = rng.random()
    return 3 if r < three else 2 if r < three + two else 1


def build_board(world: World, meta: Meta, rng: random.Random) -> dict:
    data = world.data
    level = rng.choices(list(LEVEL_SHARE), weights=list(LEVEL_SHARE.values()))[0]
    max_cost = {7: 4, 8: 5, 9: 5}[level]
    pool = [c for c in data["champions"] if c["cost"] <= max_cost]

    # Pick a primary trait the way players do: believed strength of its first breakpoints.
    traits = [t for t in data["traits"] if len(t["breakpoints"]) > 1]
    primary = _softmax_pick(traits, [_perceived(sum(meta.trait[t["id"]][:2]), rng) for t in traits], rng)
    units: list[dict] = []
    # Each pick favors the primary trait and traits already on the board.
    # Some champions come in several forms (Set 18 Lux has ten); a board holds one of
    # them, and the forms share one champion's chance of being picked.
    forms: dict[str, int] = {}
    for c in pool:
        forms[base_name(c)] = forms.get(base_name(c), 0) + 1
    for _ in range(level):
        taken = {base_name(u) for u in units}
        candidates = [c for c in pool if base_name(c) not in taken]
        counts: dict[str, int] = {}
        for u in units:
            for t in u["traits"]:
                counts[t] = counts.get(t, 0) + 1

        def appeal(c):
            synergy = sum(0.35 for t in c["traits"] if counts.get(t)) + (0.9 if primary["id"] in c["traits"] else 0)
            return _perceived(meta.champion[c["id"]], rng) + synergy - TEMPERATURE * math.log(forms[base_name(c)])

        units.append(dict(_softmax_pick(candidates, [appeal(c) for c in candidates], rng)))

    for u in units:
        u["star"] = _star(u["cost"], level, rng)
        u["items"] = []
    carry = max(units, key=lambda u: (u["cost"], primary["id"] in u["traits"], meta.champion[u["id"]]))
    item_ids = [i["id"] for i in data["items"]]
    for target, n in [(carry, 3)] + [(u, rng.choice([0, 1, 2])) for u in rng.sample(units, 2) if u is not carry]:
        for _ in range(n):
            target["items"].append(_softmax_pick(item_ids, [_perceived(meta.item[i], rng) for i in item_ids], rng))

    augment_ids = [a["id"] for a in data["augments"]]
    augments = []
    for _ in range(3):
        offer = rng.sample([a for a in augment_ids if a not in augments], 3)
        augments.append(_softmax_pick(offer, [_perceived(meta.augment[a], rng) for a in offer], rng))

    trait_rows = active_traits(units, data)
    strength = (
        sum(0.35 * meta.champion[u["id"]] * STAR_POWER[u["star"]] for u in units)
        + sum(meta.trait[t["name"]][t["tier_current"] - 1] for t in trait_rows if t["tier_current"])
        + sum(meta.item[i] * (1.0 if u is carry else 0.5) for u in units for i in u["items"])
        + sum(meta.augment[a] for a in augments)
        + 0.6 * (level - 8)
    )
    return {"level": level, "units": units, "traits": trait_rows, "augments": augments, "strength": strength}


def play_match(world: World, patch: str, match_no: int, rng: random.Random, start_ts: int) -> dict:
    meta = world.patches[patch]
    boards = [build_board(world, meta, rng) for _ in range(8)]
    # Plackett-Luce: sort by strength plus Gumbel noise (scale sets how much luck matters).
    keyed = sorted(range(8), key=lambda i: -(boards[i]["strength"] - 1.2 * math.log(-math.log(rng.random()))))
    placement = {i: rank + 1 for rank, i in enumerate(keyed)}
    match_id = f"SIM1_{match_no:07d}"
    participants = []
    for i, b in enumerate(boards):
        p = placement[i]
        participants.append(
            {
                "puuid": f"player-{rng.getrandbits(48):012x}",
                "placement": p,
                "level": b["level"],
                "gold_left": rng.randint(0, 12) if p > 1 else rng.randint(0, 40),
                "last_round": 40 - 2 * p + rng.randint(-1, 1),
                "total_damage_to_players": max(0, int(160 - 18 * p + rng.gauss(0, 15))),
                "augments": b["augments"],
                "traits": b["traits"],
                "units": [
                    {"character_id": u["id"], "itemNames": u["items"], "rarity": u["cost"] - 1, "tier": u["star"]}
                    for u in b["units"]
                ],
            }
        )
    return {
        "metadata": {"data_version": "6", "match_id": match_id, "participants": [x["puuid"] for x in participants]},
        "info": {
            "game_datetime": (start_ts + match_no * 37) * 1000,
            "game_length": round(1900 + rng.gauss(0, 120), 2),
            "game_version": f"Version {patch}.{rng.randint(500, 520)} (simulated)",
            "queue_id": 1100,
            "tft_set_number": world.data["set"],
            "participants": participants,
        },
    }


def dirty(match: dict, rng: random.Random) -> dict:
    """Introduces one realistic defect so the validator has something to catch."""
    m = json.loads(json.dumps(match))
    kind = rng.choice(["missing_placement", "duplicate_placement", "unknown_champion", "wrong_lobby_size", "bad_version"])
    ps = m["info"]["participants"]
    if kind == "missing_placement":
        del ps[rng.randrange(8)]["placement"]
    elif kind == "duplicate_placement":
        ps[0]["placement"] = ps[1]["placement"]
    elif kind == "unknown_champion":
        ps[rng.randrange(8)]["units"][0]["character_id"] = "DA_18_NotAChampion"
    elif kind == "wrong_lobby_size":
        m["info"]["participants"] = ps[:7]
    else:
        m["info"]["game_version"] = "Version ???"
    return m


def simulate(data: dict, out_dir: Path, matches: int = 3000, batch_size: int = 250, seed: int = 18, dirty_share: float = 0.02):
    """Writes raw/patch=<p>/batch-NNNN.ndjson files, plus truth.json for grading."""
    rng = random.Random(seed)
    world = build_world(data, rng)
    patches = list(world.patches)
    start_ts = 1_790_000_000
    files: list[Path] = []
    batch: list[str] = []
    sent: list[dict] = []

    def flush(patch: str, index: int):
        path = out_dir / "raw" / f"patch={patch}" / f"batch-{index:04d}.ndjson"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(batch) + "\n", encoding="utf-8")
        files.append(path)
        batch.clear()

    per_patch = matches // len(patches)
    index = 0
    for pi, patch in enumerate(patches):
        for n in range(per_patch):
            m = play_match(world, patch, pi * per_patch + n, rng, start_ts)
            if rng.random() < dirty_share:
                m = dirty(m, rng)
            elif sent and rng.random() < dirty_share / 2:
                batch.append(json.dumps(rng.choice(sent[-50:])))  # a re-delivered duplicate
            sent.append(m)
            batch.append(json.dumps(m, separators=(",", ":")))
            if len(batch) >= batch_size:
                flush(patch, index)
                index += 1
        if batch:
            flush(patch, index)
            index += 1

    # One file cut off mid-line, as from an interrupted upload.
    victim = files[len(files) // 2]
    text = victim.read_text(encoding="utf-8")
    victim.write_text(text[: len(text) - 400], encoding="utf-8")
    # One file that isn't text at all.
    junk = out_dir / "raw" / f"patch={patches[-1]}" / "batch-corrupt.ndjson"
    junk.write_bytes(bytes(rng.getrandbits(8) for _ in range(2048)))
    files.append(junk)

    truth = {
        "patches": {
            p: {"champion": m.champion, "trait": m.trait, "item": m.item, "augment": m.augment} for p, m in world.patches.items()
        },
        "changes": world.changes,
    }
    (out_dir / "truth.json").write_text(json.dumps(truth, indent=1), encoding="utf-8")
    return files
