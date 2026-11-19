# CLAUDE.md

Guidance for Claude Code in this repository. Deeper reference lives in [`docs/`](docs/README.md).

## What this is

A TFT (Teamfight Tactics) side project: a Python simulator plays eight-player lobbies with a **hidden meta**, an ETL running on **minicloud** (a local AWS-style emulator in this repo) validates and loads the match files into MySQL/MariaDB, an aggregate step publishes tier lists as JSON, and a React + TypeScript site shows them alongside a browser combat simulator. Hidden values are used afterwards to grade how well the pipeline recovered them.

```
simulator/ -> .work/raw/*.ndjson -> [Validate] -> staged -> [Load] -> MySQL -> [Aggregate] -> site/*.json -> web/public/data -> web/
                                        └-> quarantine                               (hourly schedule)
run.py also writes truth-check.json (graded against .work/truth.json) and game.json (for the combat sim)
```

## Commands

Python 3.11+ (CI uses 3.12), Node 22.12+. Dev machine is Windows; activate the venv with `.venv\Scripts\Activate.ps1`.

```sh
pip install -r requirements.txt
python localdb.py start                    # private MariaDB in .db/, 127.0.0.1:3307 (set MARIADB_BIN if not on PATH)
python run.py                              # full run, 5,000 matches; --matches 1000 for a quick one; --seed N
python -m pytest -q                        # all Python tests
python -m pytest tests/test_etl.py -q -k shrink   # a single test
python -m minicloud validate infra/stack.yaml
python -m minicloud status | ls <bucket> [prefix] | logs <Function> | dlq   # inspect the last run's .cloud/
python -m simulator.static_data            # fetch new Set 18 patches from Community Dragon (network)
python localdb.py stop

cd web
npm ci
npm run check:sim                          # combat-sim rule checks; needs web/public/data/game.json from run.py
npm run build                              # tsc --noEmit + vite build
npm run dev
```

The DB integration test (`test_pipeline_end_to_end`) is **skipped silently** when no database is reachable; a green run without a DB did not exercise the ETL against SQL.

## Invariants — do not break these

- **The ETL never sees hidden values.** `functions/` must not read `.work/truth.json`, simulator internals, or anything derived from them. Only `run.py`'s `truth_check` and the browser `game.json` use hidden values. This separation is the point of the project.
- **Functions reach the platform only through `minicloud.sdk`** (`sdk.client("s3")`, `sdk.db_connect()`) and their environment variables from `infra/stack.yaml`. Handlers keep the Lambda signature `handler(event, context)`.
- **`run.py` and the integration test DROP every project table.** Never point `DB_*` at a database that holds anything else.
- **Stored patch snapshots are immutable.** `data/set18/<patch>.json` is never overwritten unless `--refresh` is passed; `data/set18.json` is a copy of the latest plus the client-version → patch map.
- **JSON contracts are mirrored in TypeScript.** Changing what Aggregate or `run.py` writes means updating `web/src/data.ts`; changing `game.json` (`simulator/simulate.py:game_data`) means updating `GameData`/`PatchMeta` in `web/src/sim/core.ts`.
- **New SQL tables** go in `sql/schema.sql` *and* in `run.py:TABLES` (children before parents, it is the drop order). Load inserts follow `INSERTS` order (parents first) for the foreign keys.
- **Every champion, trait, and item must be accounted for in the combat sim**: an entry in `SPELLS` / `TRAITS` / `ITEMS`, or a `notModeled` reason. `check:sim` fails otherwise.
- **Combat must stay deterministic for a seed.** Use `b.rng()` (the battle's seeded generator), never `Math.random()`, in `web/src/sim/`.
- Generated output is gitignored: `.cloud/`, `.work/`, `.db/`, `web/public/data/`, `web/dist/`. Don't commit it.

## Code style

- Python: no linter/formatter config; match the surrounding code. Long lines (up to ~170) are normal, type hints on signatures, `dict`/`list` builtins, f-strings. Modules open with a narrative docstring that explains *why*; comments are sparse and explain reasoning, not mechanics.
- Tuning constants are module-level `UPPER_CASE` with a comment (`PRIOR_GAMES`, `STRATEGIES`, `CONTEST_*`). Prefer changing a constant over hard-coding a number.
- SQL lives as string constants next to the code that runs it; parameterize values with `%s`.
- TypeScript is `strict` with `noUnusedLocals`/`noUnusedParameters`. React function components, no state library, hash routing in `App.tsx`. Data is fetched through `load<T>()` in `data.ts`.
- User-facing copy is plain, first-person, and honest about limits (the README's "Boundaries" tone). Don't overstate results.

## Commits

Conventional-ish prefixes with a scope: `feat(web): …`, `change(sim): …`, `add(core): …`, `update(sys): …`. CI (`.github/workflows/pages.yml`) runs template validation, pytest against MySQL 8.4, the pipeline, `check:sim`, and the build; pushes to `master` deploy to GitHub Pages.
