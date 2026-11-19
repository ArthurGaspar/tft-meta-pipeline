# Combat simulator

A seeded, real-time TFT fight on a hex board, in TypeScript, running in the browser (`web/src/sim/`) and in Node for checks (`web/scripts/check-sim.ts`). The Simulator page animates single fights and runs batches against opponents sampled from the simulated lobbies.

It is a model, not a replica of live TFT: Riot's Set 18 data ships ability descriptions but almost no ability numbers, so most spell values are estimates, and anything that happens between rounds is out of scope.

## Files

| File | Responsibility |
| --- | --- |
| `core.ts` | Shared types (`GameData`, `Unit`, `Battle`…), constants, the seeded RNG, hex geometry, damage/mitigation, shields, healing, mana, crowd control, DoTs, buffs, summons, targeting shapes |
| `engine.ts` | Building a battle (`createBattle`), the tick loop (`step`, `runToEnd`), active traits, per-patch data (`gameForPatch`), `autoPlace`, `sampleToUnits` |
| `spells.ts` | `SPELLS`: one ability per champion |
| `traits.ts` | `TRAITS`: trait effects for the active breakpoint |
| `items.ts` | `ITEMS`: item passives on top of plain stats |
| `HexBoard.tsx` | SVG rendering of the board |

## Data

The sim reads `web/public/data/game.json` (`GameData`, produced by `simulator/simulate.py:game_data`). Per patch it carries the hidden powers (the same balance the lobbies were played with), what Riot shipped in that patch (champion stats, spell variables, trait and item effects), Riot's changes from the previous patch, and sample boards to fight. `gameForPatch(game, patch)` overlays a patch's shipped values on the latest data, so an 18.1 fight uses 18.1 stats.

## Rules

| Constant | Value | Meaning |
| --- | --- | --- |
| `COLS × ROWS` | 7 × 8 | Board; team 0 owns rows 4–7, team 1 rows 0–3 |
| `TICK` | 0.05 s | Simulation step |
| `MAX_TIME` | 45 s | Fight ends as a draw |
| `OVERTIME_START` / `OVERTIME_RAMP` | 30 s / +25% per s | Damage ramp to force an end |
| `MOVE_TIME` | 0.5 s | Time to move one hex |
| `MANA_PER_ATTACK` | 10 | Mana per auto attack |
| `STAR_HP` / `STAR_AD` | 1, 1.8, 3.24, 5.8 / 1, 1.5, 2.25, 3.4 | Star multipliers |

Units start from Community Dragon base stats, scaled by star level and the patch's hidden power. Each tick a unit picks a target, walks until in range, attacks, gains mana, and casts when full.

Damage order (`core.ts:damage`): Damage Amp and Vulnerable (and overtime) → Armor or Magic Resist (after Sunder or Shred) → Durability → shields → health.

**Determinism**: every random choice goes through `b.rng()`, the battle's `seeded(seed)` generator. Never call `Math.random()` inside `sim/`; `check:sim` replays fights and compares them.

## Writing a spell

Entries in `SPELLS` are keyed by champion **name**; forms like `"Lux (Fae)"` fall back to the base name (`spellFor`).

```ts
Camille: {
  vars: { ADDamage: pct(1, 0.9), Shield: shd(1, 0.8), ShieldDuration: flat(4) },
  cast: (c) => {
    physical(c.b, c.u, c.t, c.p("ADDamage"));
    shield(c.b, c.u, c.p("Shield"), c.v("ShieldDuration"));
  },
},
```

- `vars` declares every value the spell uses in Riot's format `[0, 1★, 2★, 3★, …]`. Estimate helpers size values by cost: `mag` (magic), `pct` (% AD), `shd` (shields), `flat`. **If the game data carries a value under the same name, the real one wins** automatically; `spellCoverage` reports which values are real vs estimated so the UI can label them.
- In `cast`/`setup`: `c.b` battle, `c.u` caster, `c.t` target. `c.v(name)` returns the value for the caster's star level; `c.p(name)` also scales by the patch's hidden power. Use `p` for damage, healing and shields, `v` for durations, counts and thresholds.
- Other fields: `setup` (passives at combat start), `passiveOnly` (never gains mana), `channel` (seconds standing still), `notModeled` (parts that happen outside a fight).

Use the helpers in `core.ts` (`physical`, `magic`, `area`, `inLine`, `bestCluster`, `stun`, `burn`, `schedule`, `every`, …) rather than mutating HP directly, so hooks, shields and logs stay consistent.

## Traits and items

- **Traits** (`TRAITS`, keyed by trait name): `apply(c)` with `c.members` (champions with the trait), `c.team`, `c.tier`, `c.val(name)` (a magnitude for the active breakpoint, scaled by hidden power) and `c.raw(name)` (thresholds, durations, counts as Riot ships them).
- **Items** (`ITEMS`, keyed by item name): plain stats are applied by the engine for every item; `apply(c)` adds the passive using `c.e(name)` for Riot's effect values. Fields named `Pct`/`Percent` are whole percents and are divided by 100 in the definition.
- Either can declare `notModeled: "<why>"` instead of `apply` when its effect lies outside a single fight (shops, rewards, essence, extra team slots).

## `npm run check:sim`

Requires `web/public/data/game.json`, so run `python run.py` first. It checks:

- **Rules**: armor and Durability mitigation, shields, burns, stuns, overtime, a trait (Juggernaut) and an item (Bramble Vest) with Riot values.
- **Coverage**: every champion has an ability; every trait and item is modeled or says why not; every ability runs in a fight without crashing; every champion with an active ability casts it.
- **Patches**: a patch fights with its own stats.
- **Whole fights**, per patch: the same seed replays the same fight; fewer than 5% of fights reach the timer; the board that placed better in its lobby wins more than 60% of fights; front-to-back layouts beat the same boards reversed; each fight takes under 10 ms.

Any `FAIL` line exits non-zero and fails CI.
