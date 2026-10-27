"""What function code imports to reach the platform, shaped like boto3.

    s3 = sdk.client("s3")
    body = s3.get_object(Bucket=b, Key=k)["Body"].read()
    s3.put_object(Bucket=b, Key=k, Body=data)

Inside an invocation the client talks to the cloud that is running the
function. The database connection reads DB_* environment variables, the way a
function would be configured to reach an RDS instance.
"""

import io
import os

import pymysql

_cloud = None


def bind(cloud) -> None:
    """Called by the platform; functions never call this."""
    global _cloud
    _cloud = cloud


class _S3Client:
    def __init__(self, store):
        self._store = store

    def get_object(self, *, Bucket: str, Key: str) -> dict:
        body = self._store.get_object(Bucket, Key)
        return {"Body": io.BytesIO(body), "ContentLength": len(body)}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes | str, ContentType: str | None = None) -> dict:
        data = Body.encode("utf-8") if isinstance(Body, str) else Body
        info = self._store.put_object(Bucket, Key, data)
        return {"ETag": f'"{info.etag}"'}

    def list_objects_v2(self, *, Bucket: str, Prefix: str = "") -> dict:
        objs = self._store.list_objects(Bucket, Prefix)
        return {
            "KeyCount": len(objs),
            "Contents": [{"Key": o.key, "Size": o.size, "ETag": f'"{o.etag}"', "LastModified": o.last_modified} for o in objs],
        }


def client(service: str):
    if service != "s3":
        raise ValueError(f"minicloud has no {service!r} client")
    if _cloud is None:
        raise RuntimeError("no cloud is bound; run the function through minicloud")
    return _S3Client(_cloud.store)


def db_connect():
    """A connection to the database configured in the function's environment."""
    return pymysql.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ["DB_USER"],
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ["DB_NAME"],
        charset="utf8mb4",
        autocommit=False,
    )
