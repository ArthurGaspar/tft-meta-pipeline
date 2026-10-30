"""Plays simulated TFT lobbies with a hidden meta and writes raw match files.

Every champion, trait breakpoint, item and augment gets a hidden power. Players
build boards the way real players do: they lean towards what they believe is
strong (the truth plus noise), chase trait breakpoints and put items on a carry.
A lobby also has the structure of a real one:

- economy: each player follows a plan (reroll, fast 8 or fast 9) that sets the
  final level, the chance of 3-starring cheap units, and how strong the board is
  at each stage of the game;
- contested units: the 8 players share one pool of champion copies. Players
  scout and lean away from what others are building, and a unit several boards
  want reaches 2 and 3 stars less often;
- positioning: every player has a hidden positioning skill and a formation, each
  formation counters another, and a player who loses a fight may re-position to
  counter the board that beat them.

A match is played out round by round: players are paired each PvP round, the
stronger board (plus positioning and luck) usually wins, the loser loses health,
and placements come from the order players are knocked out.

The lobbies are played across the set's real patches (18.1, 18.2, ...), with the
data Riot shipped in each, and every change Riot made from one patch to the next
(simulator/patches.py) moves the hidden meta. The ETL never sees any of this: it
only gets the match files, written in the shape of Riot's TFT match API, with a
small share of deliberately dirty records. `truth.json` keeps the hidden values and
Riot's changes to grade the tier lists and the patch changes the pipeline finds.
"""

import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path

from simulator.patches import changes_between, power_shifts

STAR_POWER = {1: 1.0, 2: 1.8, 3: 3.2}
# A 3-star is worth more than its stats whatever it costs; that is what makes reroll comps work.
STAR_FLAT = {1: 0.0, 2: 0.1, 3: 0.8}
# How closely players follow the true meta: lower means more meta-aware.
TEMPERATURE = 0.8

# The shared pool: copies of each champion by cost, and the copies each star level takes.
POOL_COPIES = {1: 30, 2: 25, 3: 18, 4: 10, 5: 9}
COPIES = {1: 1, 2: 3, 3: 9}
# Scouting: how much a player is put off a champion or primary trait per earlier player already on it.
CONTEST_AVOID = 0.5
# Per other board holding the same champion: the factor on the chance of reaching 2 and 3 stars.
CONTEST_TWO_STAR = 0.8
CONTEST_THREE_STAR = 0.5

# Positioning: each formation beats the next one in the cycle.
FORMATIONS = ("corner", "clump", "spread")
BEATS = {"corner": "clump", "clump": "spread", "spread": "corner"}
COUNTER_EDGE = 0.3
POSITIONING_SKILL = 0.2  # sd of a player's hidden skill, in board-strength units
ADAPT = 0.5  # chance a player who lost a fight re-positions to counter the winner

# Combat: win chance is a logistic of the strength gap over COMBAT_LUCK.
COMBAT_LUCK = 0.9
START_HP = 100
STAGE_DAMAGE = {2: 2, 3: 5, 4: 8, 5: 10, 6: 12, 7: 17}
STAGE1_ROUNDS = 4
ROUNDS_PER_STAGE = 7
PVP_ROUNDS = (1, 2, 3, 5, 6)  # round 4 is the carousel, round 7 is PvE

# Boards per patch kept as opponents for the website's real-time simulator.
SAMPLE_BOARDS = 240


@dataclass(frozen=True)
class Strategy:
    """An economy plan: where the gold goes, and so how strong the board is at each stage."""

    share: float  # of players who follow it
    levels: dict[int, float]  # final level distribution
    three_star: dict[int, float]  # chance a unit of each cost reaches 3 stars, uncontested
    carry_three_star: float  # extra 3-star chance for the carry (what a reroll player rolls for)
    carry_max_cost: int
    tempo: dict[int, float]  # strength offset from the final board at each stage
    level_by_stage: dict[int, int]  # the level the plan has reached by each stage (final level after)
    gold_left: int  # most gold a non-winner ends with


