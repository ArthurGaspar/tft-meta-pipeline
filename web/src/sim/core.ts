/**
 * The rules every unit, spell, trait and item builds on: the hex grid, damage and
 * mitigation, shields, healing, mana, crowd control, damage over time, timed buffs,
 * summons and the shapes spells hit (areas, lines, cones).
 *
 * Damage follows TFT's order: Damage Amp and Vulnerable (and overtime), then Armor or
 * Magic Resist (after Sunder or Shred), then Durability, then shields, then health.
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

export interface SpellInfo {
  name?: string | null;
  desc: string;
  /** Riot's per-star values, [0, 1-star, 2-star, 3-star, ...], when the game data has them. */
  vars: Record<string, number[]>;
}

export interface ChampionData {
  id: string;
  name: string;
  cost: number;
  traits: string[];
  icon: string | null;
  stats: ChampionStats;
  spell?: SpellInfo;
}

export interface TraitData {
  id: string;
  name: string;
  breakpoints: number[];
  icon: string | null;
  desc?: string;
  effects?: { minUnits: number; values: Record<string, number> }[];
}

export interface ItemData {
  id: string;
  name: string;
  icon: string | null;
  stats: Record<string, number>;
  effects?: Record<string, number>;
  desc?: string;
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

export type DamageKind = "physical" | "magic" | "true";

export interface Hit {
  source: Unit;
  target: Unit;
  /** before mitigation */
  raw: number;
  /** what the target actually lost, shields included */
  dealt: number;
  kind: DamageKind;
  attack: boolean;
  spell: boolean;
  crit: boolean;
  /** damage over time and reflected damage don't trigger on-hit effects */
  proc: boolean;
}

type Fn<A extends unknown[]> = (...args: A) => void;

export interface Hooks {
  /** when combat starts, after every unit, item and trait is set up */
  start: Fn<[]>[];
  /** every tick, with the tick length */
  tick: Fn<[number]>[];
  /** after this unit's basic attack lands */
  attack: Fn<[Unit, Hit]>[];
  /** after this unit damages anything */
  hit: Fn<[Hit]>[];
  /** after this unit takes damage */
  hurt: Fn<[Hit]>[];
  /** after this unit casts */
  cast: Fn<[]>[];
  /** this unit got the takedown */
  kill: Fn<[Unit]>[];
  /** this unit died */
  death: Fn<[Unit | null]>[];
  /** multipliers on damage this unit deals / takes, before mitigation */
  dealMult: ((h: Hit) => number)[];
  takeMult: ((h: Hit) => number)[];
}

export interface Unit {
  uid: number;
  team: 0 | 1;
  champion: ChampionData;
  star: number;
  items: string[];
  summon: boolean;
  row: number;
  col: number;
  fromRow: number;
  fromCol: number;
  moveProgress: number;
  hp: number;
  maxHp: number;
  baseAd: number;
  adMult: number;
  /** Ability Power in percentage points: 100 = base */
  ap: number;
  baseAs: number;
  asBonus: number;
  armor: number;
  mr: number;
  range: number;
  mana: number;
  maxMana: number;
  manaRegen: number;
  manaMult: number;
  /** extra cost on the next cast (Mana Reave) */
  manaReave: number;
  crit: number;
  critMult: number;
  precision: boolean;
  omnivamp: number;
  amp: number;
  durability: number;
  /** the hidden meta's multiplier on this champion's numbers */
  power: number;
  shields: { amount: number; until: number }[];
  stunUntil: number;
  ccImmuneUntil: number;
  untargetableUntil: number;
  invulnerableUntil: number;
  castingUntil: number;
  sleepUntil: number;
  sleepDamage: number;
  taunter: number | null;
  tauntUntil: number;
  slow: number;
  slowUntil: number;
  sunder: number;
  sunderUntil: number;
  shred: number;
  shredUntil: number;
  armorReduction: number;
  mrReduction: number;
  vulnerable: number;
  vulnerableUntil: number;
  wound: number;
  woundUntil: number;
  /** burns by source tag: % max Health true damage per second; the same tag doesn't stack */
  burns: Map<string, { pct: number; until: number; source: Unit }>;
  /** damage over time (poison, bleeds); `last` is when it was last applied */
  dots: { perSec: number; kind: DamageKind; until: number; source: Unit; last: number }[];
  stacks: Record<string, number>;
  cooldown: number;
  stuck: number;
  target: number | null;
  sameTargetSince: number;
  alive: boolean;
  lastHitBy: Unit | null;
  damageDealt: number;
  attacks: number;
  casts: number;
  /** replaces the basic attack (Caitlyn's headshots, Azir's soldiers, ...) */
  attackOverride: ((b: Battle, u: Unit, t: Unit) => boolean) | null;
  hasSpell: boolean;
  hooks: Hooks;
}

export interface FightEvent {
  t: number;
  kind: "attack" | "spell" | "death" | "area" | "beam";
  from: number;
  to: number;
  crit?: boolean;
  /** area: center and radius, in hex-grid units */
  x?: number;
  y?: number;
  r?: number;
  x2?: number;
  y2?: number;
}

export interface Battle {
  time: number;
  units: Unit[];
  events: FightEvent[];
  done: boolean;
  winner: 0 | 1 | null;
  rng: () => number;
  timers: { at: number; fn: () => void }[];
  game: GameData;
  meta: PatchMeta;
  nextUid: number;
  dotClock: number;
  /** the last damage resolved, so an attack can see whether it crit */
  lastHit: Hit | null;
}

export const COLS = 7;
export const ROWS = 8;
export const TICK = 0.05;
export const MAX_TIME = 45;
/** Overtime, as in TFT: once combat runs long, all damage ramps up so the fight ends. */
export const OVERTIME_START = 30;
export const OVERTIME_RAMP = 0.25; // +25% damage per second of overtime
export const MOVE_TIME = 0.5;
export const MANA_PER_ATTACK = 10;
export const STAR_HP = [0, 1, 1.8, 3.24, 5.8];
export const STAR_AD = [0, 1, 1.5, 2.25, 3.4];

export function emptyHooks(): Hooks {
  return { start: [], tick: [], attack: [], hit: [], hurt: [], cast: [], kill: [], death: [], dealMult: [], takeMult: [] };
}

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

// ---------------------------------------------------------------- the grid
// Pointy-top hexes in "odd-r" offset rows: odd rows sit half a hex to the right.

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
  const deltas = row & 1
    ? [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, 1]]
    : [[0, -1], [0, 1], [-1, -1], [-1, 0], [1, -1], [1, 0]];
  return deltas.map(([dr, dc]) => [row + dr, col + dc] as [number, number]).filter(([r, c]) => r >= 0 && r < ROWS && c >= 0 && c < COLS);
}

