"""Function runtime in the style of AWS Lambda.

A function is a `module.path.handler` called as `handler(event, context)`. The
first invocation imports the module (a cold start, reported as Init Duration);
later ones reuse it while the "execution environment" is warm. Each invocation
runs with the function's environment variables, is cut off at its timeout, and
leaves START / END / REPORT lines in its log stream, as Lambda does.
"""

import contextlib
import importlib
import io
import math
import os
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class FunctionSpec:
    name: str
    handler: str
    timeout: int = 3
    memory: int = 128
    environment: dict[str, str] = field(default_factory=dict)
    retries: int = 2
    dead_letter: str | None = None


class Context:
    """The subset of the Lambda context object handlers commonly use."""

    def __init__(self, spec: FunctionSpec, region: str, request_id: str, log_stream: str, deadline: float):
        self.function_name = spec.name
        self.function_version = "$LATEST"
        self.invoked_function_arn = f"arn:minicloud:lambda:{region}:000000000000:function:{spec.name}"
        self.memory_limit_in_mb = spec.memory
        self.aws_request_id = request_id
        self.log_group_name = f"/minicloud/lambda/{spec.name}"
        self.log_stream_name = log_stream
        self._deadline = deadline

    def get_remaining_time_in_millis(self) -> int:
        return max(0, int((self._deadline - time.monotonic()) * 1000))


@dataclass
class Invocation:
    function: str
    request_id: str
    ok: bool
    result: Any = None
    error: str | None = None
    duration_ms: float = 0.0
    billed_ms: int = 0
    init_ms: float | None = None
    memory_mb: int = 128


class FunctionTimeout(Exception):
    pass


class Runtime:
    """Holds one warm execution environment per function."""

    def __init__(self, spec: FunctionSpec, region: str, log_root: Path):
        self.spec = spec
        self.region = region
        self.log_root = log_root
        self._handler = None
        self._stream: str | None = None

    def _cold_start(self) -> float:
        module_path, _, attr = self.spec.handler.rpartition(".")
        t0 = time.perf_counter()
        with self._environment():
            module = importlib.import_module(module_path)
            module = importlib.reload(module)  # a new environment starts from a fresh module
        self._handler = getattr(module, attr)
        day = datetime.now(timezone.utc).strftime("%Y/%m/%d")
        self._stream = f"{day}/[$LATEST]{uuid.uuid4().hex}"
        return (time.perf_counter() - t0) * 1000

    @contextlib.contextmanager
    def _environment(self):
        saved = {k: os.environ.get(k) for k in self.spec.environment}
        os.environ.update({k: str(v) for k, v in self.spec.environment.items()})
        try:
            yield
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def _log(self, lines: list[str]) -> None:
        path = self.log_root / self.spec.name / f"{self._stream}.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

    def recycle(self) -> None:
        """Drops the warm environment; the next invocation is a cold start again."""
        self._handler = None

    def invoke(self, event: dict) -> Invocation:
        init_ms = self._cold_start() if self._handler is None else None
        request_id = str(uuid.uuid4())
        deadline = time.monotonic() + self.spec.timeout
        ctx = Context(self.spec, self.region, request_id, self._stream, deadline)
        out = io.StringIO()
        box: dict[str, Any] = {}

        def run():
            try:
                with contextlib.redirect_stdout(out), self._environment():
                    box["result"] = self._handler(event, ctx)
            except BaseException as e:  # noqa: BLE001 - every failure is reported, as Lambda does
                box["error"] = e
                box["trace"] = traceback.format_exc()

        t0 = time.perf_counter()
        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(self.spec.timeout)
        duration = (time.perf_counter() - t0) * 1000
        if worker.is_alive():
            box["error"] = FunctionTimeout(f"Task timed out after {self.spec.timeout:.2f} seconds")
            box["trace"] = str(box["error"])
            self.recycle()  # a timed-out environment is not reused

        billed = math.ceil(duration)
        report = f"REPORT RequestId: {request_id}\tDuration: {duration:.2f} ms\tBilled Duration: {billed} ms\tMemory Size: {self.spec.memory} MB"
        if init_ms is not None:
            report += f"\tInit Duration: {init_ms:.2f} ms"
        lines = [f"START RequestId: {request_id} Version: $LATEST", *out.getvalue().rstrip().splitlines()]
        if "error" in box:
            lines.append(f"[ERROR] {box['trace'].rstrip()}")
        self._log(lines + [f"END RequestId: {request_id}", report])

        err = box.get("error")
        return Invocation(
            function=self.spec.name,
            request_id=request_id,
            ok=err is None,
            result=box.get("result"),
            error=None if err is None else f"{type(err).__name__}: {err}",
            duration_ms=round(duration, 2),
            billed_ms=billed,
            init_ms=None if init_ms is None else round(init_ms, 2),
            memory_mb=self.spec.memory,
        )