STRATEGIES = {
    # Slow roll at a low level for 3-star 1-3 costs: strong early, low ceiling.
    "reroll": Strategy(
        0.25, {6: 0.2, 7: 0.55, 8: 0.25}, {1: 0.45, 2: 0.35, 3: 0.2, 4: 0.0, 5: 0.0}, 0.4, 3,
        {2: -0.4, 3: -0.1, 4: 0.0}, {2: 5, 3: 6, 4: 7}, 20,
    ),
    # The standard: hold gold for interest, level to 8 in stage 4 and roll for 4-costs.
    "fast8": Strategy(
        0.55, {7: 0.15, 8: 0.7, 9: 0.15}, {1: 0.2, 2: 0.12, 3: 0.05, 4: 0.02, 5: 0.0}, 0.0, 5,
        {2: -0.8, 3: -0.6, 4: -0.1}, {2: 5, 3: 6, 4: 8, 5: 8}, 12,
    ),
    # Greed: skip rolling, level to 9 (or 10) for 5-costs; weak until stage 5, highest ceiling.
    "fast9": Strategy(
        0.2, {8: 0.25, 9: 0.6, 10: 0.15}, {1: 0.1, 2: 0.05, 3: 0.02, 4: 0.02, 5: 0.0}, 0.0, 5,
        {2: -1.2, 3: -1.6, 4: -1.6, 5: -1.0}, {2: 5, 3: 6, 4: 7, 5: 9}, 30,
    ),
}


@dataclass
class Meta:
    """The hidden values for one patch."""

    champion: dict[str, float]
    trait: dict[str, list[float]]  # bonus per active breakpoint index
    item: dict[str, float]
    augment: dict[str, float]


@dataclass
class World:
    data: dict  # the latest patch: who exists and what they cost
    patches: dict[str, Meta]
    # per patch: how Riot's changes moved the hidden meta ({kind: {id: shift}})
    changes: dict[str, dict[str, dict[str, float]]] = field(default_factory=dict)
    # per patch: the set as Riot shipped it, and Riot's changes from the previous patch, stat by stat
    snapshots: dict[str, dict] = field(default_factory=dict)
    notes: dict[str, list[dict]] = field(default_factory=dict)


def build_world(snapshots: dict[str, dict], rng: random.Random) -> World:
    """The hidden meta of each real patch, oldest first.

    The first patch's powers are drawn at random (Riot publishes stats, not how strong
    things are); every later patch starts from the one before and applies Riot's changes."""
    patches = list(snapshots)
    first = snapshots[patches[0]]
    base = Meta(
        champion={c["id"]: 0.3 * c["cost"] + rng.gauss(0, 0.35) for c in first["champions"]},
        trait={
            t["id"]: [round((i + 1) * 0.3 + rng.gauss(0, 0.2), 3) for i in range(len(t["breakpoints"]))]
            for t in first["traits"]
        },
        item={i["id"]: rng.gauss(0, 0.3) for i in first["items"]},
        augment={a["id"]: rng.gauss(0, 0.35) for a in snapshots[patches[-1]]["augments"]},
    )
    world = World(data=snapshots[patches[-1]], patches={patches[0]: base}, snapshots=snapshots)
    prev = base
    for before, patch in zip(patches, patches[1:]):
        nxt = Meta(dict(prev.champion), {k: list(v) for k, v in prev.trait.items()}, dict(prev.item), dict(prev.augment))
        shifts = power_shifts(snapshots[before], snapshots[patch])
        change: dict[str, dict[str, float]] = {"champion": {}, "item": {}, "trait": {}}
        for cid, delta in shifts["champion"].items():
            if cid in nxt.champion:
                nxt.champion[cid] += delta
                change["champion"][cid] = delta
        for iid, delta in shifts["item"].items():
            if iid in nxt.item:
                nxt.item[iid] += delta
                change["item"][iid] = delta
        bps = {t["id"]: t["breakpoints"] for t in snapshots[patch]["traits"]}
        for tid, per in shifts["trait"].items():
            if tid not in nxt.trait:
                continue
            for units, delta in per.items():
                if units in bps.get(tid, []):
                    i = bps[tid].index(units)
                    nxt.trait[tid][i] = round(nxt.trait[tid][i] + delta, 3)
            change["trait"][tid] = round(sum(per.values()) / len(per), 3)
        world.patches[patch] = nxt
        world.changes[patch] = change
        world.notes[patch] = changes_between(snapshots[before], snapshots[patch])
        prev = nxt
    return world


