/**
 * A real-time TFT fight on a hex grid, deterministic for a given seed.
 *
 * Units have their Community Dragon base stats, scaled by star level, items and the
 * patch's hidden meta (the same champion, trait and item powers the pipeline's
 * simulated lobbies are played with). Each tick a unit picks the nearest enemy,
 * walks towards it until it's in range, attacks, gains mana and casts when full.
 * Abilities aren't in the game data for this set, so every spell is generic:
 * magic damage by cost and star level, splashing around the target (ranged) or
 * around the caster (melee), which is what makes positioning matter.
 *
 * Self-contained (no imports) so it can run headless: the page animates it, and
 * batch runs use the same code to estimate win rates.
 */

export interface ChampionStats {
  hp: number;
  ad: number;
  as: number;
  armor: number;
  mr: number;
  range: number;
  mana: number;
  startMana: number;
  crit: number;
  critMult: number;
}

export interface ChampionData {
  id: string;
  name: string;
  cost: number;
  traits: string[];
  icon: string | null;
  stats: ChampionStats;
}

export interface TraitData {
  id: string;
  name: string;
  breakpoints: number[];
  icon: string | null;
}

export interface ItemData {
  id: string;
  name: string;
  icon: string | null;
  stats: Record<string, number>;
}

/** A board from the simulated lobbies: [champion id, star, items] per unit. */
export interface SampleBoard {
  strategy: string;
  level: number;
  placement: number;
  units: [string, number, string[]][];
}

export interface PatchMeta {
  champion: Record<string, number>;
  trait: Record<string, number[]>;
  item: Record<string, number>;
  boards: SampleBoard[];
}

export interface GameData {
  set: number;
  champions: ChampionData[];
  traits: TraitData[];
  items: ItemData[];
  patches: Record<string, PatchMeta>;
}

export interface Placed {
  id: string;
  star: number;
  items: string[];
  row: number;
  col: number;
}

export interface Unit {
  uid: number;
  team: 0 | 1;
  champion: ChampionData;
  star: number;
  items: string[];
  row: number;
  col: number;
  /** Where a moving unit is coming from; progress runs 0 -> 1 over MOVE_TIME. */
  fromRow: number;
  fromCol: number;
  moveProgress: number;
  hp: number;
  maxHp: number;
  ad: number;
  ap: number;
  attackSpeed: number;
  armor: number;
  mr: number;
  range: number;
  mana: number;
  maxMana: number;
  manaRegen: number;
  crit: number;
  critMult: number;
  omnivamp: number;
  amp: number;
  spell: number;
  cooldown: number;
  stuck: number;
  target: number | null;
  alive: boolean;
  damageDealt: number;
}

export interface FightEvent {
  t: number;
  kind: "attack" | "spell" | "death";
  from: number;
  to: number;
  crit?: boolean;
  amount?: number;
}

export interface Battle {
  time: number;
  units: Unit[];
  events: FightEvent[];
  done: boolean;
  /** 0 = your team, 1 = the opponent, null = draw (time ran out) */
  winner: 0 | 1 | null;
  rng: () => number;
}

export const COLS = 7;
export const ROWS = 8; // rows 0-3: the opponent's half (row 3 its front); rows 4-7: yours (row 4 your front)
export const TICK = 0.05;
export const MAX_TIME = 40;
export const MOVE_TIME = 0.5;
const STAR_HP = [0, 1, 1.8, 3.24];
const STAR_AD = [0, 1, 1.5, 2.25];
const SPELL_BASE = [0, 200, 260, 340, 460, 620];
// How strongly the hidden meta moves stats: champion power relative to what its cost
// predicts, per unit of active trait bonus, and per unit of item power.
const POWER_SCALE = 0.5;
const TRAIT_SCALE = 0.12;
const ITEM_SCALE = 0.2;
const MANA_PER_ATTACK = 10;

export const ownRows = (team: 0 | 1) => (team === 0 ? [4, 5, 6, 7] : [0, 1, 2, 3]);

