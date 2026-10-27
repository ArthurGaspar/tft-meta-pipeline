import json
import random
from pathlib import Path

import pymysql
import pytest

from functions.aggregate.handler import assign_tiers, shrink, tier_of
from functions.common import comp_of, patch_of
from functions.validate.handler import problems
from run import spearman, truth_check
from simulator.simulate import build_world, dirty, play_match

ROOT = Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "data" / "set18.json").read_text(encoding="utf-8"))
INDEXED = {
    "set": DATA["set"],
    "champions": {c["id"]: c for c in DATA["champions"]},
    "traits": {t["id"]: t for t in DATA["traits"]},
    "items": {i["id"]: i for i in DATA["items"]},
    "augments": {a["id"]: a for a in DATA["augments"]},
}


@pytest.fixture(scope="module")
def match():
    world = build_world(DATA, random.Random(1))
    return play_match(world, "18.1", 0, random.Random(2), 1_790_000_000)


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
    assert patch_of("Version 18.2.507 (simulated)") == "18.2"
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
    assert out == {"trueChanges": 2, "flagged": 2, "flaggedAndReal": 1, "rightDirection": 1, "missed": ["champion:b"]}


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
    files = simulate(DATA, tmp_path / "sim", matches=80, batch_size=40, seed=5)
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
    assert set(published) == {"18.1", "18.2"} and published["18.1"]["champion"]
