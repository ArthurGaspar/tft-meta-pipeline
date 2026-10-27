"""Object storage in the style of S3: buckets of keyed objects on the local disk.

Writes publish an event with the same shape as an S3 event notification, so a
function written for these events reads `Records[0].s3.object.key` exactly as
it would on AWS. Keys are URL-encoded in events, as S3 does.
"""

import hashlib
import json
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


class NoSuchBucket(KeyError):
    pass


class NoSuchKey(KeyError):
    pass


@dataclass
class ObjectInfo:
    key: str
    size: int
    etag: str
    last_modified: str


def s3_event(region: str, bucket: str, info: ObjectInfo, event_name: str = "ObjectCreated:Put") -> dict:
    """An S3 event notification with one record (see the AWS S3 event message structure)."""
    return {
        "Records": [
            {
                "eventVersion": "2.1",
                "eventSource": "minicloud:s3",
                "awsRegion": region,
                "eventTime": info.last_modified,
                "eventName": event_name,
                "s3": {
                    "s3SchemaVersion": "1.0",
                    "bucket": {"name": bucket, "arn": f"arn:minicloud:s3:::{bucket}"},
                    "object": {"key": urllib.parse.quote_plus(info.key, safe="/="), "size": info.size, "eTag": info.etag},
                },
            }
        ]
    }


class ObjectStore:
    """Buckets are directories; each object has a sidecar with its metadata."""

    META = ".meta"

    def __init__(self, root: Path, region: str, on_event: Callable[[dict], None] | None = None):
        self.root = root
        self.region = region
        self.on_event = on_event
        self.requests = {"PUT": 0, "GET": 0, "LIST": 0}

    def _bucket(self, bucket: str) -> Path:
        path = self.root / bucket
        if not path.is_dir():
            raise NoSuchBucket(bucket)
        return path

    def create_bucket(self, bucket: str) -> None:
        (self.root / bucket / self.META).mkdir(parents=True, exist_ok=True)

    def put_object(self, bucket: str, key: str, body: bytes) -> ObjectInfo:
        self.requests["PUT"] += 1
        path = self._bucket(bucket) / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        info = ObjectInfo(
            key=key,
            size=len(body),
            etag=hashlib.md5(body).hexdigest(),
            last_modified=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        )
        meta = self._bucket(bucket) / self.META / (key + ".json")
        meta.parent.mkdir(parents=True, exist_ok=True)
        meta.write_text(json.dumps(info.__dict__), encoding="utf-8")
        if self.on_event:
            self.on_event(s3_event(self.region, bucket, info))
        return info

    def get_object(self, bucket: str, key: str) -> bytes:
        self.requests["GET"] += 1
        path = self._bucket(bucket) / key
        if not path.is_file():
            raise NoSuchKey(f"s3://{bucket}/{key}")
        return path.read_bytes()

    def list_objects(self, bucket: str, prefix: str = "") -> list[ObjectInfo]:
        self.requests["LIST"] += 1
        base = self._bucket(bucket)
        out = []
        for meta in sorted((base / self.META).rglob("*.json")):
            key = meta.relative_to(base / self.META).as_posix()[: -len(".json")]
            if key.startswith(prefix) and (base / key).is_file():
                out.append(ObjectInfo(**json.loads(meta.read_text(encoding="utf-8"))))
        return out

    def total_bytes(self) -> int:
        return sum(
            p.stat().st_size for p in self.root.rglob("*") if p.is_file() and self.META not in p.relative_to(self.root).parts
        )
