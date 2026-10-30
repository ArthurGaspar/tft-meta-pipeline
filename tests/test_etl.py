import json
import re
import random
from pathlib import Path

import pymysql
import pytest

from functions.aggregate.handler import assign_tiers, shrink, tier_of
from functions.common import comp_of, holders_in_lobby, patch_key, patch_name, patch_of, playstyle_of
from functions.validate.handler import problems
from run import spearman, truth_check
from simulator.patches import changes_between, load_patches, power_shifts
from simulator.simulate import board_at_level, build_world, dirty, enforce_pool, play_match, play_out, roll_stars, simulate

ROOT = Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "data" / "set18.json").read_text(encoding="utf-8"))
# Set 18's real patches, oldest first (data/set18/<patch>.json).
PATCHES = load_patches()
FIRST, LAST = list(PATCHES)[0], list(PATCHES)[-1]
INDEXED = {
    "set": DATA["set"],
    "champions": {c["id"]: c for c in DATA["champions"]},
    "traits": {t["id"]: t for t in DATA["traits"]},
    "items": {i["id"]: i for i in DATA["items"]},
    "augments": {a["id"]: a for a in DATA["augments"]},
    "patches": DATA.get("patches", {}),
}


@pytest.fixture(scope="module")
def match():
    world = build_world(PATCHES, random.Random(1))
    return play_match(world, FIRST, 0, random.Random(2), 1_790_000_000)


def test_simulated_match_is_valid(match):
    assert problems(match, INDEXED) == []
    assert sorted(p["placement"] for p in match["info"]["participants"]) == list(range(1, 9))


def test_every_defect_is_caught(match):
    rng = random.Random(3)
    seen = set()
    for _ in range(60):
        reasons = problems(dirty(match, rng), INDEXED)
        assert reasons, "a dirty record passed validation"
        seen.update(reasons)
    assert {"missing_placement", "invalid_placements", "unknown_champion", "wrong_lobby_size", "unknown_version"} <= seen


def test_patch_parsing():
    assert patch_of("Version 16.21.507.4471 (simulated)") == "16.21"  # the client version, as Riot's API has it
    assert patch_name("Version 16.21.507.4471 (simulated)", INDEXED) == "18.5"  # the patch players know
    assert patch_name("Version 15.1.1 (simulated)", INDEXED) is None
    assert sorted(["18.10", "18.9", "18.2"], key=patch_key) == ["18.2", "18.9", "18.10"]
    assert patch_of("Version ???") is None


def test_comp_is_top_trait_plus_most_itemized_unit():
    p = {
        "traits": [
            {"name": "A", "tier_current": 1, "num_units": 2},
            {"name": "B", "tier_current": 2, "num_units": 4},
            {"name": "C", "tier_current": 0, "num_units": 1},
        ],
        "units": [
            {"character_id": "x", "itemNames": ["i"], "rarity": 4, "tier": 1},
            {"character_id": "y", "itemNames": ["i", "j", "k"], "rarity": 1, "tier": 2},
        ],
    }
    assert comp_of(p) == ("B|y", "y")


def _unit(cid: str, star: int = 1, items=()) -> dict:
    return {**INDEXED["champions"][cid], "star": star, "items": list(items)}


def test_lobby_is_played_out_to_eight_distinct_placements(match):
    ps = match["info"]["participants"]
    by_place = sorted(ps, key=lambda p: p["placement"])
    # Players knocked out earlier played fewer rounds; the last two leave in the same round.
    rounds = [p["last_round"] for p in by_place]
    assert rounds == sorted(rounds, reverse=True) and rounds[0] == rounds[1]
    assert all(p["total_damage_to_players"] >= 0 for p in ps)


def test_play_out_favors_the_stronger_board():
    rng = random.Random(4)
    wins = 0
    for _ in range(200):
        boards = [{"strategy": "fast8", "level": 8, "strength": 3.0 if i == 0 else 0.0} for i in range(8)]
        wins += play_out(boards, rng)[0]["placement"] <= 4
    assert wins > 150