/** A hex's center in hex-radius units (the board draws it at PAD + SIZE * this). */
export function pixel(row: number, col: number): [number, number] {
  return [Math.sqrt(3) * (col + 0.5 + 0.5 * (row & 1)), 1 + 1.5 * row];
}

export function dist(a: Unit, b: Unit): number {
  return hexDistance(a.row, a.col, b.row, b.col);
}

export function occupied(b: Battle, row: number, col: number): boolean {
  return b.units.some((x) => x.alive && x.row === row && x.col === col);
}

/** The free hex nearest to (row, col), searching outwards; (row, col) itself may be off the board. */
export function freeHexNear(b: Battle, row: number, col: number, avoid?: [number, number]): [number, number] | null {
  row = Math.min(ROWS - 1, Math.max(0, row));
  col = Math.min(COLS - 1, Math.max(0, col));
  const seen = new Set<string>([`${row}:${col}`]);
  let frontier: [number, number][] = [[row, col]];
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const free = frontier.filter(([r, c]) => !occupied(b, r, c) && !(avoid && avoid[0] === r && avoid[1] === c));
    if (free.length) return free[Math.floor(b.rng() * free.length)];
    const next: [number, number][] = [];
    for (const [r, c] of frontier)
      for (const n of neighbors(r, c))
        if (!seen.has(`${n[0]}:${n[1]}`)) {
          seen.add(`${n[0]}:${n[1]}`);
          next.push(n);
        }
    frontier = next;
  }
  return null;
}

