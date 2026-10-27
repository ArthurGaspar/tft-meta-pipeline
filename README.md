# TFT Meta Pipeline

A serverless-style ETL that turns raw Teamfight Tactics matches into tier lists for comps, champions, items, augments
and traits. It runs on **minicloud**, a small imitation of AWS built for this project, so the whole thing costs nothing
and needs no cloud account.

**Live:** https://arthurgaspar.github.io/tft-meta-pipeline/

## What happens in a run

1. A **simulator** plays ~3,000 eight-player lobbies with the real Set 18 champions, traits, items and augments (static
   data from [Community Dragon](https://communitydragon.org)). Every piece has a hidden power, players lean towards what
   they believe is strong, and halfway through a balance patch secretly buffs and nerfs a few things. Matches are written
   as NDJSON in the shape of Riot's TFT match API, with ~2% deliberately broken records and one corrupt file.
2. The files are uploaded to the **raw bucket**. Each upload fires an S3-style event.
3. **Validate** checks every record (8 players, placements 1 to 8, known champions and items, a readable version...). Good
   records go to the staged bucket; bad ones go to quarantine with their reasons. A file that isn't text raises, is retried
   twice, and lands in the **dead-letter queue**.
4. Each staged file fires **Load**, which upserts the matches into normalized **MySQL** tables and labels every board with
   its comp ("Juggernaut Maokai": strongest trait plus the unit holding the most items). Loading is idempotent.
5. An hourly **schedule** runs **Aggregate**: average placement, top-4 and win rates per patch, small samples shrunk towards
   average, tiers, patch winners and losers, best items per champion. It publishes JSON to the public bucket, which the
   website reads.
6. A **truth check**, outside the pipeline, grades the tier lists against the simulator's hidden values.

## minicloud: the AWS pieces, imitated

| AWS | minicloud | What's faithful |
|---|---|---|
| CloudFormation | `infra/stack.yaml` + `minicloud/template.py` | Declarative resources, `${Resource.attr}` and `${env:VAR:default}` references, the whole template validated before anything is created, stack state recorded |
| S3 | `minicloud/storage.py` | Buckets, keys, ETags, and `ObjectCreated` events with the real notification shape (`Records[].s3.object.key`, URL-encoded) |
| S3 event notifications | `trigger` resources | Event-name, prefix and suffix filters |
| Lambda | `minicloud/functions.py` | `handler(event, context)`, a context object with request ID and remaining time, per-function environment variables, timeouts, cold vs warm starts, 1 ms billed duration |
| Lambda async invocation | `Cloud.drain()` | Two automatic retries, then the dead-letter queue |
| SQS dead-letter queue | `queue` resources | Failed events kept with the error and attempt count |
| EventBridge schedule | `schedule` resources | `rate(1 hour)` on a simulated clock, with the scheduled-event payload |
| CloudWatch Logs | `.cloud/logs/` | One stream per execution environment; `START`, `END` and `REPORT RequestId ... Billed Duration ... Init Duration` lines |
| boto3 | `minicloud/sdk.py` | `sdk.client("s3")` with `get_object`, `put_object` and `list_objects_v2`, same arguments and response shapes |
| RDS for MySQL | a real database | MariaDB locally, MySQL 8 in CI |
| Billing | `minicloud/pricing.py` | What the run would cost at AWS list prices |

Inspect a deployed stack like you would the console: `python -m minicloud status`, `ls tft-quarantine`, `logs Load`, `dlq`.

## Results

From one run of 2,941 valid matches (23,528 boards) in 76 seconds:

| Measure | Result |
|---|---|
| Function invocations | Validate 17 (3 failed: the corrupt file, 1 try + 2 retries), Load 14, Aggregate 1 |
| Data quality | 77 records quarantined across 7 reasons; 1 event dead-lettered |
| What the run would cost on AWS | about $0.0009 in Lambda and S3 requests; the database (~$11.68/month for a db.t4g.micro) is the only real cost |

**How well the tier lists recover the hidden meta** (Spearman rank correlation with hidden power; 1.0 is a perfect order):

| Category | Patch 18.1 | Patch 18.2 |
|---|---|---|
| Champions | 0.77 | 0.81 |
| Items | 0.93 | 0.96 |
| Augments | 0.94 | 0.92 |

Champions are the hardest to rank: strong units carry weak teammates, and 5-costs appear on late (better) boards.

**The balance patch:** it secretly changed 19 champions, items and traits. The pipeline flagged 6 significant shifts;
5 were real changes, all in the right direction. The other 14 changes were too small to tell from noise with ~1,500
matches per patch. The significance bar (|z| ≥ 3) is strict on purpose, since about a hundred things are compared at once.

## Run it locally

Needs Python 3.11+, Node 22+, and a MariaDB installation (only its binaries are used).

```bash
python -m venv .venv
.venv/Scripts/activate            # Windows; `source .venv/bin/activate` elsewhere
pip install -r requirements.txt

python localdb.py start           # private database in .db/ on port 3307; no admin rights needed
python run.py                     # the whole pipeline; ~75 s
python -m pytest                  # 21 tests, including an end-to-end run against the database

cd web && npm install && npm run dev
```

`localdb.py` looks for `mariadbd` on PATH; set `MARIADB_BIN` to its folder otherwise. To use a MySQL server you already
run instead, skip `localdb.py` and set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME`. To refresh the static game data
from Community Dragon: `python -m simulator.static_data`.

## Limitations

- The matches are simulated. That's what makes the truth check possible, but real lobbies have more structure (economy,
  positioning, contested units).
- Set 18 Lux has ten forms. A board holds one, and the tier lists rank each form separately.
- minicloud runs functions one at a time in one process. Real Lambda runs them concurrently in isolated environments.
- The icons are hot-linked from Community Dragon's `latest` folder and may change when the set rotates.