def _softmax_pick(options: list, scores: list[float], rng: random.Random):
    m = max(scores)
    weights = [math.exp((s - m) / TEMPERATURE) for s in scores]
    return rng.choices(options, weights=weights, k=1)[0]


def _perceived(value: float, rng: random.Random) -> float:
    return value + rng.gauss(0, 0.4)


def _weighted(dist: dict, rng: random.Random):
    return rng.choices(list(dist), weights=list(dist.values()))[0]


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


def pick_units(world: World, meta: Meta, strategy_name: str, scouted: dict[str, int], primaries: list[str], rng: random.Random) -> dict:
    """A player's plan and units. `scouted` and `primaries` are what earlier players in the lobby are building."""
    data = world.data
    strategy = STRATEGIES[strategy_name]
    level = _weighted(strategy.levels, rng)
    max_cost = {6: 4, 7: 4, 8: 5, 9: 5, 10: 5}[level]
    pool = [c for c in data["champions"] if c["cost"] <= max_cost]

    # Pick a primary trait the way players do: believed strength of its first breakpoints,
    # less appealing when someone in the lobby is already going for it.
    traits = [t for t in data["traits"] if len(t["breakpoints"]) > 1]
    primary = _softmax_pick(
        traits, [_perceived(sum(meta.trait[t["id"]][:2]), rng) - CONTEST_AVOID * primaries.count(t["id"]) for t in traits], rng
    )
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
            plan = 0.4 if c["cost"] <= strategy.carry_max_cost < 5 else 0.0  # a reroll player wants cheap units
            return (
                _perceived(meta.champion[c["id"]], rng) + synergy + plan
                - CONTEST_AVOID * scouted.get(base_name(c), 0)
                - TEMPERATURE * math.log(forms[base_name(c)])
            )

        units.append(dict(_softmax_pick(candidates, [appeal(c) for c in candidates], rng)))

    for u in units:
        u["star"] = 1
        u["items"] = []
    eligible = [u for u in units if u["cost"] <= strategy.carry_max_cost] or units
    carry = max(eligible, key=lambda u: (u["cost"], primary["id"] in u["traits"], meta.champion[u["id"]]))
    return {"strategy": strategy_name, "level": level, "units": units, "carry": carry, "primary": primary["id"]}


def roll_stars(board: dict, holders: dict[str, int], rng: random.Random) -> None:
    """Star levels, harder to reach when other boards in the lobby hold the same champion."""
    strategy = STRATEGIES[board["strategy"]]
    level = board["level"]
    for u in board["units"]:
        contest = holders[base_name(u)] - 1
        three = strategy.three_star[u["cost"]] + (strategy.carry_three_star if u is board["carry"] else 0.0)
        three *= CONTEST_THREE_STAR**contest
        two = {1: 0.65, 2: 0.65, 3: 0.55, 4: 0.35 + 0.1 * (level - 7), 5: 0.08 + 0.05 * (level - 8)}[u["cost"]]
        two = min(max(0.0, two) * CONTEST_TWO_STAR**contest, 1.0 - three)
        r = rng.random()
        u["star"] = 3 if r < three else 2 if r < three + two else 1