def test_contested_units_reach_fewer_stars():
    rng = random.Random(5)
    cid = next(c["id"] for c in DATA["champions"] if c["cost"] == 1)

    def avg_star(holders: int) -> float:
        total = 0
        for _ in range(2000):
            board = {"strategy": "reroll", "level": 7, "units": [_unit(cid)]}
            board["carry"] = board["units"][0]
            roll_stars(board, {INDEXED["champions"][cid]["name"].split(" (")[0]: holders}, rng)
            total += board["units"][0]["star"]
        return total / 2000

    assert avg_star(1) > avg_star(2) > avg_star(4)


def test_shared_pool_caps_copies():
    four = next(c["id"] for c in DATA["champions"] if c["cost"] == 4)  # 10 copies in the pool
    boards = [{"units": [_unit(four, 3)]}, {"units": [_unit(four, 2)]}]  # 9 + 3 copies wanted
    assert enforce_pool(boards, random.Random(6)) >= 1
    assert sum({1: 1, 2: 3, 3: 9}[b["units"][0]["star"]] for b in boards) <= 10


def test_knocked_out_board_keeps_carry_and_items():
    world = build_world(PATCHES, random.Random(7))
    ids = [c["id"] for c in DATA["champions"][:8]]
    units = [_unit(c) for c in ids]
    units[5]["items"] = ["x"]
    board = {"level": 8, "units": units, "carry": units[7]}
    board_at_level(world, board, 6)
    kept = [u["id"] for u in board["units"]]
    assert board["level"] == 6 and len(kept) == 6 and ids[7] in kept and ids[5] in kept and ids[6] not in kept


def test_playstyle_is_read_from_the_board():
    def board(level, *units):
        return {"level": level, "units": [{"tier": star, "rarity": cost - 1} for cost, star in units]}

    assert playstyle_of(board(7, (2, 3), (4, 1))) == "reroll"
    assert playstyle_of(board(8, (4, 3))) == "fast8"  # a 3-star 4-cost isn't a reroll comp
    assert playstyle_of(board(9, (1, 3))) == "fast9"
    assert playstyle_of(board(8, (3, 2))) == "fast8"


def test_lux_forms_share_one_pool():
    lux = [c["id"] for c in DATA["champions"] if c["name"].startswith("Lux")]
    ps = [{"units": [{"character_id": lux[0]}]}, {"units": [{"character_id": lux[1]}]}]
    assert holders_in_lobby(ps, INDEXED["champions"])["Lux"] == 2


def test_game_data_for_the_browser_simulator(tmp_path):
    simulate(PATCHES, tmp_path, matches=20 * len(PATCHES), batch_size=20, seed=8)
    game = json.loads((tmp_path / "game.json").read_text(encoding="utf-8"))
    truth = json.loads((tmp_path / "truth.json").read_text(encoding="utf-8"))
    assert all({"hp", "ad", "as", "range", "mana"} <= set(c["stats"]) for c in game["champions"])
    assert set(game["patches"]) == set(truth["patches"])
    for patch, meta in game["patches"].items():
        # The browser fights with the same hidden meta the lobbies were played with.
        assert meta["champion"] == {k: round(v, 3) for k, v in truth["patches"][patch]["champion"].items()}
        board = meta["boards"][0]
        assert len(meta["boards"]) == 160 and len(board["units"]) == board["level"]  # 20 lobbies of 8, full boards
        assert all(cid in INDEXED["champions"] and 1 <= star <= 3 for cid, star, _ in board["units"])
        # ...and the stats Riot shipped in that patch
        assert meta["stats"] == {c["id"]: c["stats"] for c in PATCHES[patch]["champions"]}


def test_patches_are_real_and_ordered():
    assert len(PATCHES) >= 2 and list(PATCHES) == sorted(PATCHES, key=patch_key)
    assert all(snap["patch"] == patch for patch, snap in PATCHES.items())
    # named by set (18.1, 18.2, ...), each recording the client version it shipped as
    assert all(re.fullmatch(r"18\.\d+", p) for p in PATCHES) and DATA["patches"] == {s["client"]: p for p, s in PATCHES.items()}
    assert DATA["patch"] == LAST  # data/set18.json is the latest patch


