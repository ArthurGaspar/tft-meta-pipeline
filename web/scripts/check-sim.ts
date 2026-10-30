/**
 * Checks the browser fight simulator against the game data a pipeline run produced:
 *
 *   python run.py && cd web && npm run check:sim
 *
 * First the rules: mitigation, Durability, shields, burns, stuns, a trait and an item
 * with Riot's values, and every spell, trait and item accounted for. Then whole fights:
 * they must end, replay exactly from a seed, follow the same meta as the simulated
 * lobbies (boards that placed better there win more fights here), and reward sensible
 * positioning over the same board turned back to front.
 */
import { readFileSync } from "node:fs";
import { burn, damage, shield, stun } from "../src/sim/core.ts";
import {
  ITEMS,
  SPELLS,
  TRAITS,
  autoPlace,
  createBattle,
  runToEnd,
  sampleToUnits,
  spellFor,
  step,
  type GameData,
  type Placed,
} from "../src/sim/engine.ts";

const game: GameData = JSON.parse(readFileSync(new URL("../public/data/game.json", import.meta.url), "utf-8"));
let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  failed ||= !ok;
};
const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;
const patch = Object.keys(game.patches)[0];
const champ = (name: string) => game.champions.find((c) => c.name === name)!.id;
const duel = (mine: Partial<Placed> & { id: string }, theirs: Partial<Placed> & { id: string }, extraMine: Placed[] = []) =>
  createBattle(game, patch, [[{ star: 1, items: [], row: 4, col: 3, ...mine }, ...extraMine], [{ star: 1, items: [], row: 3, col: 3, ...theirs }]], 1);

