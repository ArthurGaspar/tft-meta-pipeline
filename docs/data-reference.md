# Data reference

## Static game data

Produced by `python -m simulator.static_data` from [Community Dragon](https://raw.communitydragon.org/) and committed under `data/`.

**Patches vs client versions.** Riot names TFT patches by set (`18.1`, `18.2`, …), but game data and the match API are versioned by the game client (`16.17`, `16.18`, …). The set's first client version with its full roster becomes `18.1`; each later client version is the next patch. Walking back stops when a version has fewer than 80% of the largest roster seen.

| File | Contents |
| --- | --- |
| `data/set18/<patch>.json` | Snapshot of the set as shipped in that patch, with `patch` and `client` fields. **Never overwritten** unless `--refresh` |
| `data/set18.json` | Copy of the latest snapshot plus `patches: {client version: patch}`, the map Validate/Load use |

Snapshot shape:

```jsonc
{
  "set": 18, "mutator": "TFTSet18", "patch": "18.5", "client": "16.21",
  "champions": [{ "id", "name", "cost", "traits": [traitId], "icon",
                  "stats": { "hp", "ad", "as", "armor", "mr", "range", "mana", "startMana", "crit", "critMult" },
                  "spell": { "name", "desc", "vars": { "<Name>": [0, s1, s2, s3, …] } } }],
  "traits":    [{ "id", "name", "breakpoints": [n…], "icon", "desc", "effects": [{ "minUnits", "values": {…} }] }],
  "items":     [{ "id", "name", "icon", "stats": {…}, "effects": {…}, "desc" }],   // completed items only, no emblems
  "augments":  [{ "id", "name", "icon" }]                                           // stable sample of 72
}
```

Notes: only shop champions (cost 1–5, with traits) are kept; hashed variable names are decoded with FNV-1a against `@Var@` placeholders in the description, undecodable ones dropped; icons are external Community Dragon URLs (`latest/`), which may change. Options: `--cache DIR` (read `DIR/<client>.json` instead of downloading), `--refresh`, `--mutator`.

## Raw match records

One JSON object per line (NDJSON), in the shape of Riot's TFT match API (only the fields the pipeline uses):

```jsonc
{
  "metadata": { "data_version": "6", "match_id": "SIM1_0000042", "participants": [puuid…] },
  "info": {
    "game_datetime": 1790001554000,          // ms since epoch
    "game_length": 1903.27,                  // seconds
    "game_version": "Version 16.21.507 (simulated)",
    "queue_id": 1100,
    "tft_set_number": 18,
    "participants": [{
      "puuid", "placement", "level", "gold_left", "last_round", "total_damage_to_players",
      "augments": [augmentId],
      "traits": [{ "name": traitId, "num_units", "tier_current", "tier_total", "style" }],
      "units":  [{ "character_id", "itemNames": [itemId], "rarity": cost - 1, "tier": star }]
    }]
  }
}
```

Bucket keys: `raw/patch=<patch>/batch-NNNN.ndjson` → `staged/…` / `quarantine/…`.

## SQL schema

`sql/schema.sql`, compatible with MySQL 8 and MariaDB 10.6+. Applied by minicloud at deploy (`CREATE TABLE IF NOT EXISTS`); `run.py` drops all tables first.

```
matches (match_id PK) ─┬─< participants (match_id, puuid) ─┬─< participant_units (…, slot) ──< unit_items (…, slot, item_slot)
                       │                                    ├─< participant_traits (…, trait_id)
                       │                                    └─< participant_augments (…, pick_order)
load_log (source_key, etag)        entity_stats (kind, entity_id, patch)
```

All child foreign keys are `ON DELETE CASCADE`.

| Table | Key columns | Notes |
| --- | --- | --- |
| `matches` | `match_id` | `patch` (set patch name, indexed), `game_datetime`, `game_length_s`, `source_key` (staged file) |
| `participants` | `match_id, puuid` | `placement`, `level`, `gold_left`, `last_round`, `damage`, `comp_key` (indexed), `carry_id`, `playstyle`, `carry_contest` |
| `participant_units` | `+ slot` | `champion_id` (indexed), `star`, `cost`, `contested` |
| `unit_items` | `+ slot, item_slot` | `item_id` (indexed) |
| `participant_traits` | `+ trait_id` | `num_units`, `tier` (0 = inactive) |
| `participant_augments` | `+ pick_order` | `augment_id` (indexed) |
| `load_log` | `source_key, etag` | One row per loaded staged file; makes re-delivery a no-op |
| `entity_stats` | `kind, entity_id, patch` | Aggregate output: `games`, `play_rate`, `avg_placement`, `top4_rate`, `win_rate`, `score`, `tier` (NULL if unranked) |

Column ranges here are mirrored by Validate's `_loadable` check.

## Published JSON

Everything the site reads lives in `web/public/data/`. TypeScript types are in `web/src/data.ts` (pipeline outputs) and `web/src/sim/core.ts` (`GameData`). **Change both sides together.**

| File | Written by | Type | Contents |
| --- | --- | --- | --- |
| `meta.json` | Aggregate | `Meta` | `generatedAt`, `set`, `patches` (ordered), `matches`, `boards` per patch, `method` constants |
| `tierlists.json` | Aggregate | `TierLists` | `{patch: {kind: Entry[]}}`, sorted ranked-first then by score. `Entry`: id, name, icon, games, playRate, avgPlacement, top4Rate, winRate, score, tier, plus `cost` (champions), `carry` (comps), `contestRate`/`avgContested`/`avgUncontested` |
| `patch-changes.json` | Aggregate | `Change[]` | kind, id, name, icon, from, to, before, after, delta, z, significant; sorted by z |
| `builds.json` | Aggregate | `Record<championId, Build[]>` | Up to 3 items per champion, all patches pooled |
| `lobby.json` | Aggregate | `Lobby` | Per patch: `playstyles`, `levels`, `carryContest`, `unitContest` |
| `pipeline.json` | `run.py` | `Pipeline` | `cloud.report()` + `stack` state, `quality` (quarantine count and reasons), `rawFiles`, `wallSeconds` |
| `truth-check.json` | `run.py` | `TruthCheck` | Spearman per patch/kind with points, patch-change detection, playstyle confusion, positioning thirds |
| `game.json` | simulator | `GameData` | Champions/traits/items (latest patch) and per patch: hidden powers, sample boards, Riot's changes, shipped stats/spell vars/trait and item effects |

`load<T>(name)` fetches `${BASE_URL}data/<name>` and caches the promise; a failed fetch tells the user to run `python run.py`.

### Simulator-only: `truth.json`

Written to `.work/` and never published or given to the ETL:

```jsonc
{
  "patches":     { "<patch>": { "champion": {id: power}, "trait": {id: [power per breakpoint]}, "item": {…}, "augment": {…} } },
  "changes":     { "<patch>": { "champion": {id: shift}, "item": {…}, "trait": {id: mean shift} } },
  "riotChanges": { "<patch>": [{ "kind", "id", "name", "stat", "before", "after" }] },
  "boards":      { "<match_id>": { "<puuid>": ["fast8", 0.123] } },   // [economy plan, positioning skill]
  "mechanics":   { "counterFights", "counterWins", "adaptations", "starsLostToPool" }
}
```