/** Seeded PRNG (mulberry32): the same seed replays the same fight. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hexes are pointy-top in "odd-r" offset rows: odd rows sit half a hex to the right.
function cube(row: number, col: number): [number, number, number] {
  const x = col - (row - (row & 1)) / 2;
  return [x, -x - row, row];
}

export function hexDistance(r1: number, c1: number, r2: number, c2: number): number {
  const a = cube(r1, c1);
  const b = cube(r2, c2);
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

export function neighbors(row: number, col: number): [number, number][] {
  const odd = row & 1;
  const deltas = odd
    ? [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, 1]]
    : [[0, -1], [0, 1], [-1, -1], [-1, 0], [1, -1], [1, 0]];
  return deltas.map(([dr, dc]) => [row + dr, col + dc] as [number, number]).filter(([r, c]) => r >= 0 && r < ROWS && c >= 0 && c < COLS);
}

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

function makeUnit(uid: number, team: 0 | 1, p: Placed, game: GameData, meta: PatchMeta, traitBonus: Map<string, number>): Unit {
  const c = game.champions.find((x) => x.id === p.id);
  if (!c) throw new Error(`unknown champion ${p.id}`);
  const items = game.items.filter((i) => p.items.includes(i.id));
  const sum = (k: string) => p.items.reduce((acc, id) => acc + (items.find((i) => i.id === id)?.stats[k] ?? 0), 0);
  const power = Math.min(1.7, Math.max(0.6, 1 + POWER_SCALE * ((meta.champion[c.id] ?? 0.3 * c.cost) - 0.3 * c.cost)));
  const traits = 1 + TRAIT_SCALE * c.traits.reduce((acc, t) => acc + (traitBonus.get(t) ?? 0), 0);
  const itemPower = p.items.reduce((acc, id) => acc * (1 + ITEM_SCALE * (meta.item[id] ?? 0)), 1);
  const s = c.stats;
  const maxHp = (s.hp * STAR_HP[p.star] * power * traits + sum("Health")) * Math.max(0.5, itemPower);
  return {
    uid, team, champion: c, star: p.star, items: p.items, row: p.row, col: p.col, fromRow: p.row, fromCol: p.col, moveProgress: 1,
    hp: maxHp, maxHp,
    ad: s.ad * STAR_AD[p.star] * power * traits * (1 + sum("AD")) * Math.max(0.5, itemPower),
    ap: 100 + sum("AP"),
    attackSpeed: Math.min(5, s.as * (1 + sum("AS") / 100)),
    armor: s.armor + sum("Armor"),
    mr: s.mr + sum("MagicResist"),
    range: Math.max(1, s.range),
    mana: s.startMana + sum("CombatStartMana"),
    maxMana: s.mana || 60,
    manaRegen: sum("ManaRegen"),
    crit: Math.min(1, s.crit + sum("CritChance") / 100),
    critMult: s.critMult,
    omnivamp: sum("StatOmnivamp"),
    amp: 1 + sum("DamageAmp"),
    spell: SPELL_BASE[c.cost] * STAR_AD[p.star] * power * traits * Math.max(0.5, itemPower),
    cooldown: 0, stuck: 0, target: null, alive: true, damageDealt: 0,
  };
}

/** Starts a fight: teams[0] is your board (rows 4-7), teams[1] the opponent's (rows 0-3). */
export function createBattle(game: GameData, patch: string, teams: [Placed[], Placed[]], seed: number): Battle {
  const meta = game.patches[patch];
  const units: Unit[] = [];
  teams.forEach((board, team) => {
    const bonus = new Map<string, number>();
    for (const a of activeTraits(board.map((u) => u.id), game)) {
      if (a.tier > 0) bonus.set(a.trait.id, meta.trait[a.trait.id]?.[a.tier - 1] ?? 0);
    }
    for (const p of board) units.push(makeUnit(units.length, team as 0 | 1, p, game, meta, bonus));
  });
  const rng = seeded(seed);
  // A small random head start, so repeated fights between the same boards don't all play out the same.
  for (const u of units) u.cooldown = (0.2 + 0.3 * rng()) / u.attackSpeed;
  const battle: Battle = { time: 0, units, events: [], done: false, winner: null, rng };
  settle(battle);
  return battle;
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

function dist(a: Unit, b: Unit): number {
  return hexDistance(a.row, a.col, b.row, b.col);
}

function damage(b: Battle, from: Unit, to: Unit, raw: number, magic: boolean): number {
  const resist = magic ? to.mr : to.armor;
  const dealt = (raw * from.amp * 100) / (100 + Math.max(0, resist));
  to.hp -= dealt;
  to.mana = Math.min(to.maxMana, to.mana + Math.min(42, 0.01 * raw + 0.03 * dealt));
  from.damageDealt += dealt;
  if (from.omnivamp > 0) from.hp = Math.min(from.maxHp, from.hp + dealt * from.omnivamp);
  if (to.hp <= 0 && to.alive) {
    to.alive = false;
    to.hp = 0;
    b.events.push({ t: b.time, kind: "death", from: from.uid, to: to.uid });
  }
  return dealt;
}

function nearestEnemy(b: Battle, u: Unit): Unit | null {
  let best: Unit | null = null;
  let bestKey = Infinity;
  for (const e of b.units) {
    if (!e.alive || e.team === u.team) continue;
    const key = dist(u, e) + e.hp / (e.maxHp * 10) + b.rng() * 1e-3; // nearest, then the more wounded
    if (key < bestKey) {
      bestKey = key;
      best = e;
    }
  }
  return best;
}

function cast(b: Battle, u: Unit, target: Unit): void {
  u.mana = 0;
  const amount = u.spell * (u.ap / 100);
  // Ranged casters hit their target and splash around it; melee casters hit everything around them.
  const center = u.range >= 2 ? target : u;
  b.events.push({ t: b.time, kind: "spell", from: u.uid, to: center.uid });
  for (const e of b.units) {
    if (!e.alive || e.team === u.team) continue;
    if (e === target) damage(b, u, e, amount, true);
    else if (hexDistance(e.row, e.col, center.row, center.col) <= 1) damage(b, u, e, amount * (u.range >= 2 ? 0.5 : 0.8), true);
  }
}

function occupied(b: Battle, row: number, col: number): boolean {
  return b.units.some((x) => x.alive && x.row === row && x.col === col);
}

/** Advances the fight by one tick. */
export function step(b: Battle): void {
  if (b.done) return;
  b.time += TICK;
  const order = b.units.filter((u) => u.alive).sort(() => b.rng() - 0.5);
  for (const u of order) {
    if (!u.alive) continue;
    if (u.moveProgress < 1) {
      u.moveProgress = Math.min(1, u.moveProgress + TICK / MOVE_TIME);
      continue;
    }
    u.mana = Math.min(u.maxMana, u.mana + u.manaRegen * TICK);
    let target = u.target == null ? null : b.units[u.target];
    if (!target || !target.alive || dist(u, target) > u.range) {
      target = nearestEnemy(b, u);
      u.target = target ? target.uid : null;
    }
    if (!target) continue;
    if (dist(u, target) <= u.range) {
      u.stuck = 0;
      u.cooldown -= TICK;
      if (u.mana >= u.maxMana) {
        cast(b, u, target);
      } else if (u.cooldown <= 0) {
        u.cooldown += 1 / u.attackSpeed;
        const crit = b.rng() < u.crit;
        const amount = damage(b, u, target, u.ad * (crit ? u.critMult : 1), false);
        u.mana = Math.min(u.maxMana, u.mana + MANA_PER_ATTACK);
        b.events.push({ t: b.time, kind: "attack", from: u.uid, to: target.uid, crit, amount });
      }
      continue;
    }
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
    survivors: [0, 1].map((t) => b.units.filter((u) => u.alive && u.team === t).length) as [number, number],
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