def test_riot_changes_move_the_hidden_meta():
    """Riot buffed Kha'Zix in 18.2 (Attack Damage 30 -> 40, Health 850 -> 950) and nerfed Diana in 18.4 (mana 30 -> 40)."""
    if not {"18.1", "18.2", "18.3", "18.4"} <= set(PATCHES):
        pytest.skip("needs Set 18 patches 18.1-18.4")
    khazix = [c for c in changes_between(PATCHES["18.1"], PATCHES["18.2"]) if c["name"] == "Kha'Zix"]
    assert {(c["stat"], c["before"], c["after"]) for c in khazix} == {("hp", 850.0, 950.0), ("ad", 30.0, 40.0)}
    assert power_shifts(PATCHES["18.1"], PATCHES["18.2"])["champion"]["DA_18_KhaZix"] > 0.3
    assert power_shifts(PATCHES["18.3"], PATCHES["18.4"])["champion"]["DA_18_Diana"] < 0
    world = build_world(PATCHES, random.Random(3))
    assert world.patches["18.2"].champion["DA_18_KhaZix"] > world.patches["18.1"].champion["DA_18_KhaZix"]
    assert world.changes["18.2"]["champion"]["DA_18_KhaZix"] > 0 and world.notes["18.2"]


def test_shrinkage_pulls_small_samples_to_average():
    assert shrink(1.0, 5) > shrink(1.0, 500)
    assert shrink(4.5, 3) == pytest.approx(4.5)


def test_tiers_follow_spread_and_need_games():
    stats = [{"kind": "champion", "patch": "p", "games": 100, "score": s} for s in (3.0, 4.0, 4.5, 5.0, 6.0)]
    stats.append({"kind": "champion", "patch": "p", "games": 5, "score": 2.0})
    assign_tiers(stats)
    assert [s["tier"] for s in stats] == ["S", "A", "B", "C", "D", None]
    assert tier_of(4.5, 100, 0.0) is None


def test_spearman():
    assert spearman([1, 2, 3, 4], [10, 20, 30, 40]) == 1.0
    assert spearman([1, 2, 3, 4], [4, 3, 2, 1]) == -1.0
    assert spearman([1, 2], [1, 2]) is None


def test_truth_check_scores_detection():
    tierlists = {"18.1": {k: [] for k in ("champion", "item", "augment")}}
    changes = [
        {"kind": "champion", "id": "a", "to": "18.2", "significant": True, "delta": -0.5},  # buffed, placed better
        {"kind": "champion", "id": "z", "to": "18.2", "significant": True, "delta": 0.4},  # not actually changed
    ]
    truth = {"patches": {"18.1": {"champion": {}, "item": {}, "augment": {}}}, "changes": {"18.2": {"champion": {"a": 0.5, "b": -0.4}}}}
    out = truth_check(tierlists, changes, truth)["changes"]["18.2"]
    assert out == {"riotChanges": 0, "trueChanges": 2, "flagged": 2, "flaggedAndReal": 1, "rightDirection": 1, "missed": ["champion:b"]}


def test_truth_check_matches_trait_breakpoints_to_their_trait():
    """The pipeline reports "Invoker:1" (a breakpoint); Riot's change is to the trait. One trait counts once."""
    tierlists = {"18.4": {k: [] for k in ("champion", "item", "augment")}}
    changes = [
        {"kind": "trait", "id": "inv:1", "to": "18.5", "significant": True, "delta": -0.7, "z": -7.0},
        {"kind": "trait", "id": "inv:2", "to": "18.5", "significant": True, "delta": 0.2, "z": 3.1},
    ]
    truth = {"patches": {"18.4": {"champion": {}, "item": {}, "augment": {}}}, "changes": {"18.5": {"trait": {"inv": 0.5}}}}
    out = truth_check(tierlists, changes, truth)["changes"]["18.5"]
    assert (out["flagged"], out["flaggedAndReal"], out["rightDirection"]) == (1, 1, 1)


