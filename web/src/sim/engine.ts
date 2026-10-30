/**
 * A real-time TFT fight on a hex grid, deterministic for a given seed.
 *
 * Units start from their Community Dragon base stats, scaled by star level and the
 * patch's hidden meta (the same champion, trait and item powers the pipeline's
 * simulated lobbies are played with). Then their spell (spells.ts), items (items.ts)
 * and active traits (traits.ts) hook into the fight. Each tick a unit picks a target,
 * walks towards it until it's in range, attacks, gains mana and casts when full.
 *
 * The page animates this; batch runs use the same code to estimate win rates.
 */
import {
  type Battle,
  type ChampionData,
  type GameData,
  type Hit,
  type PatchMeta,
  type Placed,
  type SampleBoard,
  type TraitData,
  type Unit,
  COLS,
  MANA_PER_ATTACK,
  MAX_TIME,
  ROWS,
  STAR_AD,
  STAR_HP,
  TICK,
  ad,
  attackSpeed,
  damage,
  dist,
  gainMana,
  hexDistance,
  neighbors,
  newUnit,
  occupied,
  seeded,
} from "./core.ts";
import { ITEMS } from "./items.ts";
import { type Ctx, spellFor } from "./spells.ts";
import { TRAITS, traitValues } from "./traits.ts";

export type { Battle, ChampionData, GameData, Placed, SampleBoard, TraitData, Unit };
export type { FightEvent, ItemData, PatchMeta } from "./core.ts";
export { COLS, ROWS, TICK, hexDistance, neighbors, seeded };
export { ITEMS } from "./items.ts";
export { SPELLS, spellCoverage, spellFor } from "./spells.ts";
export { TRAITS, traitValues } from "./traits.ts";

// How strongly the hidden meta moves numbers: champion power relative to what its cost
// predicts, a trait breakpoint's power relative to its expected value, and item power.
const POWER_SCALE = 0.5;
const TRAIT_SCALE = 0.6;
const ITEM_SCALE = 0.2;
const DOT_PERIOD = 0.25;

export const ownRows = (team: 0 | 1) => (team === 0 ? [4, 5, 6, 7] : [0, 1, 2, 3]);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export interface ActiveTrait {
  trait: TraitData;
  count: number;
  tier: number; // active breakpoint, 0 = inactive
}

