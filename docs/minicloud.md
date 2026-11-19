# minicloud

A small, local, single-process emulator of the AWS services this pipeline would use. It exists so the ETL can be written against real cloud contracts (S3 event payloads, `handler(event, context)`, retries, dead-letter queues, schedules) and run on a laptop or in CI.

| Module | Responsibility |
| --- | --- |
| `template.py` | Parses and validates stack templates; resolves references |
| `cloud.py` | Control plane: `deploy()`, event routing, `drain()`, `tick()`, `report()` |
| `functions.py` | Lambda-style runtime: cold/warm starts, env vars, timeouts, logs |
| `storage.py` | S3-style object store on disk, emits event notifications |
| `sdk.py` | What function code imports, shaped like boto3 |
| `pricing.py` | Illustrative AWS cost estimate for a run |
| `__main__.py` | CLI to inspect a deployed stack |

## Stack templates

YAML with a top-level `resources` map, plus optional `stack` (name) and `region` (default `local-1`). `infra/stack.yaml` is the real stack; `tests/test_minicloud.py` has a minimal one.

### Resource types

| Type | Required | Optional |
| --- | --- | --- |
| `bucket` | `name` | |
| `queue` | `name` | |
| `database` | `engine`, `host`, `port`, `name`, `user` | `password`, `schema` |
| `function` | `handler` | `timeout` (default 3, 1–900 s), `memory` (default 128, 128–10240 MB), `environment`, `retries` (default 2), `dead_letter`, `description` |
| `trigger` | `source`, `target` | `events` (default `["ObjectCreated:*"]`), `prefix`, `suffix` |
| `schedule` | `expression`, `target` | `description` |

Unknown types, missing or unknown properties, and bad cross-references fail the **whole** template before anything is created. Cross-resource checks: a trigger's `source` must be a bucket name and its `target` a function; a schedule's target must be a function and its expression `rate(N minute|minutes|hour|hours)`; a function's `dead_letter` must be a queue in the stack.

### References

- `${Resource.attr}` resolves to another resource's property. `${Resource}` or `${Resource.name}` gives its `name`.
- A value that is *exactly* one reference to a non-string property keeps its type (e.g. a numeric port).
- `${env:NAME}` reads an environment variable and fails if unset; `${env:NAME:default}` falls back to `default` (an empty default is allowed: `${env:NAME:}`).
- Circular references are rejected.
- Standard YAML anchors work (`environment: &db` / `<<: *db` in `infra/stack.yaml`).

Validate without deploying: `python -m minicloud validate infra/stack.yaml`.

## Deployment

`Cloud(root, stack).deploy(db_connect=…)` creates, per resource type:

- **bucket**: a directory under `<root>/s3/<name>/` with a `.meta/` sidecar folder.
- **queue**: `<root>/queues/<name>/`.
- **database**: runs the `schema` file statement by statement (split on `;`) through `db_connect()`. `deploy` raises if a database resource exists and no `db_connect` was passed.
- **function**: a `Runtime` holding one execution environment.

It writes `<root>/state.json` with a fake ARN-style physical ID and `CREATE_COMPLETE` for each resource. Constructing a `Cloud` also binds it to `minicloud.sdk`, so function code reaches this instance.

## Events and delivery

1. `ObjectStore.put_object` writes the body and an `ObjectInfo` sidecar (`key`, `size`, MD5 `etag`, `last_modified`), then emits one S3 event record (`eventName: ObjectCreated:Put`, key URL-encoded as S3 does).
2. `Cloud._route` matches the record against every trigger (bucket, prefix, suffix, event name with `:*` wildcards) and **appends** a pending invocation to an in-memory queue. Nothing runs during the put.
3. `drain()` pops invocations FIFO and runs them. A failure is re-queued (at the back) until `retries` is exhausted, then dead-lettered: the message (`function`, `attempts`, `error`, original `event`, …) is kept in `cloud.dead_letters` and, if the function has a `dead_letter` queue, written to `<root>/queues/<queue>/<id>.json`.
4. `drain()` raises after 10,000 invocations to catch a function that re-triggers itself.

`cloud.invoke(function, event)` is a synchronous call: no retries, the caller gets the `Invocation`.

## Schedules

`tick(minutes)` advances a simulated clock (starting 2026-01-01 UTC) and queues one EventBridge-style scheduled event (`detail-type: Scheduled Event`) for each period that came due. Call `drain()` afterwards to run them.

## Function runtime

- `handler: module.path.func` is imported on the first invocation (a **cold start**, reported as `Init Duration`); the module is reloaded so a new environment starts fresh. Later invocations reuse it (**warm**).
- The function's `environment` is applied to `os.environ` during import and each invocation, then restored.
- Each invocation runs on a daemon thread joined with the timeout. On timeout the invocation fails with `FunctionTimeout` and the environment is recycled (the thread itself cannot be killed; it is abandoned).
- `stdout` is captured into the log stream `<root>/logs/<Function>/<yyyy/mm/dd>/[$LATEST]<id>.log` with `START`, `END`, and `REPORT` lines (duration, billed ms rounded up, memory, init duration).
- `context` offers `function_name`, `aws_request_id`, `memory_limit_in_mb`, `log_group_name`, `log_stream_name`, `invoked_function_arn`, and `get_remaining_time_in_millis()`.

## SDK (function side)

```python
from minicloud import sdk

s3 = sdk.client("s3")                           # only "s3" exists
body = s3.get_object(Bucket=b, Key=k)["Body"].read()
s3.put_object(Bucket=b, Key=k, Body=data, ContentType="application/json")   # returns {"ETag": '"…"'}
s3.list_objects_v2(Bucket=b, Prefix="site/")

conn = sdk.db_connect()                         # pymysql, from DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME, autocommit off
```

Writes through the SDK emit events like any other put, which is how Validate's staged output triggers Load.

## Reporting and cost

`cloud.report()` returns per-function invocations, errors, cold starts, duration, billed ms and GB-seconds; dead letters; S3 request counts and bytes stored; and `pricing.estimate(...)`. The prices in `pricing.py` are approximate us-east-1 on-demand list prices hard-coded in source, ignoring the free tier. They are illustrative, not billing.

## CLI

Run from the repository root after `python run.py` (it reads `.cloud/`):

```sh
python -m minicloud status                  # resources, types, status, physical IDs
python -m minicloud ls tft-quarantine       # objects in a bucket, optional prefix
python -m minicloud logs Load               # newest log stream of a function
python -m minicloud dlq                     # dead-lettered messages
python -m minicloud validate [template]     # works without a deployment
```

## What it does not model

Concurrency or parallel workers; network, IAM or isolation between functions (they share one Python process and its imports); at-least-once delivery semantics beyond explicit re-puts; S3 consistency, versioning, multipart or deletes; real SQS/EventBridge APIs; cron expressions; billing. The database is real (MariaDB/MySQL); minicloud only applies the schema and passes connection settings.