export function teleport(u: Unit, row: number, col: number): void {
  u.row = u.fromRow = row;
  u.col = u.fromCol = col;
  u.moveProgress = 1;
}

/** Moves a unit next to a target (a leap or dash). */
export function leapTo(b: Battle, u: Unit, t: Unit): void {
  const spot = freeHexNear(b, t.row, t.col);
  if (spot && hexDistance(spot[0], spot[1], t.row, t.col) <= 2) teleport(u, spot[0], spot[1]);
}

// ---------------------------------------------------------------- who is where

export const now = (b: Battle) => b.time;
export const targetable = (b: Battle, u: Unit) => u.alive && u.untargetableUntil <= b.time;

export function enemies(b: Battle, u: Unit): Unit[] {
  return b.units.filter((e) => e.team !== u.team && targetable(b, e));
}

export function allies(b: Battle, u: Unit, includeSelf = true): Unit[] {
  return b.units.filter((a) => a.team === u.team && a.alive && (includeSelf || a !== u));
}

export function within(_b: Battle, list: Unit[], row: number, col: number, radius: number): Unit[] {
  return list.filter((x) => hexDistance(x.row, x.col, row, col) <= radius);
}

export function nearest(list: Unit[], from: Unit, n = 1): Unit[] {
  return [...list].sort((a, c) => dist(from, a) - dist(from, c) || a.hp - c.hp).slice(0, n);
}

/** The hex (an enemy's position) with the most enemies within `radius`. */
export function bestCluster(b: Battle, u: Unit, radius: number, maxRange = 99): Unit | null {
  let best: Unit | null = null;
  let score = -1;
  for (const e of enemies(b, u)) {
    if (dist(u, e) > maxRange) continue;
    const n = within(b, enemies(b, u), e.row, e.col, radius).length;
    if (n > score) {
      score = n;
      best = e;
    }
  }
  return best;
}

/** Enemies in a line from `from` towards `to`, `length` hexes long and about one hex wide. */
export function inLine(b: Battle, u: Unit, from: Unit, to: Unit, length = 8): Unit[] {
  const [x0, y0] = pixel(from.row, from.col);
  const [x1, y1] = pixel(to.row, to.col);
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const [dx, dy] = [(x1 - x0) / len, (y1 - y0) / len];
  return enemies(b, u)
    .map((e) => {
      const [px, py] = pixel(e.row, e.col);
      const along = (px - x0) * dx + (py - y0) * dy;
      const off = Math.abs((px - x0) * dy - (py - y0) * dx);
      return { e, along, off };
    })
    .filter((p) => p.along > 0 && p.along <= length * Math.sqrt(3) && p.off <= 1.1)
    .sort((a, c) => a.along - c.along)
    .map((p) => p.e);
}

/** The enemy whose direction lines up the most enemies. */
export function bestLine(b: Battle, u: Unit, length = 8): Unit | null {
  let best: Unit | null = null;
  let score = -1;
  for (const e of enemies(b, u)) {
    const n = inLine(b, u, u, e, length).length;
    if (n > score) {
      score = n;
      best = e;
    }
  }
  return best;
}

/** Enemies in a cone from `u` towards `to`, `radius` hexes deep and about 70 degrees wide. */
export function inCone(b: Battle, u: Unit, to: Unit, radius = 2): Unit[] {
  const [x0, y0] = pixel(u.row, u.col);
  const [x1, y1] = pixel(to.row, to.col);
  const dir = Math.atan2(y1 - y0, x1 - x0);
  return enemies(b, u).filter((e) => {
    if (e === to) return true;
    if (dist(u, e) > radius) return false;
    const [px, py] = pixel(e.row, e.col);
    let d = Math.abs(Math.atan2(py - y0, px - x0) - dir);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d <= 0.62;
  });
}

// ---------------------------------------------------------------- stats

export const ad = (u: Unit) => u.baseAd * u.adMult;
export const attackSpeed = (b: Battle, u: Unit) => Math.min(5, u.baseAs * (1 + u.asBonus)) * (u.slowUntil > b.time ? 1 - u.slow : 1);
export const healthPct = (u: Unit) => u.hp / u.maxHp;
export const shieldTotal = (b: Battle, u: Unit) => u.shields.reduce((s, x) => s + (x.until > b.time ? x.amount : 0), 0);