/** Traits count each champion once, however many copies are on the board. */
export function activeTraits(ids: string[], game: GameData): ActiveTrait[] {
  const champs = new Map(game.champions.map((c) => [c.id, c]));
  const counts = new Map<string, number>();
  for (const id of new Set(ids)) for (const t of champs.get(id)?.traits ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const traits = new Map(game.traits.map((t) => [t.id, t]));
  return [...counts]
    .filter(([id]) => traits.has(id))
    .map(([id, count]) => {
      const trait = traits.get(id) as TraitData;
      return { trait, count, tier: trait.breakpoints.filter((b) => count >= b).length };
    })
    .sort((a, b) => b.tier - a.tier || b.count - a.count || a.trait.name.localeCompare(b.trait.name));
}

function makeUnit(b: Battle, team: 0 | 1, p: Placed): Unit {
  const c = b.game.champions.find((x) => x.id === p.id);
  if (!c) throw new Error(`unknown champion ${p.id}`);
  const u = newUnit(b, team, c, p.star, p.row, p.col);
  u.items = [...p.items];
  u.power = clamp(1 + POWER_SCALE * ((b.meta.champion[c.id] ?? 0.3 * c.cost) - 0.3 * c.cost), 0.6, 1.7);
  u.maxHp = u.hp = c.stats.hp * STAR_HP[p.star] * u.power;
  u.baseAd = c.stats.ad * STAR_AD[p.star] * u.power;
  const def = spellFor(c.name);
  if (!def || def.passiveOnly || !def.cast) {
    u.hasSpell = false;
    u.maxMana = Infinity;
    u.mana = 0;
  } else if (!u.maxMana) u.maxMana = 60;
  return u;
}

function installItem(b: Battle, u: Unit, itemId: string): void {
  const item = b.game.items.find((i) => i.id === itemId);
  if (!item) return;
  const s = (k: string) => item.stats[k] ?? 0;
  u.adMult += s("AD");
  u.ap += s("AP");
  u.asBonus += s("AS") / 100;
  u.armor += s("Armor");
  u.mr += s("MagicResist");
  u.maxHp += s("Health");
  u.hp += s("Health");
  u.crit = Math.min(1, u.crit + s("CritChance") / 100);
  u.manaRegen += s("ManaRegen");
  u.omnivamp += s("StatOmnivamp");
  u.amp += s("DamageAmp");
  if (u.hasSpell) u.mana += s("CombatStartMana");
  // the hidden meta: a stronger item makes its holder hit harder and last longer
  const power = 1 + ITEM_SCALE * (b.meta.item[itemId] ?? 0);
  u.amp *= power;
  u.maxHp *= power;
  u.hp *= power;
  ITEMS[item.name]?.apply?.({ b, u, item, e: (k) => item.effects?.[k] ?? 0, install: (id) => installItem(b, u, id) });
}

function spellCtx(b: Battle, u: Unit, t: Unit): Ctx | null {
  const def = spellFor(u.champion.name);
  if (!def) return null;
  const real = u.champion.spell?.vars ?? {};
  const v = (name: string) => {
    const r = real[name];
    if (r && r.length > u.star && r[u.star] != null) return r[u.star];
    return def.vars[name]?.[u.star] ?? def.vars[name]?.[def.vars[name].length - 1] ?? 0;
  };
  return { b, u, t, v, p: (name) => v(name) * u.power };
}

/** Starts a fight: teams[0] is your board (rows 4-7), teams[1] the opponent's (rows 0-3). */
export function createBattle(game: GameData, patch: string, teams: [Placed[], Placed[]], seed: number): Battle {
  const meta: PatchMeta = game.patches[patch];
  const b: Battle = { time: 0, units: [], events: [], done: false, winner: null, rng: seeded(seed), timers: [], game, meta, nextUid: 0, dotClock: 0, lastHit: null };
  const champions: Unit[][] = teams.map((board, team) => board.map((p) => makeUnit(b, team as 0 | 1, p)));
  b.units = champions.flat();
  for (const u of b.units) for (const id of u.items) installItem(b, u, id);
  for (const u of b.units) {
    const ctx = spellCtx(b, u, u);
    if (ctx) spellFor(u.champion.name)?.setup?.(ctx);
  }
  teams.forEach((board, team) => {
    for (const a of activeTraits(board.map((p) => p.id), game)) {
      const def = TRAITS[a.trait.name];
      if (a.tier === 0 || !def?.apply) continue;
      const values = traitValues(a.trait, a.tier);
      const hidden = meta.trait[a.trait.id]?.[a.tier - 1] ?? 0.3 * a.tier;
      const mult = clamp(1 + TRAIT_SCALE * (hidden - 0.3 * a.tier), 0.5, 1.6);
      const team_ = champions[team];
      def.apply({
        b, trait: a.trait, tier: a.tier, team: team_,
        members: team_.filter((u) => u.champion.traits.includes(a.trait.id)),
        val: (k) => (values[k] ?? 0) * mult,
        raw: (k) => values[k] ?? 0,
      });
    }
  });
  for (const u of b.units) {
    for (const f of u.hooks.start) f();
    // a small random head start, so repeated fights between the same boards don't all play out the same
    u.cooldown = (0.2 + 0.3 * b.rng()) / attackSpeed(b, u);
  }
  settle(b);
  return b;
}

function settle(b: Battle): void {
  const alive = [0, 1].map((t) => b.units.some((u) => u.alive && u.team === t));
  if (!alive[0] || !alive[1]) {
    b.done = true;
    b.winner = alive[0] ? 0 : alive[1] ? 1 : null;
  } else if (b.time >= MAX_TIME) {
    b.done = true;
    b.winner = null;
  }
}

function nearestEnemy(b: Battle, u: Unit): Unit | null {
  let best: Unit | null = null;
  let bestKey = Infinity;
  for (const e of b.units) {
    if (!e.alive || e.team === u.team || e.untargetableUntil > b.time) continue;
    const key = dist(u, e) + e.hp / (e.maxHp * 10) + b.rng() * 1e-3; // nearest, then the more wounded
    if (key < bestKey) {
      bestKey = key;
      best = e;
    }
  }
  return best;
}

function cast(b: Battle, u: Unit, t: Unit): void {
  const def = spellFor(u.champion.name);
  const ctx = spellCtx(b, u, t);
  u.mana = 0;
  u.manaReave = 0;
  u.casts++;
  u.castingUntil = b.time + (def?.channel ?? 0.25);
  b.events.push({ t: b.time, kind: "spell", from: u.uid, to: t.uid });
  if (ctx) def?.cast?.(ctx);
  for (const f of u.hooks.cast) f();
}

function attack(b: Battle, u: Unit, t: Unit): void {
  u.attacks++;
  u.cooldown += 1 / attackSpeed(b, u);
  let hit: Hit = { source: u, target: t, raw: ad(u), dealt: 0, kind: "physical", attack: true, spell: false, crit: false, proc: true };
  if (!(u.attackOverride && u.attackOverride(b, u, t))) {
    b.lastHit = null;
    damage(b, u, t, ad(u), "physical", { attack: true });
    if (b.lastHit) hit = b.lastHit;
  }
  gainMana(b, u, MANA_PER_ATTACK);
  b.events.push({ t: b.time, kind: "attack", from: u.uid, to: t.uid, crit: hit.crit });
  for (const f of u.hooks.attack) f(t, hit);
}

function tickDots(b: Battle): void {
  for (const u of b.units) {
    if (!u.alive) continue;
    for (const [tag, burn] of u.burns) {
      const span = Math.min(DOT_PERIOD, burn.until - (b.time - DOT_PERIOD));
      if (span > 0) damage(b, burn.source, u, burn.pct * u.maxHp * span, "true", { proc: false });
      if (burn.until <= b.time) u.burns.delete(tag);
      if (!u.alive) break;
    }
    for (const d of u.dots) {
      const span = Math.min(b.time, d.until) - d.last;
      if (span > 0 && u.alive) damage(b, d.source, u, d.perSec * span, d.kind, { proc: false });
      d.last = Math.min(b.time, d.until);
    }
    u.dots = u.dots.filter((d) => d.until > b.time);
  }
}

/** Advances the fight by one tick. */
export function step(b: Battle): void {
  if (b.done) return;
  b.time += TICK;

  if (b.timers.some((t) => t.at <= b.time)) {
    const due = b.timers.filter((t) => t.at <= b.time).sort((x, y) => x.at - y.at);
    b.timers = b.timers.filter((t) => t.at > b.time);
    for (const t of due) t.fn();
  }
  b.dotClock += TICK;
  if (b.dotClock >= DOT_PERIOD - 1e-9) {
    b.dotClock = 0;
    tickDots(b);
  }

  const order = b.units.filter((u) => u.alive);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(b.rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const u of order) {
    if (!u.alive) continue;
    for (const f of u.hooks.tick) f(TICK);
    if (u.moveProgress < 1) {
      u.moveProgress = Math.min(1, u.moveProgress + TICK / 0.5);
      continue;
    }
    if (u.stunUntil > b.time || u.sleepUntil > b.time || u.castingUntil > b.time) continue;
    if (u.hasSpell) gainMana(b, u, u.manaRegen * TICK);

    let target = u.target == null ? null : b.units[u.target] ?? null;
    if (u.tauntUntil > b.time && u.taunter != null && b.units[u.taunter]?.alive) target = b.units[u.taunter];
    else if (!target || !target.alive || target.untargetableUntil > b.time || target.team === u.team || dist(u, target) > u.range) target = nearestEnemy(b, u);
    if (!target) continue;
    if (u.target !== target.uid) u.sameTargetSince = b.time;
    u.target = target.uid;

    if (dist(u, target) <= u.range) {
      u.stuck = 0;
      if (u.hasSpell && u.mana >= u.maxMana + u.manaReave) {
        cast(b, u, target);
        continue;
      }
      u.cooldown -= TICK;
      if (u.cooldown <= 0) attack(b, u, target);
      continue;
    }
    if (u.stacks.rooted) continue;
    // Walk one hex towards the target; sidestep if blocked for a while.
    const here = dist(u, target);
    const options = neighbors(u.row, u.col).filter(([r, c]) => !occupied(b, r, c));
    const closer = options.filter(([r, c]) => hexDistance(r, c, target.row, target.col) < here);
    const sideways = u.stuck > 0.5 ? options.filter(([r, c]) => hexDistance(r, c, target.row, target.col) === here) : [];
    const pool = closer.length ? closer : sideways;
    if (!pool.length) {
      u.stuck += TICK;
      continue;
    }
    const [r, c] = pool[Math.floor(b.rng() * pool.length)];
    u.fromRow = u.row;
    u.fromCol = u.col;
    u.row = r;
    u.col = c;
    u.moveProgress = 0;
    u.stuck = 0;
  }
  b.events = b.events.filter((e) => e.t > b.time - 1);
  settle(b);
}

export interface Outcome {
  winner: 0 | 1 | null;
  time: number;
  survivors: [number, number];
}

export function runToEnd(b: Battle): Outcome {
  while (!b.done) step(b);
  return {
    winner: b.winner,
    time: b.time,
    survivors: [0, 1].map((t) => b.units.filter((u) => u.alive && u.team === t && !u.summon).length) as [number, number],
  };
}

/** Places a board on a team's half the way players usually do: melee in front, long range at the back, the carry in a back corner. */
export function autoPlace(units: { id: string; star: number; items: string[] }[], team: 0 | 1, game: GameData): Placed[] {
  const champs = new Map(game.champions.map((c) => [c.id, c]));
  const rows = team === 0 ? [4, 5, 6, 7] : [3, 2, 1, 0]; // front to back
  const carry = units.reduce<number>((best, u, i) => (best < 0 || u.items.length > units[best].items.length ? i : best), -1);
  const lane = (i: number) => {
    const r = champs.get(units[i].id)?.stats.range ?? 1;
    return r <= 1 ? 0 : r <= 3 ? 1 : 3;
  };
  const free = rows.map(() => [3, 2, 4, 1, 5, 0, 6]);
  const out: Placed[] = [];
  const put = (i: number, wanted: number, corner = false) => {
    for (let k = 0; k < rows.length; k++) {
      // Try the wanted row, then rows behind it, then rows in front.
      const ri = [wanted, ...[1, 2, 3].map((d) => wanted + d), ...[1, 2, 3].map((d) => wanted - d)].filter((x) => x >= 0 && x < rows.length)[k];
      if (ri === undefined || !free[ri].length) continue;
      const cols = free[ri];
      const col = corner ? (cols.includes(0) ? 0 : cols.includes(6) ? 6 : cols[cols.length - 1]) : cols[0];
      cols.splice(cols.indexOf(col), 1);
      out.push({ ...units[i], row: rows[ri], col });
      return;
    }
  };
  if (carry >= 0 && lane(carry) > 0) put(carry, 3, true);
  units.forEach((_, i) => {
    if (!(i === carry && lane(carry) > 0)) put(i, lane(i));
  });
  return out;
}

export function sampleToUnits(board: SampleBoard) {
  return board.units.map(([id, star, items]) => ({ id, star, items }));
}
