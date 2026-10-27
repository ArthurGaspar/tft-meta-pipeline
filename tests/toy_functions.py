"""Small handlers used by the minicloud tests."""

import os
import time
import urllib.parse

from minicloud import sdk

CALLS: list[str] = []


def copy_upper(event, context):
    """Reads the uploaded object and writes an upper-cased copy to OUT_BUCKET."""
    rec = event["Records"][0]["s3"]
    key = urllib.parse.unquote_plus(rec["object"]["key"])
    s3 = sdk.client("s3")
    body = s3.get_object(Bucket=rec["bucket"]["name"], Key=key)["Body"].read()
    s3.put_object(Bucket=os.environ["OUT_BUCKET"], Key=key, Body=body.upper())
    print(f"copied {key}")
    return {"key": key, "remainingMs": context.get_remaining_time_in_millis()}


def always_fails(event, context):
    CALLS.append(context.aws_request_id)
    raise ValueError("cannot parse this file")


def sleeps(event, context):
    time.sleep(2)


def on_schedule(event, context):
    CALLS.append(event["detail-type"])