// ------------------------------------------------------------------ the rules
{
  const b = duel({ id: champ("Leona") }, { id: champ("Camille") });
  const [u, t] = b.units;
  t.armor = 100;
  t.durability = 0;
  t.hp = t.maxHp = 10_000;
  u.amp = 1;
  const before = t.hp;
  damage(b, u, t, 100, "physical", { canCrit: false });
  check(near(before - t.hp, 50), `100 physical damage into 100 Armor deals 50 (${(before - t.hp).toFixed(1)})`);
  t.durability = 0.2;
  const mid = t.hp;
  damage(b, u, t, 100, "physical", { canCrit: false });
  check(near(mid - t.hp, 40), `20% Durability takes it to 40 (${(mid - t.hp).toFixed(1)})`);
  shield(b, t, 30, 5);
  const shielded = t.hp;
  damage(b, u, t, 100, "physical", { canCrit: false });
  check(near(shielded - t.hp, 10), `a 30 shield absorbs first, 10 gets through (${(shielded - t.hp).toFixed(1)})`);
  // Isolate the burn: both units frozen, no shields left.
  u.stunUntil = t.stunUntil = 99;
  t.shields = [];
  const pre = t.hp;
  burn(b, u, t, 0.01, 4);
  while (b.time < 4.3) step(b);
  check(t.burns.size === 0, "a burn expires after its duration");
  check(near(pre - t.hp, 0.04 * t.maxHp, 1), `a 1% burn for 4 s deals 4% max Health as true damage (${(((pre - t.hp) / t.maxHp) * 100).toFixed(2)}%)`);
}
{
  const b = duel({ id: champ("Leona") }, { id: champ("Camille") });
  const [u, t] = b.units;
  stun(b, u, 3);
  const attacks = u.attacks;
  while (b.time < 2.5) step(b);
  check(u.attacks === attacks, "a stunned unit doesn't attack");
  b.time = 31;
  t.armor = 0;
  t.mr = 0;
  t.durability = 0;
  t.hp = t.maxHp = 10_000;
  u.amp = 1;
  const before = t.hp;
  damage(b, u, t, 100, "true");
  check(near(before - t.hp, 125), `overtime: one second in, damage is up 25% (${(before - t.hp).toFixed(1)})`);
}
{
  // Juggernaut at 2: Juggernauts get Riot's 20% Durability (times the patch's hidden factor), the rest of the team 4%.
  const juggernauts = game.champions.filter((c) => c.traits.some((t) => game.traits.find((x) => x.id === t)?.name === "Juggernaut")).slice(0, 2);
  const other = game.champions.find((c) => !juggernauts.includes(c) && c.cost === 1 && !c.traits.some((t) => game.traits.find((x) => x.id === t)?.name === "Juggernaut"))!;
  const b = createBattle(game, patch, [
    [{ id: juggernauts[0].id, star: 1, items: [], row: 4, col: 2 }, { id: juggernauts[1].id, star: 1, items: [], row: 4, col: 4 }, { id: other.id, star: 1, items: [], row: 5, col: 3 }],
    [{ id: champ("Camille"), star: 1, items: [], row: 3, col: 3 }],
  ], 1);
  const [j, , o] = b.units;
  check(j.durability > 0.1 && j.durability < 0.35, `Juggernaut (2): Juggernauts ${(j.durability * 100).toFixed(0)}% Durability (Riot: 20%, scaled by the hidden meta)`);
  check(o.durability > 0.02 && o.durability < 0.07, `Juggernaut (2): the rest of the team ${(o.durability * 100).toFixed(1)}% (Riot: 4%)`);
}
{
  // Bramble Vest: when struck by an attack, 100 magic damage to adjacent enemies (2 s cooldown).
  const bramble = game.items.find((i) => i.name === "Bramble Vest")!.id;
  const b = duel({ id: champ("Leona"), items: [bramble] }, { id: champ("Camille") });
  const [, t] = b.units;
  const dealt = () => b.units[0].damageDealt;
  const start = dealt();
  b.units[0].stunUntil = 99; // Leona only stands there
  b.units[0].hasSpell = false;
  while (b.time < 3) step(b);
  check(dealt() - start > 0 && t.hp < t.maxHp, `Bramble Vest reflects magic damage at attackers (${Math.round(dealt() - start)} dealt while stunned)`);
}
{
  const missingSpells = game.champions.filter((c) => !spellFor(c.name)).map((c) => c.name);
  check(!missingSpells.length, `every champion has an ability (${game.champions.length - missingSpells.length}/${game.champions.length})${missingSpells.length ? `: missing ${missingSpells}` : ""}`);
  const traits = game.traits.filter((t) => !TRAITS[t.name]?.apply && !TRAITS[t.name]?.notModeled).map((t) => t.name);
  check(!traits.length, `every trait is modeled or says why not${traits.length ? `: ${traits}` : ""}`);
  const items = game.items.filter((i) => !ITEMS[i.name]?.apply && !ITEMS[i.name]?.notModeled).map((i) => i.name);
  check(!items.length, `every item is modeled or says why not${items.length ? `: ${items}` : ""}`);
  check(Object.keys(SPELLS).length >= 65, `${Object.keys(SPELLS).length} ability definitions`);
  // Every ability fires in a real fight without breaking it.
  const crashed: string[] = [];
  let silent: string[] = [];
  for (const c of game.champions) {
    try {
      const b = createBattle(game, patch, [
        [{ id: c.id, star: 2, items: [], row: 4, col: 3 }],
        [{ id: champ("Camille"), star: 2, items: [], row: 3, col: 3 }, { id: champ("Leona"), star: 2, items: [], row: 3, col: 4 }, { id: champ("Varus"), star: 1, items: [], row: 0, col: 3 }],
      ], 3);
      b.units[0].mana = b.units[0].maxMana;
      b.units[0].hp = b.units[0].maxHp = 50_000;
      while (b.time < 12 && !b.done) step(b);
      if (b.units[0].hasSpell && b.units[0].casts === 0) silent.push(c.name);
    } catch (e) {
      crashed.push(`${c.name}: ${(e as Error).message}`);
    }
  }
  check(!crashed.length, `all ${game.champions.length} abilities run in a fight${crashed.length ? `; crashed: ${crashed.join("; ")}` : ""}`);
  silent = silent.filter((n) => n);
  check(!silent.length, `every champion with an active ability casts it${silent.length ? `; never cast: ${silent}` : ""}`);
}

// ------------------------------------------------------------------ whole fights
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
  check(sensible > flipped * 1.2, `${patch}: front-to-back layout wins ${sensible}, the same boards turned around ${flipped}`);
  check(ms < 10, `${patch}: ${ms.toFixed(2)} ms per fight`);
}
process.exit(failed ? 1 : 0);