export function armorOf(b: Battle, u: Unit): number {
  return Math.max(0, u.armor - u.armorReduction) * (u.sunderUntil > b.time ? 1 - u.sunder : 1);
}

export function mrOf(b: Battle, u: Unit): number {
  return Math.max(0, u.mr - u.mrReduction) * (u.shredUntil > b.time ? 1 - u.shred : 1);
}

type Stat = "adMult" | "ap" | "asBonus" | "armor" | "mr" | "amp" | "durability" | "omnivamp" | "manaRegen" | "crit" | "range";

/** Adds stats now and, with a duration, takes them away again later. */
export function buff(b: Battle, u: Unit, changes: Partial<Record<Stat, number>>, duration?: number): void {
  for (const [k, v] of Object.entries(changes) as [Stat, number][]) u[k] += v;
  if (duration !== undefined)
    schedule(b, duration, () => {
      for (const [k, v] of Object.entries(changes) as [Stat, number][]) u[k] -= v;
    });
}

export function addMaxHp(u: Unit, amount: number): void {
  u.maxHp += amount;
  u.hp += amount;
}

export function schedule(b: Battle, delay: number, fn: () => void): void {
  b.timers.push({ at: b.time + delay, fn });
}

/** Repeats `fn` every `period` seconds while the unit lives (for `count` times if given). */
export function every(b: Battle, u: Unit, period: number, fn: () => void, count = Infinity): void {
  const run = (left: number) => {
    if (!u.alive || left <= 0 || b.done) return;
    fn();
    schedule(b, period, () => run(left - 1));
  };
  schedule(b, period, () => run(count));
}

// ---------------------------------------------------------------- effects

export function heal(b: Battle, u: Unit, amount: number): number {
  if (!u.alive || amount <= 0) return 0;
  const real = Math.min(u.maxHp - u.hp, amount * (u.woundUntil > b.time ? 1 - u.wound : 1));
  u.hp += real;
  return real;
}

export function shield(b: Battle, u: Unit, amount: number, duration: number): void {
  if (!u.alive || amount <= 0) return;
  u.shields.push({ amount, until: b.time + duration });
}

export function stun(b: Battle, u: Unit, duration: number): void {
  if (!u.alive || u.ccImmuneUntil > b.time) return;
  u.stunUntil = Math.max(u.stunUntil, b.time + duration);
  u.castingUntil = 0;
}

export function sleep(b: Battle, u: Unit, duration: number, wakeAfter: number): void {
  if (!u.alive || u.ccImmuneUntil > b.time) return;
  u.sleepUntil = b.time + duration;
  u.sleepDamage = wakeAfter;
}

export function taunt(b: Battle, by: Unit, victims: Unit[], duration: number): void {
  for (const v of victims) {
    if (v.ccImmuneUntil > b.time) continue;
    v.taunter = by.uid;
    v.tauntUntil = b.time + duration;
    v.target = by.uid;
  }
}

export function slowDown(b: Battle, u: Unit, pct: number, duration: number): void {
  if (u.ccImmuneUntil > b.time) return;
  u.slow = Math.max(u.slowUntil > b.time ? u.slow : 0, pct);
  u.slowUntil = Math.max(u.slowUntil, b.time + duration);
}

export function sunder(b: Battle, u: Unit, pct: number, duration: number): void {
  u.sunder = Math.max(u.sunderUntil > b.time ? u.sunder : 0, pct);
  u.sunderUntil = Math.max(u.sunderUntil, b.time + duration);
}

export function shred(b: Battle, u: Unit, pct: number, duration: number): void {
  u.shred = Math.max(u.shredUntil > b.time ? u.shred : 0, pct);
  u.shredUntil = Math.max(u.shredUntil, b.time + duration);
}

export function wound(b: Battle, u: Unit, pct: number, duration: number): void {
  u.wound = Math.max(u.woundUntil > b.time ? u.wound : 0, pct);
  u.woundUntil = Math.max(u.woundUntil, b.time + duration);
}