def test_truth_check_grades_playstyles_and_positioning():
    tierlists = {"18.1": {k: [] for k in ("champion", "item", "augment")}}
    truth = {
        "patches": {"18.1": {"champion": {}, "item": {}, "augment": {}}},
        "changes": {},
        "boards": {"M": {"a": ["reroll", -0.3], "b": ["fast9", 0.0], "c": ["fast8", 0.3]}},
        "mechanics": {"counterFights": 10, "counterWins": 6, "adaptations": 3},
    }
    boards = [("M", "a", "reroll", 8), ("M", "b", "fast8", 4), ("M", "c", "fast8", 1), ("M", "unknown", "fast8", 2)]
    out = truth_check(tierlists, [], truth, boards)
    assert out["playstyle"]["boards"] == 3 and out["playstyle"]["accuracy"] == 0.6667
    assert out["playstyle"]["confusion"]["fast9"] == {"fast8": 1}
    assert [t["avgPlacement"] for t in out["positioning"]["thirds"]] == [8, 4, 1]
    assert out["positioning"]["counterWinRate"] == 0.6


def _db_available() -> bool:
    """Uses the database the stack template points at (DB_* variables, else the local defaults)."""
    from minicloud.template import load

    props = load(ROOT / "infra" / "stack.yaml").resources["MetaDb"].props
    try:
        pymysql.connect(
            host=props["host"], port=int(props["port"]), user=props["user"], password=props.get("password", ""),
            database=props["name"], connect_timeout=2,
        ).close()
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _db_available(), reason="no database reachable; start one with `python localdb.py start`")
def test_pipeline_end_to_end(tmp_path, monkeypatch):
    """Runs the real stack on a few matches: validate, load (twice, to prove idempotency), aggregate."""
    import run
    from minicloud.cloud import Cloud
    from minicloud.template import load
    from simulator.simulate import simulate

    monkeypatch.chdir(ROOT)
    stack = load(ROOT / "infra" / "stack.yaml")
    db = run.db_connector(stack.resources["MetaDb"].props)
    conn = db()
    with conn.cursor() as cur:
        for t in run.TABLES:
            cur.execute(f"DROP TABLE IF EXISTS {t}")
    conn.commit()
    conn.close()

    cloud = Cloud(tmp_path / ".cloud", stack)
    cloud.deploy(db_connect=db)
    files = simulate(PATCHES, tmp_path / "sim", matches=16 * len(PATCHES), batch_size=40, seed=5)
    for f in files:
        cloud.store.put_object("tft-raw", f.relative_to(tmp_path / "sim").as_posix(), f.read_bytes())
    cloud.drain()
    # Re-deliver one staged file: the load log must make it a no-op.
    staged = cloud.store.list_objects("tft-staged")[0]
    cloud.store.put_object("tft-staged", staged.key, cloud.store.get_object("tft-staged", staged.key))
    cloud.drain()
    cloud.tick(60)
    cloud.drain()

    conn = db()
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*), COUNT(DISTINCT match_id) FROM matches")
        total, distinct = cur.fetchone()
        cur.execute("SELECT COUNT(*) FROM participants")
        boards = cur.fetchone()[0]
    conn.close()
    assert total == distinct and boards == total * 8
    assert len(cloud.dead_letters) == 1  # the corrupt file
    published = json.loads(cloud.store.get_object("tft-public", "site/tierlists.json"))
    assert set(published) == set(PATCHES) and published[FIRST]["champion"]
    assert all("contestRate" in r for r in published[FIRST]["comp"])
    lobby = json.loads(cloud.store.get_object("tft-public", "site/lobby.json"))
    assert sum(r["games"] for r in lobby[FIRST]["playstyles"]) == sum(r["games"] for r in lobby[FIRST]["carryContest"])
