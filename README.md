# TFT Meta Pipeline

A serverless-style ETL that turns raw Teamfight Tactics matches into tier lists for comps, champions, items, augments
and traits. It runs on **minicloud**, a small imitation of AWS built for this project, so the whole thing costs nothing
and needs no cloud account.

**Live:** https://arthurgaspar.github.io/tft-meta-pipeline/

## What happens in a run

1. A **simulator** plays ~3,000 eight-player lobbies with the real Set 18 champions, traits, items and augments (static
   data from [Community Dragon](https://communitydragon.org)). Every piece has a hidden power, players lean towards what
   they believe is strong, and halfway through a balance patch secretly buffs and nerfs a few things. Lobbies have the
   structure of real ones (see [Lobby dynamics](#lobby-dynamics)): economy plans, one shared champion pool, and
   positioning, played out round by round until one player is left. Matches are written as NDJSON in the shape of Riot's
   TFT match API, with ~2% deliberately broken records and one corrupt file.
2. The files are uploaded to the **raw bucket**. Each upload fires an S3-style event.
3. **Validate** checks every record (8 players, placements 1 to 8, known champions and items, a readable version...). Good
   records go to the staged bucket; bad ones go to quarantine with their reasons. A file that isn't text raises, is retried
   twice, and lands in the **dead-letter queue**.
4. Each staged file fires **Load**, which upserts the matches into normalized **MySQL** tables and labels every board with
   its comp ("Juggernaut Maokai": strongest trait plus the unit holding the most items) and its playstyle (reroll, fast 8
   or fast 9, read from the board), and every unit with how many other boards in the lobby held the same champion.
   Loading is idempotent.
5. An hourly **schedule** runs **Aggregate**: average placement, top-4 and win rates per patch, small samples shrunk towards
   average, tiers, patch winners and losers, best items per champion, how contested each comp is and what that costs, and
   placement by playstyle and final level. It publishes JSON to the public bucket, which the website reads.
6. A **truth check**, outside the pipeline, grades the tier lists and the playstyles against the simulator's hidden
   values, and measures what positioning (which match data doesn't record) was worth.

## Lobby dynamics

A board's placement depends on more than its parts. The simulator models three things real lobbies have:

| Concept | In the simulator | What the ETL sees |
|---|---|---|
| **Economy** | Each player follows a plan. *Reroll* slow-rolls at level 6-8 for 3-star 1-3 costs: strong early, low ceiling. *Fast 8* is the standard. *Fast 9* skips rolling for level 9-10 and 5-costs: weak until stage 5, highest ceiling. The plan sets the final level, star odds and board strength at each stage. A player knocked out early is recorded with the board they had then, at a lower level. | `level`, star levels, `gold_left`. Load reads the playstyle back from the board and gets it right on about two boards in three. |
| **Contested units** | All eight players draw from one pool (30 copies of each 1-cost down to 9 of each 5-cost; a 2-star takes 3, a 3-star 9). Players scout and lean away from champions and traits others are building. Each rival holding a champion lowers your odds of 2- and 3-starring it, and the pool can run out. | Who else in the lobby held each champion. Units held by one other board reach 2 stars 42% of the time instead of 60%, and a contested carry places about 0.2 worse. |
| **Positioning** | Every player has a hidden positioning skill and a formation (corner, clump or spread), each of which beats another. A player who loses a fight may re-position to counter the board that beat them. | Nothing: Riot's match data has no positions. It shows up only as noise, and the truth check measures it. |

Fights are a logistic of the strength gap (board, stage tempo, positioning, counter) over a luck term. The loser takes
stage damage plus one per surviving enemy unit, and placements are the order players hit zero health.

One lesson shows up in the data on its own: read from final boards, **Fast 9 looks dominant** (average placement ~2.7),
but the plan itself places ~4.5, about the same as the others. Only players who survive reach level 9, so the final
level is partly a result, not a choice. Any stat site that groups games by final level has the same survivorship bias.
That's why playstyles get no tier. The site's Lobby dynamics page shows the numbers next to that warning.

## Fight simulator (in the browser)

The pipeline plays thousands of lobbies in bulk. The website's **Simulator** page plays one fight at a time, in real
time, on a board you build: pick champions, stars and items, place them on your half of a 7×8 hex grid, and fight a
random board from the simulated lobbies. You can watch the fight, or run 200 of them for a win rate, against one
opponent or against 200 different lobby boards.

- **TFT's combat rules** (`web/src/sim/core.ts`): Damage Amp, Armor and Magic Resist (with Sunder and Shred), Durability,
  shields, healing (with Wound), crits (Precision lets abilities crit), mana from attacks and damage taken, Mana Reave,
  stuns, sleep, taunts, Burn and bleeds, summons, and overtime: after 30 seconds damage ramps up 25% per second so long
  fights end.
- **Every ability, trait and item, from its in-game description.** All 74 abilities (`spells.ts`), with their shapes:
  lines, cones, areas, leaps, tethers, Krug splitting into Kruglettes, Zyra's plants, Lux's ten forms. All 35 traits
  (`traits.ts`) and 39 items (`items.ts`) use Riot's real values. Riot hashes many of the variable names, so
  `static_data.py` decodes them by FNV-1a-hashing the names each description uses (59 of 61 decoded). What happens
  between rounds (shops, Coven's essence, quests, Wisps, Elderwood's plants) can't show in one fight. Those effects say so
  in the page.
- **Estimated numbers, until Riot publishes them.** Set 18's game data has every ability's description but numbers for
  only 2 of 74, on live and on the test server alike, and in Riot's own map data as well. So each ability declares its
  values in Riot's format (`[0, 1-star, 2-star, 3-star]`), with estimates sized by cost from earlier sets. A value the
  game data has, under the same name, replaces the estimate automatically: Kobuko's and Alune's already do. The page
  marks each ability as estimated or real.
- **The same meta.** The simulator writes `game.json`: the set's data above, the hidden power of every champion, trait
  breakpoint and item per patch (which scales their numbers in the browser too), and 240 full boards per patch from the
  simulated lobbies. Boards that placed better in their lobby win about 70% of fights against boards that placed worse.
- **Positioning matters.** Placement decides who gets hit first, what a cone or line catches, and which allies Lunar
  buffs. The same boards with the front and back lines swapped win about 30% fewer fights.
- **Deterministic.** The engine is seeded, has no dependencies, runs at about 1.5 ms per fight, and powers both the
  animation and the batch runs. `npm run check:sim` (also in CI) checks the rules one by one (mitigation, Durability,
  shields, burns, stuns, overtime, a trait and an item with Riot's values) and then whole fights against the generated
  data. Every ability must cast without errors, fights must end and replay from a seed, and they must agree with the
  simulated lobbies.

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

From one run of 2,940 valid matches (23,520 boards) in 82 seconds:

| Measure | Result |
|---|---|
| Function invocations | Validate 17 (3 failed: the corrupt file, 1 try + 2 retries), Load 14, Aggregate 1 |
| Data quality | 87 records quarantined across 7 reasons; 1 event dead-lettered |
| What the run would cost on AWS | about $0.0009 in Lambda and S3 requests; the database (~$11.68/month for a db.t4g.micro) is the only real cost |

**How well the tier lists recover the hidden meta** (Spearman rank correlation with hidden power; 1.0 is a perfect order):

| Category | Patch 18.1 | Patch 18.2 |
|---|---|---|
| Champions | 0.79 | 0.77 |
| Items | 0.93 | 0.96 |
| Augments | 0.97 | 0.97 |

Champions are the hardest to rank: strong units carry weak teammates, 5-costs appear on late (better) boards, and
contest and economy decide how many stars a unit gets.

**Playstyles** are read correctly from 67% of boards. **Positioning**, invisible to the ETL, is worth about half a place:
the third of players with the best hidden skill average 4.26, the worst third 4.75.

**The balance patch:** it secretly changed 19 champions, items and traits. The pipeline flagged 11 significant shifts;
8 were real changes, all in the right direction. The other 11 changes were too small to tell from noise with ~1,500
matches per patch. The significance bar (|z| ≥ 3) is strict on purpose, since about a hundred things are compared at once.

## Run it locally

Needs Python 3.11+, Node 22+, and a MariaDB installation (only its binaries are used).

```bash
python -m venv .venv
.venv/Scripts/activate            # Windows; `source .venv/bin/activate` elsewhere
pip install -r requirements.txt

python localdb.py start           # private database in .db/ on port 3307; no admin rights needed
python run.py                     # the whole pipeline; ~80 s
python -m pytest                  # 30 tests, including an end-to-end run against the database

cd web && npm install && npm run dev   # npm run check:sim tests the fight simulator against the generated data
```

`localdb.py` looks for `mariadbd` on PATH; set `MARIADB_BIN` to its folder otherwise. To use a MySQL server you already
run instead, skip `localdb.py` and set `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME`. To refresh the static game data
from Community Dragon: `python -m simulator.static_data`.

## Limitations

- The matches are simulated. That's what makes the truth check possible. Economy, contested units and positioning are
  modeled, but simply: the board is decided before the game is played out (stage tempo stands in for how it grows), and
  positioning is an abstract skill plus three formations rather than hexes.
- Set 18 Lux has ten forms. A board holds one, and the tier lists rank each form separately.
- minicloud runs functions one at a time in one process. Real Lambda runs them concurrently in isolated environments.
- The icons are hot-linked from Community Dragon's `latest` folder and may change when the set rotates.
