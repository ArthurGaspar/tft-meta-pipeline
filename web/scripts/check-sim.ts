/**
 * Checks the browser fight simulator against the game data a pipeline run produced:
 *
 *   python run.py && cd web && npm run check:sim
 *
 * Fights must end, replay exactly from a seed, follow the same meta as the simulated
 * lobbies (boards that placed better there win more fights here), and reward sensible
 * positioning over the same board turned back to front.
 */
import { readFileSync } from "node:fs";
import { autoPlace, createBattle, runToEnd, sampleToUnits, type GameData, type Placed } from "../src/sim/engine.ts";

const game: GameData = JSON.parse(readFileSync(new URL("../public/data/game.json", import.meta.url), "utf-8"));
let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  failed ||= !ok;
};

for (const [patch, meta] of Object.entries(game.patches)) {
  const boards = meta.boards;
  const place = (i: number, team: 0 | 1) => autoPlace(sampleToUnits(boards[i % boards.length]), team, game);
  const flip = (p: Placed[]) => p.map((u) => ({ ...u, row: 11 - u.row }));

  let agree = 0, decided = 0, draws = 0, fights = 0, sensible = 0, flipped = 0;
  const started = performance.now();
  for (let i = 0; i < 150; i++) {
    for (const k of [17, 53, 101]) {
      const a = boards[i % boards.length], b = boards[(i + k) % boards.length];
      const seed = i * 1000 + k;
      const out = runToEnd(createBattle(game, patch, [place(i, 0), place(i + k, 1)], seed));
      fights++;
      if (out.winner === null) draws++;
      else if (a.placement !== b.placement) {
        decided++;
        if ((out.winner === 0) === (a.placement < b.placement)) agree++;
      }
      if (out.winner === 0) sensible++;
      if (runToEnd(createBattle(game, patch, [flip(place(i, 0)), place(i + k, 1)], seed)).winner === 0) flipped++;
    }
  }
  const ms = (performance.now() - started) / (fights * 2);
  const replay = () => runToEnd(createBattle(game, patch, [place(0, 0), place(1, 1)], 42));
  check(JSON.stringify(replay()) === JSON.stringify(replay()), `${patch}: the same seed replays the same fight`);
  check(draws / fights < 0.05, `${patch}: fights end before the timer (${((draws / fights) * 100).toFixed(1)}% draws)`);
  check(agree / decided > 0.6, `${patch}: the board that placed better in its lobby wins ${((agree / decided) * 100).toFixed(0)}% of fights`);
  check(sensible > flipped * 1.3, `${patch}: front-to-back layout wins ${sensible}, the same boards turned around ${flipped}`);
  check(ms < 10, `${patch}: ${ms.toFixed(2)} ms per fight`);
}
process.exit(failed ? 1 : 0);
