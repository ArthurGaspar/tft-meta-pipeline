# Development

## Requirements

- Python 3.11+ (CI uses 3.12). Dependencies: `pymysql[rsa]`, `pyyaml`, `pytest`.
- Node 22.12+ (needed for `--experimental-strip-types` in `check:sim`).
- MariaDB binaries for the private local database, or any MySQL 8 / MariaDB 10.6+ server with a **dedicated** database.

## Setup

```sh
python -m venv .venv
# PowerShell: .venv\Scripts\Activate.ps1    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python localdb.py start
python run.py --matches 1000      # quick run; default is 5000
cd web && npm ci && npm run dev
```

### Database configuration

`infra/stack.yaml` reads `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, defaulting to the private instance from `localdb.py` (`127.0.0.1:3307`, database and user `tft`, password `tft-local`).

`localdb.py start` initializes `.db/data` on first use, starts `mariadbd` bound to localhost, and creates the database and user; it does not touch any system MariaDB service. Set `MARIADB_BIN` if the binaries are not on `PATH`. Startup errors land in `.db/data/*.err`. Stop with `python localdb.py stop`.

> `run.py` and the integration test drop every project table. Never point them at a database with other data.

## Tests

```sh
python -m pytest -q                         # everything
python -m pytest tests/test_minicloud.py -q
python -m pytest -q -k "truth_check"        # by name
```

| File | Covers |
| --- | --- |
| `tests/test_minicloud.py` | Triggers and S3 events, warm starts and logs, retries → DLQ, timeouts, schedules, reporting, template validation, env defaults. Uses `tests/toy_functions.py` |
| `tests/test_etl.py` | Validation rules and quarantine isolation, patch parsing, comp/playstyle labeling, lobby mechanics (placements, stars, pool, contest, knock-outs), patch shifts, shrinkage and tiers, Spearman and the truth check, and `test_pipeline_end_to_end` |

`test_pipeline_end_to_end` runs the real stack on a small simulation, re-delivers a staged file to prove idempotency, and checks the published JSON. It is **skipped** when the database from `stack.yaml` is unreachable, so a local green run may not have touched SQL. CI always has MySQL.

Web checks:

```sh
cd web
npm run check:sim     # needs public/data/game.json → run `python run.py` first
npm run build         # tsc --noEmit, then vite build into web/dist
```

## CI and deployment

`.github/workflows/pages.yml` runs on pushes to `master`, pull requests, and manual dispatch:

1. Start a MySQL 8.4 service (`tft`/`tft-ci` on port 3306) and export `DB_*`.
2. `pip install`, `python -m minicloud validate infra/stack.yaml`, `python -m pytest -q`.
3. `python run.py` (default 5,000 matches) to generate `web/public/data`.
4. `npm ci`, `npm run check:sim`, `npm run build`.
5. On non-PR events, upload `web/dist` and deploy to GitHub Pages.

The site is built with `base: "./"` and hash routing, so it works from any Pages sub-path. `web/index.html` also loads an external `ads.js` from the profile repository (`arthurgaspar.github.io/arthurgaspar/ads/ads.js`).

## Recipes

### Add a new patch

1. `python -m simulator.static_data` (or `--cache DIR` with downloaded `<client>.json` files). New patches are stored as `data/set18/<patch>.json`; existing ones are left untouched; `data/set18.json` is refreshed with the latest data and the client → patch map.
2. Review the diff of the new snapshot. New champions, traits or items need entries in `web/src/sim/` (`SPELLS`, `TRAITS`, `ITEMS`, or `notModeled`).
3. `python run.py`, `python -m pytest -q`, `cd web && npm run check:sim`.

Matches whose client version is missing from the map are quarantined as `unknown_patch`, which is the signal to refresh.

### Add a validation rule

1. Add the check to `functions/validate/handler.py:problems` with a new `snake_case` reason (or to `_loadable` if it protects a column range, which reports `invalid_schema`).
2. Add a test in `tests/test_etl.py`; if the simulator should produce it, add a defect to `simulator/simulate.py:dirty`.
3. The reason shows up automatically in `pipeline.json` → `quality.reasons` and on the Pipeline page.

### Add a column or table

1. Edit `sql/schema.sql` (keep it MySQL 8 + MariaDB compatible).
2. New table: add it to `run.py:TABLES`, children before parents.
3. Populate it in `functions/load/handler.py` (`rows_for` + `INSERTS`, parents first).
4. If it comes from a record field, make Validate's `_loadable` enforce the column's range.

### Publish a new statistic

1. Compute it in `functions/aggregate/handler.py` from the database only, and add it to an existing file or a new `site/<name>.json` in the publish loop.
2. Add its type to `web/src/data.ts` and read it with `load<T>("<name>.json")`.
3. If it needs hidden values to make sense, compute it in `run.py:truth_check` instead.

### Add a dashboard page

Create `web/src/<Page>.tsx` exporting a component, use `useAsync` + `load` from `ui.tsx`/`data.ts`, and register it in the `PAGES` list in `web/src/App.tsx` with a lazy import and a `#/hash`.

### Tune the experiment

Simulation behaviour is controlled by the constants at the top of `simulator/simulate.py` and `simulator/patches.py`; ranking method by `PRIOR_GAMES`, `MIN_GAMES`, `TIERS`, `Z_SIGNIFICANT`, `BUILD_MIN_GAMES` in Aggregate. After a change, rerun and compare `truth-check.json`; update any figures quoted in the top-level README, which records a specific run.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Site says `… answered 404. Run python run.py` | `web/public/data/` is empty; run the pipeline |
| `check:sim` cannot read `game.json` | Same; it reads `web/public/data/game.json` |
| Integration test skipped | No database reachable at the `DB_*` / default settings |
| `the server didn't come up` from `localdb.py` | Port 3307 in use or bad data dir; check `.db/data/*.err` |
| `no patches in data/set18` | Snapshots missing; restore from git or run `python -m simulator.static_data` |
| Many `unknown_patch` quarantines | Static data is older than the matches' client version |
| One dead letter after every run | Expected: the simulator writes `batch-corrupt.ndjson` on purpose |
| Inspect a failure | `python -m minicloud logs Validate`, `python -m minicloud dlq`, `python -m minicloud ls tft-quarantine` |