def enforce_pool(boards: list[dict], rng: random.Random) -> int:
    """When the lobby's boards need more copies of a champion than the pool holds, someone stays a star lower.

    Returns how many star levels were lost this way."""
    holding: dict[str, list[dict]] = {}
    for b in boards:
        for u in b["units"]:
            holding.setdefault(base_name(u), []).append(u)
    lost = 0
    for units in holding.values():
        pool = POOL_COPIES[units[0]["cost"]]
        while sum(COPIES[u["star"]] for u in units) > pool:
            rng.choice([u for u in units if u["star"] > 1])["star"] -= 1
            lost += 1
    return lost


def finish_board(world: World, meta: Meta, board: dict, rng: random.Random) -> None:
    """Items, augments, traits and the board's final strength."""
    data = world.data
    units, carry = board["units"], board["carry"]
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
    board["traits"] = trait_rows
    board["augments"] = augments
    board["strength"] = (
        sum(0.35 * meta.champion[u["id"]] * STAR_POWER[u["star"]] + STAR_FLAT[u["star"]] for u in units)
        + sum(meta.trait[t["name"]][t["tier_current"] - 1] for t in trait_rows if t["tier_current"])
        + sum(meta.item[i] * (1.0 if u is carry else 0.5) for u in units for i in u["items"])
        + sum(meta.augment[a] for a in augments)
        + 0.3 * (board["level"] - 8)
    )


def board_at_level(world: World, board: dict, level: int) -> None:
    """The board a player had when knocked out before their plan's final level: the carry and
    itemized units stay, the last units the plan would have added go."""
    if level >= board["level"]:
        return
    order = {id(u): i for i, u in enumerate(board["units"])}
    keep = sorted(board["units"], key=lambda u: (u is not board["carry"], not u["items"], order[id(u)]))[:level]
    kept = {id(u) for u in keep}
    board["units"] = [u for u in board["units"] if id(u) in kept]
    board["level"] = level
    board["traits"] = active_traits(board["units"], world.data)


def build_lobby(world: World, meta: Meta, rng: random.Random) -> tuple[list[dict], int]:
    """Eight boards built in turn, each player scouting the ones before; then stars from the shared pool."""
    boards: list[dict] = []
    scouted: dict[str, int] = {}
    primaries: list[str] = []
    for _ in range(8):
        strategy = _weighted({k: s.share for k, s in STRATEGIES.items()}, rng)
        b = pick_units(world, meta, strategy, scouted, primaries, rng)
        boards.append(b)
        primaries.append(b["primary"])
        for u in b["units"]:
            scouted[base_name(u)] = scouted.get(base_name(u), 0) + 1
    for b in boards:
        roll_stars(b, scouted, rng)
    lost = enforce_pool(boards, rng)
    for b in boards:
        finish_board(world, meta, b, rng)
    return boards, lost