export function vulnerable(b: Battle, u: Unit, pct: number, duration: number): void {
  u.vulnerable = Math.max(u.vulnerableUntil > b.time ? u.vulnerable : 0, pct);
  u.vulnerableUntil = Math.max(u.vulnerableUntil, b.time + duration);
}

/** Burn: a percent of max Health as true damage per second. One burn per tag; a stronger one replaces a weaker. */
export function burn(b: Battle, source: Unit, u: Unit, pct: number, duration: number, tag = "burn"): void {
  const cur = u.burns.get(tag);
  if (cur && cur.until > b.time && cur.pct > pct) return;
  u.burns.set(tag, { pct, until: b.time + duration, source });
}

export function dot(b: Battle, source: Unit, u: Unit, total: number, duration: number, kind: DamageKind): void {
  u.dots.push({ perSec: total / duration, kind, until: b.time + duration, source, last: b.time });
}

export function gainMana(b: Battle, u: Unit, amount: number): void {
  if (!u.alive || !u.hasSpell || u.castingUntil > b.time) return;
  u.mana = Math.min(u.maxMana + u.manaReave, u.mana + amount * u.manaMult);
}

// ---------------------------------------------------------------- damage

export interface DamageOptions {
  attack?: boolean;
  spell?: boolean;
  /** extra crit chance roll for abilities (Precision) and attacks */
  canCrit?: boolean;
  /** damage over time, reflects: no on-hit effects, no mana */
  proc?: boolean;
}

export function damage(b: Battle, source: Unit, target: Unit, raw: number, kind: DamageKind, o: DamageOptions = {}): number {
  if (!target.alive || raw <= 0 || target.invulnerableUntil > b.time) return 0;
  // Only attacks and abilities trigger on-hit effects; damage over time and reflects don't.
  const hit: Hit = { source, target, raw, dealt: 0, kind, attack: !!o.attack, spell: !!o.spell, crit: false, proc: !!(o.attack || o.spell) && o.proc !== false };
  let amount = raw;
  if ((o.attack || (o.spell && source.precision)) && o.canCrit !== false && b.rng() < source.crit) {
    hit.crit = true;
    amount *= source.critMult;
  }
  let mult = source.amp + (target.vulnerableUntil > b.time ? target.vulnerable : 0);
  if (b.time > OVERTIME_START) mult *= 1 + OVERTIME_RAMP * (b.time - OVERTIME_START);
  for (const f of source.hooks.dealMult) mult *= f(hit);
  for (const f of target.hooks.takeMult) mult *= f(hit);
  amount *= Math.max(0, mult);
  if (kind === "physical") amount *= 100 / (100 + armorOf(b, target));
  else if (kind === "magic") amount *= 100 / (100 + mrOf(b, target));
  if (kind !== "true") amount *= 1 - Math.min(0.75, Math.max(0, target.durability));

  let left = amount;
  for (const s of target.shields) {
    if (s.until <= b.time || left <= 0) continue;
    const used = Math.min(s.amount, left);
    s.amount -= used;
    left -= used;
  }
  target.shields = target.shields.filter((s) => s.amount > 0.5 && s.until > b.time);
  target.hp -= left;
  hit.dealt = amount;
  b.lastHit = hit;
  source.damageDealt += amount;
  target.lastHitBy = source;
  if (target.sleepUntil > b.time) {
    target.sleepDamage -= amount;
    if (target.sleepDamage <= 0) target.sleepUntil = 0;
  }
  if (hit.proc) gainMana(b, target, Math.min(42, 0.01 * raw + 0.03 * amount));
  if (source.omnivamp > 0 && hit.proc) heal(b, source, amount * source.omnivamp);
  if (hit.proc) {
    for (const f of source.hooks.hit) f(hit);
  }
  for (const f of target.hooks.hurt) f(hit);
  if (target.hp <= 0 && target.alive) kill(b, target, source);
  return amount;
}

export function kill(b: Battle, u: Unit, by: Unit | null): void {
  if (!u.alive) return;
  u.alive = false;
  u.hp = 0;
  u.shields = [];
  b.events.push({ t: b.time, kind: "death", from: by?.uid ?? u.uid, to: u.uid });
  for (const f of u.hooks.death) f(by);
  if (by && by.alive) for (const f of by.hooks.kill) f(u);
}

