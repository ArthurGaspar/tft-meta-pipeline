import json
import textwrap

import pytest

from minicloud.cloud import Cloud
from minicloud.template import TemplateError, load
from tests import toy_functions

STACK = """
stack: test
region: local-1
resources:
  In: {type: bucket, name: in-bucket}
  Out: {type: bucket, name: out-bucket}
  Dlq: {type: queue, name: failures}
  Upper:
    type: function
    handler: tests.toy_functions.copy_upper
    timeout: 5
    memory: 256
    environment: {OUT_BUCKET: "${Out.name}"}
  Broken: {type: function, handler: tests.toy_functions.always_fails, dead_letter: Dlq}
  Slow: {type: function, handler: tests.toy_functions.sleeps, timeout: 1, retries: 0}
  Tick: {type: function, handler: tests.toy_functions.on_schedule}
  ToUpper: {type: trigger, source: "${In}", target: Upper, prefix: "raw/", suffix: ".txt"}
  ToBroken: {type: trigger, source: "${In}", target: Broken, prefix: "bad/"}
  Every15: {type: schedule, expression: "rate(15 minutes)", target: Tick}
"""


@pytest.fixture
def cloud(tmp_path):
    path = tmp_path / "stack.yaml"
    path.write_text(STACK)
    c = Cloud(tmp_path / ".cloud", load(path))
    c.deploy()
    toy_functions.CALLS.clear()
    return c


def test_trigger_runs_function_with_s3_event(cloud):
    cloud.store.put_object("in-bucket", "raw/hello world.txt", b"hi")
    cloud.store.put_object("in-bucket", "raw/skip.csv", b"no")  # suffix doesn't match
    cloud.drain()
    assert cloud.store.get_object("out-bucket", "raw/hello world.txt") == b"HI"
    assert [i.function for i in cloud.invocations] == ["Upper"]
    assert cloud.invocations[0].init_ms is not None  # cold start


def test_second_invocation_is_warm_and_logged(cloud):
    for n in range(2):
        cloud.store.put_object("in-bucket", f"raw/{n}.txt", b"x")
    cloud.drain()
    assert [i.init_ms is None for i in cloud.invocations] == [False, True]
    log = next((cloud.root / "logs" / "Upper").rglob("*.log")).read_text()
    assert log.count("START RequestId") == 2 and "Init Duration" in log and "copied raw/1.txt" in log


def test_failures_are_retried_twice_then_dead_lettered(cloud):
    cloud.store.put_object("in-bucket", "bad/file", b"\x00")
    cloud.drain()
    assert len(toy_functions.CALLS) == 3
    [msg] = [json.loads(p.read_text()) for p in (cloud.root / "queues" / "failures").glob("*.json")]
    assert msg["attempts"] == 3 and "cannot parse" in msg["error"]
    assert msg["event"]["Records"][0]["s3"]["object"]["key"] == "bad/file"


def test_timeout_fails_the_invocation(cloud):
    inv = cloud.invoke("Slow", {})
    assert not inv.ok and "timed out after 1.00 seconds" in inv.error


def test_schedule_fires_once_per_period(cloud):
    cloud.tick(minutes=40)
    cloud.drain()
    assert toy_functions.CALLS == ["Scheduled Event", "Scheduled Event"]


def test_report_counts_invocations_and_cost(cloud):
    cloud.store.put_object("in-bucket", "raw/a.txt", b"a")
    cloud.drain()
    rep = cloud.report()
    assert rep["functions"]["Upper"]["invocations"] == 1
    assert rep["s3"]["requests"]["PUT"] == 2 and rep["cost"]["lambdaUsd"] >= 0


@pytest.mark.parametrize(
    "resources, message",
    [
        ("F: {type: function}", "missing handler"),
        ("B: {type: bucket, name: b, color: red}", "unknown color"),
        ("T: {type: trigger, source: nope, target: Nope}", "is not a bucket"),
        ("S: {type: schedule, expression: 'every day', target: X}", "rate(15 minutes)"),
        ("F: {type: function, handler: a.b, environment: {X: '${Missing.name}'}}", "unknown resource Missing"),
    ],
)
def test_template_validation(tmp_path, resources, message):
    path = tmp_path / "s.yaml"
    path.write_text("resources:\n" + textwrap.indent(resources, "  "))
    with pytest.raises(TemplateError, match=message.replace("(", r"\(").replace(")", r"\)")):
        load(path)


def test_env_references_use_defaults(tmp_path, monkeypatch):
    monkeypatch.delenv("NOT_SET_ANYWHERE", raising=False)
    path = tmp_path / "s.yaml"
    path.write_text("resources:\n  B: {type: bucket, name: '${env:NOT_SET_ANYWHERE:fallback}'}\n")
    assert load(path).resources["B"].props["name"] == "fallback"
