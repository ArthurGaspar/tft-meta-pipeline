# ETL

Three functions deployed on minicloud, all in `functions/`, sharing helpers in `functions/common.py` (the equivalent of a Lambda layer). Each reads its configuration from environment variables set in `infra/stack.yaml`.

| Function | Trigger | Timeout / memory | Retries → DLQ | Reads | Writes |
| --- | --- | --- | --- | --- | --- |
| Validate | `tft-raw`, `raw/*.ndjson` | 60 s / 512 MB | 2 → `tft-failed-events` | raw object, `STATIC_DATA` | `tft-staged`, `tft-quarantine` |
| Load | `tft-staged`, `*.ndjson` | 120 s / 1024 MB | 2 → `tft-failed-events` | staged object, `STATIC_DATA` | MySQL match tables, `load_log` |
| Aggregate | `rate(1 hour)` | 300 s / 1024 MB | 0, no DLQ | MySQL, `STATIC_DATA` | `entity_stats`, `tft-public/site/*.json` |

`STATIC_DATA` points to `data/set18.json`; `common.static_data()` loads and indexes it once per warm environment (`lru_cache`).

## Validate

`functions/validate/handler.py`. One invocation per raw file.

- The body is decoded as UTF-8 **without** catching errors: a file that is not text fails the invocation, is retried twice, and ends in the dead-letter queue. That is the intended path for unreadable files.
- Each non-blank line is parsed and checked by `problems(match, data)`. Valid lines go to `tft-staged` under the same key with `raw/` → `staged/`. Invalid lines go to `tft-quarantine` (`raw/` → `quarantine/`) as one JSON record per line: `{source, line, match_id, reasons}` (or `{source, line, reasons: ["malformed_json"], raw}` with the first 200 characters).
- One bad record never blocks its neighbours; a file can produce both outputs.

### Rejection reasons

| Reason | Meaning |
| --- | --- |
| `malformed_json` | The line is not JSON (e.g. a truncated upload) |
| `invalid_schema` | Not an object, wrong container types, or any field Load consumes is missing, mistyped or out of column range (`_loadable`) |
| `missing_field` | No `info`, `metadata.match_id` or `participants`; or `match_id` empty / longer than 32 |
| `wrong_set` | `tft_set_number` differs from the static data's set |
| `unknown_version` | `game_version` doesn't look like `Version <major>.<minor>.…` |
| `unknown_patch` | Readable client version that the static data's `patches` map doesn't know (refresh static data) |
| `wrong_lobby_size` | Not exactly 8 participants |
| `missing_placement` | A participant has no placement |
| `invalid_placements` | Placements are not exactly 1..N |
| `duplicate_player` | Repeated `puuid` within the match |
| `unknown_champion` / `unknown_item` / `unknown_augment` / `unknown_trait` | An ID absent from the static data |
| `duplicate_in_file` | A valid record whose `match_id` already appeared earlier in the same file |

`_loadable` exists so nothing that would make an `INSERT` fail (e.g. a `level` of 300 in a `TINYINT`) reaches the staged bucket; it mirrors the column types in `sql/schema.sql`. Keep the two in sync.

## Load

`functions/load/handler.py`. One transaction per staged file.

### Idempotency

1. **File level**: if `load_log` already has `(source_key, etag)`, return immediately. Re-delivering the same object (same MD5) is a no-op.
2. **Match level**: match IDs already in `matches` are dropped before inserting, so a match that arrives in two different files is stored once. All inserts are also `INSERT IGNORE`.
3. The `load_log` row is written in the same transaction as the data; any exception rolls back everything and re-raises (so minicloud retries).

### Derived columns

Computed per board from the record alone (`functions/common.py`):

| Column | Function | Rule |
| --- | --- | --- |
| `matches.patch` | `patch_name` | `"Version 16.21.…"` → client `16.21` → set patch via `data["patches"]` (e.g. `18.5`) |
| `participants.comp_key`, `carry_id` | `comp_of` | `"<strongest active trait>|<carry>"`; the carry is the unit with most items (ties: rarity, star, ID). Trait ties: higher tier, more units, name |
| `participants.playstyle` | `playstyle_of` | level ≥ 9 → `fast9`; else any 3-star unit with rarity ≤ 2 (cost 1–3) → `reroll`; else `fast8` |
| `participants.carry_contest` | `holders_in_lobby` | other boards in the lobby holding the carry's base champion |
| `participant_units.contested` | `holders_in_lobby` | other boards holding this unit's base champion |

Champion forms share a pool by display name prefix (`champion_base`: `"Lux (Fae)"` → `"Lux"`).

Inserts run in `INSERTS` order (matches → participants → units → items → traits → augments) so foreign keys are satisfied.

## Aggregate

`functions/aggregate/handler.py`. Recomputes everything from scratch on every run (`DELETE FROM entity_stats` then insert).

### Entities

Per patch, five kinds, each a set of distinct `(match_id, puuid, entity)` pairs joined to the board's placement:

| Kind | Entity ID |
| --- | --- |
| `champion` | `champion_id` (counted once per board even if duplicated) |
| `item` | `item_id` (once per board) |
| `augment` | `augment_id` |
| `trait` | `"<trait_id>:<tier>"`, active breakpoints only |
| `comp` | `comp_key` |

For each: `games`, `playRate` (games / boards in the patch), `avgPlacement`, `top4Rate`, `winRate`, and the placement variance (internal, used for patch changes).

### Method

| Constant | Value | Use |
| --- | --- | --- |
| `PRIOR_GAMES` | 50 | **Score** = average placement shrunk towards 4.5 by 50 pseudo-games: `(avg·n + 4.5·50) / (n + 50)` |
| `MIN_GAMES` | 40 | Minimum games to receive a tier, to enter the tier's spread, and (on both sides) to be compared across patches |
| `TIERS` | S ≤ −1.2, A ≤ −0.4, B ≤ 0.4, C ≤ 1.2, else D | Bounds on `z = (score − 4.5) / sd`, where `sd` is the RMS of `score − 4.5` over ranked entities **of the same kind and patch** |
| `Z_SIGNIFICANT` | 3.0 | A patch-to-patch shift is flagged when `|Δ avg| / √(var₁/n₁ + var₂/n₂) ≥ 3` |
| `BUILD_MIN_GAMES` | 25 | Minimum games for a champion+item pair in `builds.json` |

Lower score is better (placements run 1–8). Entities under `MIN_GAMES` keep `tier: null` and sort after ranked ones.

Patch changes compare **consecutive** patches only, for `champion`, `item` and `trait` (per breakpoint). The threshold is deliberately strict because ~100 entities are tested at once; it is not a formal multiple-comparison correction.

**Builds** pool all patches: per champion, the top 3 items by shrunk score among pairs with ≥ 25 games.

**Contest**: for comps (by carry) and champions, `contestRate` (share of games where another board held it) and average placement contested vs uncontested.

**Lobby dynamics** (`lobby.json`): per patch, placement by `playstyle`, by final `level`, by carry contest (capped at "3+", with average star and 3-star rate), and unit 2★/3★ rates by contest. Playstyles intentionally receive **no tier**: they are read from the final board and only survivors reach level 9, so Fast 9 would rank first on survivorship alone.

### Outputs

Written to `tft-public` under `site/` (compact JSON): `meta.json`, `tierlists.json`, `patch-changes.json`, `builds.json`, `lobby.json`. Shapes are in the [data reference](data-reference.md#published-json).