def play_out(boards: list[dict], rng: random.Random, log: dict | None = None) -> list[dict]:
    """Plays the lobby round by round until one player is left.

    Returns, per board: placement, last round and stage played, and damage dealt to other players."""
    n = len(boards)
    hp = [START_HP] * n
    dealt = [0] * n
    out: list[dict] = [{} for _ in range(n)]
    skill = [rng.gauss(0, POSITIONING_SKILL) for _ in range(n)]
    formation = [rng.choice(FORMATIONS) for _ in range(n)]
    for i, b in enumerate(boards):
        b["positioning"] = skill[i]
    alive = list(range(n))
    stage, round_no = 2, STAGE1_ROUNDS
    log = log if log is not None else {}

    def power(i: int) -> float:
        tempo = STRATEGIES[boards[i]["strategy"]].tempo
        return boards[i]["strength"] + tempo.get(stage, 0.0) + skill[i]

    def fight(a: int, b: int, ghost: bool = False) -> None:
        edge = power(a) - power(b)
        countered = BEATS[formation[a]] == formation[b] or BEATS[formation[b]] == formation[a]
        if BEATS[formation[a]] == formation[b]:
            edge += COUNTER_EDGE
        elif BEATS[formation[b]] == formation[a]:
            edge -= COUNTER_EDGE
        p_a = 1 / (1 + math.exp(-edge / COMBAT_LUCK))
        winner, loser = (a, b) if rng.random() < p_a else (b, a)
        if countered:
            log["counterFights"] = log.get("counterFights", 0) + 1
            log["counterWins"] = log.get("counterWins", 0) + (BEATS[formation[winner]] == formation[loser])
        p_win = p_a if winner == a else 1 - p_a
        # Losing to a ghost costs health; beating one doesn't hurt the player it copies.
        if not (ghost and loser == b):
            survivors = 1 + sum(rng.random() < 0.6 * p_win for _ in range(boards[winner]["level"] - 1))
            damage = STAGE_DAMAGE.get(stage, 17 + 3 * (stage - 7)) + survivors
            hp[loser] -= damage
            if not ghost:
                dealt[winner] += damage
            if rng.random() < ADAPT:
                log["adaptations"] = log.get("adaptations", 0) + 1
                formation[loser] = next(f for f in FORMATIONS if BEATS[f] == formation[winner])

    while len(alive) > 1:
        for k in range(1, ROUNDS_PER_STAGE + 1):
            round_no += 1
            if k not in PVP_ROUNDS:
                continue
            order = rng.sample(alive, len(alive))
            for a, b in zip(order[::2], order[1::2]):
                fight(a, b)
            if len(order) % 2:  # the odd player out fights a copy of someone else's board
                fight(order[-1], rng.choice(order[:-1]), ghost=True)
            dead = sorted((i for i in alive if hp[i] <= 0), key=lambda i: (hp[i], rng.random()))
            for i in dead:
                if len(alive) == 1:
                    break
                out[i] = {"placement": len(alive), "last_round": round_no, "stage": stage}
                alive.remove(i)
            if len(alive) == 1:
                out[alive[0]] = {"placement": 1, "last_round": round_no, "stage": stage}
                break
        stage += 1
    for i in range(n):
        out[i]["damage"] = dealt[i]
    return out