/** Shorthand used by spells: magic damage scaled by Ability Power. */
export function magic(b: Battle, u: Unit, t: Unit, base: number, extra: DamageOptions = {}): number {
  return damage(b, u, t, (base * u.ap) / 100, "magic", { spell: true, ...extra });
}

/** Physical spell damage as a percent of Attack Damage (Riot's "ADDamage"). */
export function physical(b: Battle, u: Unit, t: Unit, pctAd: number, extra: DamageOptions = {}): number {
  return damage(b, u, t, (pctAd / 100) * ad(u), "physical", { spell: true, ...extra });
}

export function area(b: Battle, u: Unit, row: number, col: number, r: number): void {
  const [x, y] = pixel(row, col);
  b.events.push({ t: b.time, kind: "area", from: u.uid, to: u.uid, x, y, r });
}

export function beam(b: Battle, u: Unit, from: Unit, to: Unit): void {
  const [x, y] = pixel(from.row, from.col);
  const [x2, y2] = pixel(to.row, to.col);
  b.events.push({ t: b.time, kind: "beam", from: u.uid, to: to.uid, x, y, x2, y2 });
}

// ---------------------------------------------------------------- units

export interface SummonSpec {
  name: string;
  icon: string | null;
  hp: number;
  ad: number;
  as: number;
  range: number;
  armor: number;
  mr: number;
  /** can't move (plants) */
  rooted?: boolean;
}

export function newUnit(b: Battle, team: 0 | 1, champion: ChampionData, star: number, row: number, col: number): Unit {
  const s = champion.stats;
  return {
    uid: b.nextUid++, team, champion, star, items: [], summon: false, row, col, fromRow: row, fromCol: col, moveProgress: 1,
    hp: s.hp, maxHp: s.hp, baseAd: s.ad, adMult: 1, ap: 100, baseAs: s.as, asBonus: 0, armor: s.armor, mr: s.mr,
    range: Math.max(1, s.range), mana: s.startMana, maxMana: s.mana, manaRegen: 0, manaMult: 1, manaReave: 0,
    crit: s.crit, critMult: s.critMult || 1.4, precision: false, omnivamp: 0, amp: 1, durability: 0, power: 1,
    shields: [], stunUntil: 0, ccImmuneUntil: 0, untargetableUntil: 0, invulnerableUntil: 0, castingUntil: 0, sleepUntil: 0, sleepDamage: 0,
    taunter: null, tauntUntil: 0, slow: 0, slowUntil: 0, sunder: 0, sunderUntil: 0, shred: 0, shredUntil: 0, armorReduction: 0, mrReduction: 0,
    vulnerable: 0, vulnerableUntil: 0, wound: 0, woundUntil: 0, burns: new Map(), dots: [], stacks: {},
    cooldown: 0, stuck: 0, target: null, sameTargetSince: 0, alive: true, lastHitBy: null, damageDealt: 0, attacks: 0, casts: 0,
    attackOverride: null, hasSpell: true, hooks: emptyHooks(),
  };
}

/** Puts a summon on the board next to (row, col); summons fight like units but have no spell. */
export function summon(b: Battle, owner: Unit, spec: SummonSpec, row: number, col: number): Unit | null {
  const spot = freeHexNear(b, row, col);
  if (!spot) return null;
  const champion: ChampionData = {
    id: `summon:${spec.name}`, name: spec.name, cost: 0, traits: [], icon: spec.icon,
    stats: { hp: spec.hp, ad: spec.ad, as: spec.as, armor: spec.armor, mr: spec.mr, range: spec.range, mana: 0, startMana: 0, crit: 0.25, critMult: 1.4 },
  };
  const u = newUnit(b, owner.team, champion, 1, spot[0], spot[1]);
  u.summon = true;
  u.hasSpell = false;
  u.maxMana = Infinity;
  u.cooldown = 0.3 / u.baseAs;
  if (spec.rooted) u.stacks.rooted = 1;
  b.units.push(u);
  return u;
}
