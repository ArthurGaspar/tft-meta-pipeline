# Lobby simulator

`simulator/simulate.py` generates the matches the pipeline ingests. It is a controlled experiment: it plays lobbies with a **hidden meta**, writes only what Riot's match API would show, and keeps the answer key in `truth.json` so the rankings can be graded. Modeling choices are in named constants at the top of the module; changing them changes the experiment, not the pipeline.

Entry point: `simulate(snapshots, out_dir, matches=5000, batch_size=250, seed=18, dirty_share=0.02)`. The whole run is reproducible from the seed (`random.Random(seed)`).

## The hidden meta

`build_world(snapshots, rng)` builds one `Meta` per real patch, oldest first:

- **First patch**: champion power `0.3 × cost + N(0, 0.35)`; trait power per breakpoint `(i+1) × 0.3 + N(0, 0.2)`; item `N(0, 0.3)`; augment `N(0, 0.35)`. Riot publishes stats, not strength, so the starting values are random.
- **Each later patch** copies the previous one and applies `simulator/patches.py:power_shifts(before, after)`.

### Patch changes (`patches.py`)

`changes_between` diffs two snapshots stat by stat, the way patch notes read: champion cost and stats, spell variables, trait values per breakpoint, item effects. `power_shifts` turns that into hidden-power deltas:

| Change | Shift |
| --- | --- |
| Champion stat | `CHAMPION_PER_REL × 0.3·cost × weight × relative change`, weights in `CHAMPION_STATS` (`mana` negative: higher cost is a nerf). `startMana` uses `0.6 × Δ / mana` |
| Spell value | `SPELL_PER_REL × 0.3·cost × mean relative change` over star levels 1–3 |
| Trait value | `TRAIT_PER_REL × mean signed relative change`, per breakpoint |
| Item effect | `ITEM_PER_REL × mean signed relative change` |

Names in `LOWER_IS_BETTER` (durations, thresholds, intervals) flip the sign. **How much a stat change matters is a modeling choice**, not Riot data.

## Playing a lobby

`play_match(world, patch, …)`:

1. **Economy plan** per player, drawn from `STRATEGIES` by `share`: `reroll` (0.25), `fast8` (0.55), `fast9` (0.20). A plan sets the final-level distribution, 3-star chances per cost, the carry's maximum cost, a strength offset (`tempo`) per stage, the level reached by each stage, and leftover gold.
2. **Scouting and picks** (`pick_units`), players in turn: choose a primary trait by softmax over *perceived* power (truth + `N(0, 0.4)`, `TEMPERATURE` 0.8), discounted by `CONTEST_AVOID` per earlier player on it; then fill `level` slots favouring the primary trait, existing synergies, the plan's cost range, and champions others aren't on. Multi-form champions (Set 18 Lux) share one champion's pick chance.
3. **Stars** (`roll_stars`): 2★/3★ chances by cost, plan and level, multiplied by `CONTEST_TWO_STAR` / `CONTEST_THREE_STAR` per other board holding the champion. `enforce_pool` then demotes units until the lobby fits `POOL_COPIES` (copies per cost; a star level uses `COPIES`).
4. **Finish** (`finish_board`): 3 items on the carry plus a few on two others, 3 augments from offers of 3, active traits, and a scalar `strength` = units (`STAR_POWER`, `STAR_FLAT`) + trait breakpoints + items (full on the carry, half elsewhere) + augments + `0.3 × (level − 8)`.
5. **Play out** (`play_out`): from stage 2, PvP rounds `PVP_ROUNDS` of each 7-round stage pair players randomly (odd one out fights a ghost). Win probability is logistic in the power gap over `COMBAT_LUCK`, where power = strength + plan tempo for the stage + hidden positioning skill (`N(0, POSITIONING_SKILL)`) ± `COUNTER_EDGE` when one formation counters the other (`BEATS`: corner > clump > spread > corner). Losers take `STAGE_DAMAGE[stage]` + surviving enemy units; with probability `ADAPT` they switch to the formation that counters the winner. Placement is elimination order.
6. **Knocked-out boards** are cut back (`board_at_level`) to the level their plan had reached at that stage, keeping the carry and itemized units. This is what creates the Fast 9 survivorship effect the dashboard discusses.

The output match uses `match_id = SIM1_<n>`, a random `puuid`, and the patch's **client** version in `game_version`, so the pipeline must map it back to the set patch.

## Dirty data

Deliberate defects so the validator has work:

- With probability `dirty_share` a match gets one defect from `dirty()`: missing placement, duplicate placement, unknown champion, 7-player lobby, or unreadable version.
- With probability `dirty_share / 2` an earlier match (one of the last 50) is written again: a re-delivered duplicate, caught in-file by Validate or across files by Load.
- After writing, one file in the middle is **truncated by 400 bytes** (a malformed final line), and one **binary** `batch-corrupt.ndjson` is added, which fails decoding and ends in the dead-letter queue.

## Outputs

| File | Use |
| --- | --- |
| `raw/patch=<p>/batch-NNNN.ndjson` | Uploaded to `tft-raw` by `run.py`; matches split evenly across patches |
| `truth.json` | Answer key for `run.py:truth_check` ([shape](data-reference.md#simulator-only-truthjson)) |
| `game.json` | Data for the browser combat sim, including hidden powers and up to `SAMPLE_BOARDS` (240) full planned boards per patch as opponents |

## The truth check

`run.py:truth_check(tierlists, changes, truth, boards)` grades the published output against the hidden values:

- **Rankings**: per patch and kind (champion, item, augment), Spearman correlation between hidden power and `−score` over ranked entities.
- **Patch changes**: entities Riot actually changed vs entities flagged significant (a trait counts once, by its strongest breakpoint signal); how many flagged were real, how many moved in the expected direction (a buff should lower average placement), and which were missed.
- **Playstyle**: accuracy and confusion matrix of the board-inferred playstyle against each board's hidden plan, and true average placement by hidden plan (no survivorship).
- **Positioning**: placement by thirds of hidden positioning skill, counter-formation win rate, number of re-positionings, and stars lost to the shared pool.

These numbers measure recovery **inside the simulation**. They say nothing about predictive accuracy on real TFT matches.