def play_match(world: World, patch: str, match_no: int, rng: random.Random, start_ts: int, log: dict | None = None) -> dict:
    """One lobby in Riot's match shape. `log`, if given, collects hidden facts for the truth check."""
    meta = world.patches[patch]
    boards, lost = build_lobby(world, meta, rng)
    results = play_out(boards, rng, log)
    if log is not None:  # full planned boards, before knocked-out players lose units: opponents for the browser simulator
        sample = log.setdefault("sampleBoards", {}).setdefault(patch, [])
        for b, r in zip(boards, results):
            if len(sample) < SAMPLE_BOARDS:
                sample.append(
                    {"strategy": b["strategy"], "level": b["level"], "placement": r["placement"],
                     "units": [[u["id"], u["star"], u["items"]] for u in b["units"]]}
                )
    for b, r in zip(boards, results):
        board_at_level(world, b, STRATEGIES[b["strategy"]].level_by_stage.get(r["stage"], b["level"]))
    match_id = f"SIM1_{match_no:07d}"
    participants = []
    hidden = {}
    for b, r in zip(boards, results):
        p = r["placement"]
        puuid = f"player-{rng.getrandbits(48):012x}"
        hidden[puuid] = [b["strategy"], round(b["positioning"], 3)]
        participants.append(
            {
                "puuid": puuid,
                "placement": p,
                "level": b["level"],
                "gold_left": rng.randint(0, STRATEGIES[b["strategy"]].gold_left) + (rng.randint(0, 30) if p == 1 else 0),
                "last_round": r["last_round"],
                "total_damage_to_players": r["damage"],
                "augments": b["augments"],
                "traits": b["traits"],
                "units": [
                    {"character_id": u["id"], "itemNames": u["items"], "rarity": u["cost"] - 1, "tier": u["star"]}
                    for u in b["units"]
                ],
            }
        )
    if log is not None:
        log.setdefault("boards", {})[match_id] = hidden
        log["starsLostToPool"] = log.get("starsLostToPool", 0) + lost
    return {
        "metadata": {"data_version": "6", "match_id": match_id, "participants": [x["puuid"] for x in participants]},
        "info": {
            "game_datetime": (start_ts + match_no * 37) * 1000,
            "game_length": round(1900 + rng.gauss(0, 120), 2),
            # Riot's match API carries the game client version (patch 18.5 is client 16.21), not the patch name
            "game_version": f"Version {world.snapshots.get(patch, {}).get('client', patch)}.{rng.randint(500, 520)} (simulated)",
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


def simulate(
    snapshots: dict[str, dict], out_dir: Path, matches: int = 5000, batch_size: int = 250, seed: int = 18, dirty_share: float = 0.02
):
    """Plays `matches` lobbies split evenly over the real patches in `snapshots` (oldest first).

    Writes raw/patch=<p>/batch-NNNN.ndjson files, plus truth.json for grading and game.json for the website."""
    rng = random.Random(seed)
    world = build_world(snapshots, rng)
    patches = list(world.patches)
    start_ts = 1_790_000_000
    files: list[Path] = []
    batch: list[str] = []
    sent: list[dict] = []
    log: dict = {}

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
            m = play_match(world, patch, pi * per_patch + n, rng, start_ts, log)
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
        # Riot's changes from the previous patch, as patch notes read: {kind, id, name, stat, before, after}
        "riotChanges": world.notes,
        # Per board, what the match file doesn't say: [economy plan, positioning skill], by match and puuid.
        "boards": log["boards"],
        "mechanics": {
            "counterFights": log.get("counterFights", 0),
            "counterWins": log.get("counterWins", 0),
            "adaptations": log.get("adaptations", 0),
            "starsLostToPool": log.get("starsLostToPool", 0),
        },
    }
    (out_dir / "truth.json").write_text(json.dumps(truth, separators=(",", ":")), encoding="utf-8")
    (out_dir / "game.json").write_text(json.dumps(game_data(world, log), separators=(",", ":")), encoding="utf-8")
    return files


def game_data(world: World, log: dict) -> dict:
    """Everything the website's real-time simulator needs: the set's units and items as of the latest
    patch, and per patch what Riot shipped then (stats, ability values, trait and item values), the
    changes from the patch before, the hidden meta (so a fight there follows the same balance as
    these lobbies), and real boards from the simulated lobbies to fight against."""
    r = lambda x: round(x, 3)  # noqa: E731

    def shipped(p: str) -> dict:
        snap = world.snapshots.get(p, world.data)
        return {
            "stats": {c["id"]: c["stats"] for c in snap["champions"]},
            "spells": {c["id"]: c["spell"]["vars"] for c in snap["champions"] if c.get("spell", {}).get("vars")},
            "traitEffects": {t["id"]: t.get("effects", []) for t in snap["traits"]},
            "itemEffects": {i["id"]: {"stats": i["stats"], "effects": i.get("effects", {})} for i in snap["items"]},
        }

    return {
        "set": world.data["set"],
        "champions": world.data["champions"],
        "traits": world.data["traits"],
        "items": world.data["items"],
        "patches": {
            p: {
                "champion": {k: r(v) for k, v in m.champion.items()},
                "trait": m.trait,
                "item": {k: r(v) for k, v in m.item.items()},
                "boards": log.get("sampleBoards", {}).get(p, []),
                "riotChanges": world.notes.get(p, []),
                **shipped(p),
            }
            for p, m in world.patches.items()
        },
        "strategies": {k: {"levels": s.levels} for k, s in STRATEGIES.items()},
    }
