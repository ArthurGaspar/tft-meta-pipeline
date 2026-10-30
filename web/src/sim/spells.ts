/**
 * Every Set 18 champion's ability, written from its in-game description.
 *
 * Riot's data for Set 18 has the descriptions but (so far) not the numbers: only 2 of
 * 74 abilities ship their values. Each spell therefore declares the values it uses in
 * Riot's format, [0, 1-star, 2-star, 3-star], with estimates sized by cost from earlier
 * sets. When the game data carries a value under the same name, the real one wins
 * (Kobuko's and Alune's already do). `notModeled` lists the parts that happen outside
 * a single fight (quests, shops, rewards).
 */
import {
  type Battle,
  type Unit,
  ad,
  addMaxHp,
  allies,
  area,
  beam,
  bestCluster,
  bestLine,
  buff,
  burn,
  damage,
  dist,
  dot,
  enemies,
  every,
  freeHexNear,
  gainMana,
  heal,
  healthPct,
  inCone,
  inLine,
  leapTo,
  magic,
  nearest,
  physical,
  schedule,
  shield,
  shieldTotal,
  shred,
  sleep,
  slowDown,
  stun,
  summon,
  taunt,
  teleport,
  vulnerable,
  within,
} from "./core.ts";

export interface Ctx {
  b: Battle;
  u: Unit;
  t: Unit;
  /** a value for this unit's star level: real if the game data has it, else the estimate */
  v: (name: string) => number;
  /** a damage, healing or shield value, also scaled by the patch's hidden meta */
  p: (name: string) => number;
}

export interface SpellDef {
  vars: Record<string, number[]>;
  cast?: (c: Ctx) => void;
  /** passives, set up once at combat start (c.t is the unit itself) */
  setup?: (c: Ctx) => void;
  /** no castable ability: the unit never gains mana */
  passiveOnly?: boolean;
  /** seconds the caster stands still casting */
  channel?: number;
  notModeled?: string;
}

// Estimate helpers. Magic values scale with Ability Power, physical "ADDamage" values are % of Attack Damage.
const NUKE = [0, 200, 260, 340, 440, 600];
const PCT = [0, 200, 230, 260, 300, 360];
const SHIELD = [0, 250, 320, 400, 520, 700];
const top = (cost: number) => (cost <= 3 ? 2.3 : cost === 4 ? 4 : 12);
/** magic damage/heal estimate for a cost, times m */
const mag = (cost: number, m = 1) => [0, NUKE[cost] * m, NUKE[cost] * m * 1.5, NUKE[cost] * m * top(cost)].map(Math.round);
/** % AD estimate (Attack Damage already grows with stars, so this grows slowly) */
const pct = (cost: number, m = 1) => [0, PCT[cost] * m, PCT[cost] * m * 1.05, PCT[cost] * m * (cost <= 3 ? 1.15 : cost === 4 ? 1.8 : 5)].map(Math.round);
const shd = (cost: number, m = 1) => [0, SHIELD[cost] * m, SHIELD[cost] * m * 1.3, SHIELD[cost] * m * (cost <= 3 ? 1.7 : cost === 4 ? 3 : 8)].map(Math.round);
const flat = (x: number) => [x, x, x, x];

const burning = (c: Ctx, e: Unit) => [...e.burns.values()].some((x) => x.until > c.b.time);
const lowestPct = (list: Unit[]) => [...list].sort((a, z) => healthPct(a) - healthPct(z))[0];
const heals = (c: Ctx, amount: number, over: number) => {
  const ticks = Math.max(1, Math.round(over / 0.25));
  for (let i = 1; i <= ticks; i++) schedule(c.b, (over * i) / ticks, () => heal(c.b, c.u, amount / ticks));
};
/** damage that falls off for each enemy a projectile passes through */
const pierce = (c: Ctx, hit: Unit[], amount: (i: number) => number, perHit: number, minimum: number) =>
  hit.forEach((e, i) => physical(c.b, c.u, e, amount(i) * Math.max(minimum, 1 - perHit * i)));

/** The mark a champion's next attacks carry (Shen, Taric, Kobuko...). */
function empowerAttacks(u: Unit, key: string, count: number): void {
  u.stacks[key] = count;
}

function useEmpowered(u: Unit, key: string): boolean {
  if (!u.stacks[key]) return false;
  u.stacks[key]--;
  return true;
}

function luxVariant(u: Unit): string {
  return /\((\w+)\)/.exec(u.champion.name)?.[1] ?? "";
}

export const SPELLS: Record<string, SpellDef> = {
  // ------------------------------------------------------------------ 1-cost
  Akali: {
    vars: { ADDamage: pct(1, 0.9), BonusADDamage: pct(1, 0.35) },
    cast: (c) => {
      const strike = (t: Unit) => {
        physical(c.b, c.u, t, c.p("ADDamage") + (burning(c, t) ? c.p("BonusADDamage") : 0));
        beam(c.b, c.u, c.u, t);
      };
      strike(c.t);
      // Adaptor: a kill casts it again, once
      const next = !c.t.alive ? nearest(enemies(c.b, c.u), c.u)[0] : undefined;
      if (next) strike(next);
    },
  },
  Camille: {
    vars: { ADDamage: pct(1, 0.9), Shield: shd(1, 0.8), ShieldDuration: flat(4) },
    cast: (c) => {
      physical(c.b, c.u, c.t, c.p("ADDamage"));
      shield(c.b, c.u, c.p("Shield"), c.v("ShieldDuration"));
    },
  },
  Cinderling: {
    vars: { ADDamage: pct(1, 1.2), WoundLevel: flat(33), BurnAmount: flat(1), WoundDuration: flat(5) },
    cast: (c) => {
      physical(c.b, c.u, c.t, c.p("ADDamage"));
      burn(c.b, c.u, c.t, c.v("BurnAmount") / 100, c.v("WoundDuration"));
      c.t.wound = Math.max(c.t.wound, c.v("WoundLevel") / 100);
      c.t.woundUntil = c.b.time + c.v("WoundDuration");
      beam(c.b, c.u, c.u, c.t);
    },
    notModeled: "Scarlet Buff (a Riftbeast mark chosen between rounds)",
  },
  Karma: {
    vars: { Damage: mag(1, 0.6), SecondaryDamage: mag(1, 0.5), TetherDuration: flat(1.5), AoEHexRange: flat(1), SlowPercent: flat(20), SlowDuration: flat(3) },
    channel: 1.5,
    cast: (c) => {
      const t = c.t;
      const ticks = 6;
      for (let i = 1; i <= ticks; i++) schedule(c.b, (c.v("TetherDuration") * i) / ticks, () => c.u.alive && magic(c.b, c.u, t, c.p("Damage") / ticks));
      schedule(c.b, c.v("TetherDuration"), () => {
        if (!c.u.alive) return;
        area(c.b, c.u, t.row, t.col, c.v("AoEHexRange"));
        for (const e of within(c.b, enemies(c.b, c.u), t.row, t.col, c.v("AoEHexRange"))) {
          magic(c.b, c.u, e, c.p("SecondaryDamage"));
          slowDown(c.b, e, c.v("SlowPercent") / 100, c.v("SlowDuration"));
        }
      });
    },
  },
  Kobuko: {
    vars: { Heal: [0, 350, 400, 475], Duration: flat(2), DamageHPPercent: flat(0.15) },
    cast: (c) => {
      heals(c, c.p("Heal"), c.v("Duration"));
      empowerAttacks(c.u, "bash", 1);
    },
    setup: (c) => {
      c.u.attackOverride = (b, u, t) => {
        if (!useEmpowered(u, "bash")) return false;
        magic(b, u, t, c.v("DamageHPPercent") * u.maxHp * u.power, { attack: true });
        return true;
      };
    },
    notModeled: "Health gained from interest between rounds",
  },
  Leona: {
    vars: { Damage: mag(1, 0.8), StunDuration: [0, 1.5, 1.75, 2], BonusResists: [0, 60, 80, 120], DecayDuration: flat(10) },
    setup: (c) => {
      const r = c.v("BonusResists");
      buff(c.b, c.u, { armor: r / 2, mr: r / 2 }, c.v("DecayDuration") / 2);
      buff(c.b, c.u, { armor: r / 2, mr: r / 2 }, c.v("DecayDuration"));
    },
    cast: (c) => {
      magic(c.b, c.u, c.t, c.p("Damage"));
      stun(c.b, c.t, c.v("StunDuration"));
    },
  },
  Ornn: {
    vars: { Shield: shd(1, 1.1), ShieldDuration: flat(4), Damage: mag(1, 0.7) },
    cast: (c) => {
      shield(c.b, c.u, c.p("Shield"), c.v("ShieldDuration"));
      for (const e of inCone(c.b, c.u, c.t, 2)) magic(c.b, c.u, e, c.p("Damage"));
      area(c.b, c.u, c.t.row, c.t.col, 1);
    },
    notModeled: "his Forge quest (Artifact Anvils between rounds)",
  },
  Pebbles: {
    vars: { DamagePerSecond: mag(1, 0.35), MRReduction: flat(5), ChannelDuration: flat(3) },
    channel: 3,
    cast: (c) => {
      const t = c.t;
      for (let i = 1; i <= 3; i++)
        schedule(c.b, i, () => {
          if (!c.u.alive || !t.alive) return;
          magic(c.b, c.u, t, c.p("DamagePerSecond"));
          t.mrReduction += c.v("MRReduction");
          beam(c.b, c.u, c.u, t);
        });
    },
    notModeled: "Teal Buff (a Riftbeast mark)",
  },
  Rakan: {
    vars: { Shield: shd(1, 1), ShieldDuration: flat(4), AttackSpeed: [0, 0.5, 0.6, 0.8], AttackSpeedDuration: flat(4) },
    cast: (c) => {
      shield(c.b, c.u, c.p("Shield"), c.v("ShieldDuration"));
      const best = allies(c.b, c.u, false).sort((a, z) => z.damageDealt - a.damageDealt)[0];
      if (best) {
        // decaying: full value for half the duration, half for the rest
        buff(c.b, best, { asBonus: c.v("AttackSpeed") / 2 }, c.v("AttackSpeedDuration") / 2);
        buff(c.b, best, { asBonus: c.v("AttackSpeed") / 2 }, c.v("AttackSpeedDuration"));
      }
    },
  },
  "Rek'Sai": {
    vars: { HealPerSecond: [0, 15, 20, 30], SpellMultiplierDuration: flat(3), Damage: mag(1, 0.7), KnockupDuration: flat(1) },
    setup: (c) => every(c.b, c.u, 1, () => heal(c.b, c.u, c.p("HealPerSecond") * ((c.u.stacks.roared ?? 0) > c.b.time ? 3 : 1))),
    cast: (c) => {
      c.u.stacks.roared = c.b.time + c.v("SpellMultiplierDuration");
      area(c.b, c.u, c.u.row, c.u.col, 1);
      for (const e of within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, 1)) {
        magic(c.b, c.u, e, c.p("Damage"));
        stun(c.b, e, c.v("KnockupDuration"));
      }
    },
  },
  Varus: {
    vars: { ADDamage: pct(1, 1.5), DamageReductionPerHit: flat(0.15), MinDamagePercent: flat(0.5) },
    channel: 0.5,
    cast: (c) => {
      const t = bestLine(c.b, c.u) ?? c.t;
      schedule(c.b, 0.5, () => {
        if (!c.u.alive) return;
        beam(c.b, c.u, c.u, t);
        pierce(c, inLine(c.b, c.u, c.u, t), () => c.p("ADDamage"), c.v("DamageReductionPerHit"), c.v("MinDamagePercent"));
      });
    },
  },
  Veigar: {
    vars: { Damage: mag(1, 1), ExecuteDamage: mag(1, 1.5), HPThreshold: flat(0.5), APOnKill: flat(2) },
    cast: (c) => {
      const low = healthPct(c.t) < c.v("HPThreshold");
      magic(c.b, c.u, c.t, c.p(low ? "ExecuteDamage" : "Damage"));
      area(c.b, c.u, c.t.row, c.t.col, 0.7);
      if (!c.t.alive) c.u.ap += c.v("APOnKill");
    },
    notModeled: "Ability Power kept from earlier rounds",
  },
  Xayah: {
    vars: { AttackSpeed: flat(0.6), NumAttacks: flat(5), ADDamage: pct(1, 0.45), ArmorReduction: flat(5) },
    cast: (c) => {
      buff(c.b, c.u, { asBonus: c.v("AttackSpeed") }, 4);
      empowerAttacks(c.u, "feather", c.v("NumAttacks"));
    },
    setup: (c) => {
      c.u.attackOverride = (b, u, t) => {
        if (!useEmpowered(u, "feather")) return false;
        physical(b, u, t, c.p("ADDamage"), { attack: true });
        t.armorReduction += c.v("ArmorReduction");
        beam(b, u, u, t);
        return true;
      };
    },
  },
  Yorick: {
    vars: { Heal: mag(1, 0.9), ADDamage: pct(1, 0.9), SpiritHealth: [0, 500, 750, 1200] },
    cast: (c) => {
      heal(c.b, c.u, c.p("Heal"));
      physical(c.b, c.u, c.t, c.p("ADDamage"));
    },
    setup: (c) =>
      c.u.hooks.death.push(() => {
        const hp = c.p("SpiritHealth") * (1 + (c.u.stacks.summonerHealth ?? 0));
        const s = summon(c.b, c.u, { name: "Spirit Walker", icon: c.u.champion.icon, hp, ad: 40, as: 0.7, range: 1, armor: 30, mr: 30 }, c.u.row, c.u.col);
        if (s) taunt(c.b, s, within(c.b, enemies(c.b, s), s.row, s.col, 2), 3);
      }),
  },

  // ------------------------------------------------------------------ 2-cost
  Alistar: {
    vars: { Heal: mag(2, 0.8), AllyHeal: mag(2, 0.5), Damage: mag(2, 0.6), StunDuration: [0, 1.5, 1.75, 2] },
    cast: (c) => {
      heal(c.b, c.u, c.p("Heal"));
      c.u.stunUntil = 0;
      c.u.sleepUntil = 0;
      for (const a of allies(c.b, c.u, false).sort((a, z) => healthPct(a) - healthPct(z)).slice(0, 2)) heal(c.b, a, c.p("AllyHeal"));
      magic(c.b, c.u, c.t, c.p("Damage"));
      stun(c.b, c.t, c.v("StunDuration"));
    },
  },
  Caitlyn: {
    vars: { ADDamage: pct(2, 1.4) },
    passiveOnly: true,
    setup: (c) => {
      c.u.attackOverride = (b, u, t) => {
        if (u.attacks % 3 !== 0) return false;
        physical(b, u, t, c.p("ADDamage"), { attack: true });
        beam(b, u, u, t);
        return true;
      };
    },
  },
  Elise: {
    vars: { SpiderHealthBuff: [0, 300, 400, 650], BonusDamage: mag(2, 0.2), Heal: mag(2, 0.15), DecayingAS: flat(0.5), ASBuffDuration: flat(4) },
    cast: (c) => {
      if (!c.u.stacks.spider) {
        c.u.stacks.spider = 1;
        addMaxHp(c.u, c.p("SpiderHealthBuff"));
      } else buff(c.b, c.u, { asBonus: c.v("DecayingAS") / 2 }, c.v("ASBuffDuration"));
    },
    setup: (c) =>
      c.u.hooks.attack.push((t) => {
        if (!c.u.stacks.spider) return;
        magic(c.b, c.u, t, c.p("BonusDamage"), { proc: false });
        heal(c.b, c.u, c.p("Heal"));
      }),
  },
  Gromp: {
    vars: { Damage: mag(2, 0.8), PoisonDamage: mag(2, 0.6), PoisonDuration: flat(3), SlowPercent: flat(30), SlowDuration: flat(3) },
    cast: (c) => {
      magic(c.b, c.u, c.t, c.p("Damage"));
      area(c.b, c.u, c.t.row, c.t.col, 1);
      for (const e of within(c.b, enemies(c.b, c.u), c.t.row, c.t.col, 1)) dot(c.b, c.u, e, (c.p("PoisonDamage") * c.u.ap) / 100, c.v("PoisonDuration"), "magic");
      slowDown(c.b, c.t, c.v("SlowPercent") / 100, c.v("SlowDuration"));
    },
    notModeled: "Purple Buff (a Riftbeast mark)",
  },
  Kayle: {
    vars: { BonusDamage: mag(2, 0.15), ShredLevel: flat(20), ShredDuration: flat(3), WaveDamage: mag(2, 0.2) },
    passiveOnly: true,
    setup: (c) =>
      c.u.hooks.attack.push((t) => {
        magic(c.b, c.u, t, c.p("BonusDamage"), { proc: false });
        if (c.u.star >= 2) shred(c.b, t, c.v("ShredLevel") / 100, c.v("ShredDuration"));
        if (c.u.star >= 3) for (const e of inLine(c.b, c.u, c.u, t, 4)) if (e !== t) magic(c.b, c.u, e, c.p("WaveDamage"), { proc: false });
      }),
  },
  LeBlanc: {
    vars: { Damage: mag(2, 1), SplashDamage: mag(2, 0.45) },
    cast: (c) => {
      magic(c.b, c.u, c.t, c.p("Damage"));
      area(c.b, c.u, c.t.row, c.t.col, 1);
      for (const e of within(c.b, enemies(c.b, c.u), c.t.row, c.t.col, 1)) if (e !== c.t) magic(c.b, c.u, e, c.p("SplashDamage"));
    },
    notModeled: "her chance to copy an ally after player combat",
  },
  Murkwolf: {
    vars: { ADDamage: pct(2, 0.9), LeapHexRadius: flat(3), NumEmpoweredAttacks: flat(3), EmpowerAspd: flat(0.5), BonusADDamage: pct(2, 0.25) },
    cast: (c) => {
      const prey = lowestPct(within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.v("LeapHexRadius"))) ?? c.t;
      leapTo(c.b, c.u, prey);
      c.u.target = prey.uid;
      physical(c.b, c.u, prey, c.p("ADDamage"));
      buff(c.b, c.u, { asBonus: c.v("EmpowerAspd") }, 3);
      empowerAttacks(c.u, "wolf", c.v("NumEmpoweredAttacks"));
    },
    setup: (c) => c.u.hooks.attack.push((t) => useEmpowered(c.u, "wolf") && physical(c.b, c.u, t, c.p("BonusADDamage"), { proc: false })),
    notModeled: "Grey Buff (a Riftbeast mark)",
  },
  Scuttlecrab: {
    vars: { ADDamage: pct(2, 0.45), BurrowDurability: flat(0.4), BurrowDuration: flat(2), Heal: mag(2, 1) },
    cast: (c) => {
      buff(c.b, c.u, { durability: c.v("BurrowDurability") }, c.v("BurrowDuration"));
      heals(c, c.p("Heal"), c.v("BurrowDuration"));
    },
    setup: (c) => {
      c.u.attackOverride = (b, u) => {
        area(b, u, u.row, u.col, 1);
        for (const e of within(b, enemies(b, u), u.row, u.col, 1)) physical(b, u, e, c.p("ADDamage"), { attack: true });
        return true;
      };
    },
    notModeled: "Green Buff (a Riftbeast mark)",
  },
  Sejuani: {
    vars: { Shield: shd(2, 1), ShieldDuration: flat(4), Damage: mag(2, 0.6), LineDamage: mag(2, 0.4) },
    cast: (c) => {
      shield(c.b, c.u, c.p("Shield"), c.v("ShieldDuration"));
      for (const e of inCone(c.b, c.u, c.t, 2)) magic(c.b, c.u, e, c.p("Damage"));
      for (const e of inLine(c.b, c.u, c.u, c.t, 4)) magic(c.b, c.u, e, c.p("LineDamage"));
      beam(c.b, c.u, c.u, c.t);
    },
  },
  Shen: {
    vars: { Shield: shd(2, 0.9), AllyShield: shd(2, 0.6), MagicShieldDuration: flat(4), NumAttacksBuff: flat(3), AttackSpeedBuff: flat(0.5), BonusDamage: mag(2, 0.2) },
    cast: (c) => {
      shield(c.b, c.u, c.p("Shield"), c.v("MagicShieldDuration"));
      const ally = nearest(allies(c.b, c.u, false).filter((a) => a.hp < a.maxHp), c.u)[0];
      for (const x of ally ? [c.u, ally] : [c.u]) {
        if (x !== c.u) shield(c.b, x, c.p("AllyShield"), c.v("MagicShieldDuration"));
        buff(c.b, x, { asBonus: c.v("AttackSpeedBuff") }, 3);
        empowerAttacks(x, "shen", c.v("NumAttacksBuff"));
        x.stacks.shenDamage = c.p("BonusDamage");
        if (!x.stacks.shenHooked) {
          x.stacks.shenHooked = 1;
          x.hooks.attack.push((t) => useEmpowered(x, "shen") && magic(c.b, x, t, x.stacks.shenDamage, { proc: false }));
        }
      }
    },
  },
  Teemo: {
    vars: { Damage: mag(2, 0.3), NumEnemiesHit: flat(3), BigDamage: mag(2, 0.7) },
    cast: (c) => {
      for (let k = 0; k < 2; k++) for (const e of nearest(enemies(c.b, c.u), c.u, c.v("NumEnemiesHit"))) magic(c.b, c.u, e, c.p("Damage"));
      magic(c.b, c.u, c.t, c.p("BigDamage"));
      area(c.b, c.u, c.t.row, c.t.col, 1);
    },
    notModeled: "foraged mushrooms (rerolls, Tactician Health, XP)",
  },
  Warwick: {
    vars: { ADDamage: pct(2, 0.9), HealRatio: flat(0.5), AttackSpeedBuff: flat(0.1) },
    cast: (c) => {
      const dealt = physical(c.b, c.u, c.t, c.p("ADDamage"));
      heal(c.b, c.u, dealt * c.v("HealRatio"));
      buff(c.b, c.u, { asBonus: c.v("AttackSpeedBuff") });
    },
  },
  Yunara: {
    vars: { ADDamage: pct(2, 0.9), SplitADDamage: pct(2, 0.4), NumSecondaryTargets: flat(2) },
    cast: (c) => {
      const spot = freeHexNear(c.b, c.u.row, c.u.col, [c.u.row, c.u.col]);
      if (spot) teleport(c.u, spot[0], spot[1]);
      physical(c.b, c.u, c.t, c.p("ADDamage"));
      beam(c.b, c.u, c.u, c.t);
      for (const e of nearest(enemies(c.b, c.u).filter((e) => e !== c.t), c.t, c.v("NumSecondaryTargets"))) physical(c.b, c.u, e, c.p("SplitADDamage"));
    },
  },

  // ------------------------------------------------------------------ 3-cost
  Azir: {
    vars: { AttackSpeed: flat(0.4), SoldiersToSpawn: flat(2), NumAttacks: flat(6), Damage: mag(3, 0.22) },
    cast: (c) => {
      buff(c.b, c.u, { asBonus: c.v("AttackSpeed") }, 5);
      empowerAttacks(c.u, "soldiers", c.v("NumAttacks"));
    },
    setup: (c) => {
      c.u.attackOverride = (b, u, t) => {
        if (!useEmpowered(u, "soldiers")) return false;
        for (let i = 0; i < c.v("SoldiersToSpawn"); i++) magic(b, u, t, c.p("Damage") * (1 + (u.stacks.summonerDamage ?? 0)), { attack: true });
        area(b, u, t.row, t.col, 0.6);
        return true;
      };
    },
  },
  Cassiopeia: {
    vars: { Damage: mag(3, 0.9), Duration: flat(4) },
    cast: (c) => {
      const second = nearest(enemies(c.b, c.u).filter((e) => e !== c.t && !e.dots.some((d) => d.source === c.u && d.until > c.b.time)), c.t)[0];
      for (const e of second ? [c.t, second] : [c.t]) {
        dot(c.b, c.u, e, (c.p("Damage") * c.u.ap) / 100, c.v("Duration"), "magic");
        beam(c.b, c.u, c.u, e);
      }
    },
  },
  Diana: {
    vars: { Shield: shd(3, 0.9), ShieldDuration: flat(4), NumOrbs: flat(4), Damage: mag(3, 0.35) },
    cast: (c) => {
      shield(c.b, c.u, c.p("Shield"), c.v("ShieldDuration"));
      const near = within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, 2);
      area(c.b, c.u, c.u.row, c.u.col, 2);
      for (let i = 0; i < c.v("NumOrbs") && near.length; i++) magic(c.b, c.u, near[i % near.length], c.p("Damage"));
    },
  },
  Fiddlesticks: {
    vars: { NumTargets: flat(3), MRReduction: flat(15), CastDuration: flat(2), Damage: mag(3, 0.55), Heal: mag(3, 0.6) },
    channel: 2,
    cast: (c) => {
      const victims = nearest(enemies(c.b, c.u), c.u, c.v("NumTargets"));
      for (const e of victims) e.mrReduction += c.v("MRReduction");
      const ticks = 4;
      for (let i = 1; i <= ticks; i++)
        schedule(c.b, (c.v("CastDuration") * i) / ticks, () => {
          if (!c.u.alive) return;
          for (const e of victims) if (e.alive) magic(c.b, c.u, e, c.p("Damage") / ticks), beam(c.b, c.u, c.u, e);
          heal(c.b, c.u, c.p("Heal") / ticks);
        });
    },
  },
  Hecarim: {
    vars: { Resists: [0, 40, 50, 70], Heal: mag(3, 0.8), NumEnemies: flat(2), Damage: mag(3, 0.6), StunDuration: flat(1.25) },
    cast: (c) => {
      buff(c.b, c.u, { armor: c.v("Resists"), mr: c.v("Resists") }, 3);
      heals(c, c.p("Heal"), 3);
      for (const e of nearest(enemies(c.b, c.u), c.u, c.v("NumEnemies"))) {
        magic(c.b, c.u, e, c.p("Damage"));
        stun(c.b, e, c.v("StunDuration"));
        beam(c.b, c.u, c.u, e);
      }
    },
  },
  "Kha'Zix": {
    vars: { LeapRangeHexes: flat(3), Damage: mag(3, 0.9), IsolatedDamage: mag(3, 1.4), IsolateManaGrant: flat(15) },
    cast: (c) => {
      const options = within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.v("LeapRangeHexes"));
      const prey = options.sort((a, z) => dist(c.u, z) - dist(c.u, a))[0] ?? c.t;
      leapTo(c.b, c.u, prey);
      c.u.target = prey.uid;
      const isolated = !allies(c.b, prey, false).some((a) => dist(a, prey) <= 1);
      magic(c.b, c.u, prey, c.p(isolated ? "IsolatedDamage" : "Damage"));
      if (isolated) schedule(c.b, 0.05, () => gainMana(c.b, c.u, c.v("IsolateManaGrant")));
    },
    notModeled: "Rival evolutions (picked between rounds)",
  },
  "Kog'Maw": {
    vars: { ADDamage: pct(3, 0.8), LowADDamage: pct(3, 1.2), ADBonusDamageThreshold: flat(0.4), AcidDuration: flat(3) },
    cast: (c) => {
      const other = nearest(enemies(c.b, c.u).filter((e) => e !== c.t), c.t)[0];
      for (const e of other ? [c.t, other] : [c.t]) {
        const low = healthPct(e) < c.v("ADBonusDamageThreshold");
        // the acid deals its damage over time
        dot(c.b, c.u, e, ((c.p(low ? "LowADDamage" : "ADDamage") / 100) * ad(c.u)) * 0.3, c.v("AcidDuration"), "physical");
        physical(c.b, c.u, e, c.p(low ? "LowADDamage" : "ADDamage") * 0.7);
        beam(c.b, c.u, c.u, e);
      }
    },
  },
  Krug: {
    vars: { MaxHealthGain: [0, 150, 200, 350], ADDamage: pct(3, 0.8), KrugletteHealth: [0, 400, 550, 900] },
    cast: (c) => {
      addMaxHp(c.u, c.p("MaxHealthGain"));
      leapTo(c.b, c.u, c.t);
      physical(c.b, c.u, c.t, c.p("ADDamage") + (c.u.maxHp * 0.05 * 100) / ad(c.u));
    },
    setup: (c) =>
      c.u.hooks.death.push(() => {
        for (let i = 0; i < 2; i++) {
          const s = summon(c.b, c.u, { name: "Kruglette", icon: c.u.champion.icon, hp: c.p("KrugletteHealth"), ad: 45, as: 0.75, range: 1, armor: 40, mr: 40 }, c.u.row, c.u.col);
          if (s) taunt(c.b, s, within(c.b, enemies(c.b, s), s.row, s.col, 2), 2);
        }
      }),
    notModeled: "Slate Buff (a Riftbeast mark)",
  },
  "Mama Beak": {
    vars: { Duration: flat(6), ADDamage: pct(3, 0.12), Beaks: flat(4) },
    cast: (c) => {
      c.u.stacks.beaksUntil = c.b.time + c.v("Duration");
    },
    setup: (c) =>
      c.u.hooks.attack.push((t) => {
        if ((c.u.stacks.beaksUntil ?? 0) <= c.b.time) return;
        for (let i = 0; i < c.v("Beaks"); i++) physical(c.b, c.u, t, c.p("ADDamage") * (1 + (c.u.stacks.summonerDamage ?? 0)), { proc: false });
      }),
    notModeled: "Orange Buff (a Riftbeast mark)",
  },
  "Master Yi": {
    vars: { AttackSpeed: flat(0.08) },
    passiveOnly: true,
    setup: (c) => {
      c.u.attackOverride = (b, u, t) => {
        if (u.attacks % 3 !== 0) return false;
        // a Double Strike: two hits, and stacking Attack Speed
        for (let i = 0; i < 2; i++) damage(b, u, t, ad(u), "physical", { attack: true });
        buff(b, u, { asBonus: c.v("AttackSpeed") });
        return true;
      };
    },
  },
  Rammus: {
    vars: { Duration: flat(3), Shield: shd(3, 1), ArmorMR: [0, 40, 50, 80], ADDamage: pct(3, 0.7), DamageHexRange: flat(1) },
    cast: (c) => {
      taunt(c.b, c.u, within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, 2), c.v("Duration"));
      shield(c.b, c.u, c.p("Shield"), c.v("Duration"));
      buff(c.b, c.u, { armor: c.v("ArmorMR"), mr: c.v("ArmorMR") }, c.v("Duration"));
      schedule(c.b, c.v("Duration"), () => {
        if (!c.u.alive) return;
        area(c.b, c.u, c.u.row, c.u.col, c.v("DamageHexRange"));
        for (const e of within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.v("DamageHexRange"))) physical(c.b, c.u, e, c.p("ADDamage"));
      });
    },
  },
  Rengar: {
    vars: { JumpHexRange: flat(3), ADDamage: pct(3, 1), Heal: mag(3, 0.4), MaxHeal: mag(3, 0.9) },
    cast: (c) => {
      const prey = lowestPct(within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.v("JumpHexRange"))) ?? c.t;
      leapTo(c.b, c.u, prey);
      c.u.target = prey.uid;
      const missing = 1 - healthPct(prey);
      physical(c.b, c.u, prey, c.p("ADDamage"));
      heal(c.b, c.u, c.p("Heal") + (c.p("MaxHeal") - c.p("Heal")) * missing);
    },
    notModeled: "Rival takedown rewards (gold and team Attack Damage over many games)",
  },
  Tristana: {
    vars: { Duration: flat(4), AttackSpeed: flat(0.5), ADDamage: pct(3, 0.9), ADDamagePerAttack: pct(3, 0.15) },
    cast: (c) => {
      const start = c.u.attacks;
      buff(c.b, c.u, { asBonus: c.v("AttackSpeed"), range: 8 }, c.v("Duration"));
      let carrier = c.t;
      schedule(c.b, c.v("Duration"), () => {
        if (!c.u.alive) return;
        if (!carrier.alive) carrier = c.u.target != null ? c.b.units[c.u.target] ?? carrier : carrier;
        const hit = within(c.b, enemies(c.b, c.u), carrier.row, carrier.col, 2);
        area(c.b, c.u, carrier.row, carrier.col, 2);
        const total = c.p("ADDamage") + c.p("ADDamagePerAttack") * (c.u.attacks - start);
        for (const e of hit) physical(c.b, c.u, e, total / Math.max(1, hit.length) * 2);
      });
    },
  },
  Vi: {
    vars: { HealOnAttack: [0, 20, 25, 40], Heal: mag(3, 0.7), SpellAS: flat(0.6), SpellDurability: flat(0.2), SpellDuration: flat(3) },
    setup: (c) => c.u.hooks.attack.push(() => heal(c.b, c.u, c.p("HealOnAttack"))),
    cast: (c) => {
      heal(c.b, c.u, c.p("Heal"));
      buff(c.b, c.u, { asBonus: c.v("SpellAS"), durability: c.v("SpellDurability") }, c.v("SpellDuration"));
      c.u.ccImmuneUntil = Math.max(c.u.ccImmuneUntil, c.b.time + c.v("SpellDuration"));
    },
  },

  // ------------------------------------------------------------------ 4-cost
  Ahri: {
    vars: { AbilityCenterHexRange: flat(4), Damage: mag(4, 0.8), HexRadius: flat(2), FalloffPerHex: flat(0.25) },
    cast: (c) => {
      const center = bestCluster(c.b, c.u, c.v("HexRadius"), c.v("AbilityCenterHexRange")) ?? c.t;
      area(c.b, c.u, center.row, center.col, c.v("HexRadius"));
      for (const e of within(c.b, enemies(c.b, c.u), center.row, center.col, c.v("HexRadius")))
        magic(c.b, c.u, e, c.p("Damage") * (1 - c.v("FalloffPerHex") * dist(e, center)));
    },
  },
  Amumu: {
    vars: { HealPerSecond: [0, 25, 35, 100], PassiveDamage: mag(4, 0.06), PassiveHexRadius: flat(1), Damage: mag(4, 0.5), BigHexRadius: flat(2), StunDuration: flat(1.5), BurningStunDuration: flat(2.5) },
    setup: (c) =>
      every(c.b, c.u, 1, () => {
        heal(c.b, c.u, c.p("HealPerSecond"));
        for (const e of within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.v("PassiveHexRadius"))) magic(c.b, c.u, e, c.p("PassiveDamage"), { proc: false });
      }),
    cast: (c) => {
      area(c.b, c.u, c.u.row, c.u.col, c.v("BigHexRadius"));
      for (const e of within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.v("BigHexRadius"))) {
        magic(c.b, c.u, e, c.p("Damage"));
        stun(c.b, e, burning(c, e) ? c.v("BurningStunDuration") : c.v("StunDuration"));
      }
    },
  },
  Aphelios: {
    vars: { Swipes: flat(4), Duration: flat(1.5), ADDamage: pct(4, 0.35), BlastADDamage: pct(4, 1.2) },
    channel: 1.5,
    cast: (c) => {
      const t = c.t;
      const n = c.v("Swipes");
      for (let i = 1; i <= n; i++) schedule(c.b, (c.v("Duration") * i) / n, () => c.u.alive && t.alive && physical(c.b, c.u, t, c.p("ADDamage")));
      schedule(c.b, c.v("Duration"), () => {
        if (!c.u.alive) return;
        const hit = within(c.b, enemies(c.b, c.u), t.row, t.col, 2);
        area(c.b, c.u, t.row, t.col, 2);
        for (const e of hit) physical(c.b, c.u, e, (c.p("BlastADDamage") / Math.max(1, hit.length)) * 1.5);
      });
    },
  },
  Brambleback: {
    vars: { LeapADDamage: pct(4, 0.6), FrenzyADPercent: flat(0.6), Duration: flat(5), ArmorIgnore: flat(0.5) },
    cast: (c) => {
      buff(c.b, c.u, { adMult: c.v("FrenzyADPercent") }, c.v("Duration"));
      c.u.stacks.frenzyUntil = c.b.time + c.v("Duration");
    },
    setup: (c) => {
      c.u.hooks.kill.push(() => {
        const next = nearest(enemies(c.b, c.u), c.u)[0];
        if (!next) return;
        leapTo(c.b, c.u, next);
        c.u.target = next.uid;
        physical(c.b, c.u, next, c.p("LeapADDamage"));
      });
      // Frenzy: ignore part of the target's Armor
      c.u.hooks.dealMult.push((h) => (h.kind === "physical" && (c.u.stacks.frenzyUntil ?? 0) > c.b.time ? 1 + c.v("ArmorIgnore") * Math.min(1, h.target.armor / 100) : 1));
    },
    notModeled: "Red Buff (a Riftbeast mark)",
  },
  Ezreal: {
    vars: { ADDamage: pct(4, 0.8), AttackSpeed: flat(0.15), BlastADDamage: pct(4, 1.8), DamageReductionPerHit: flat(0.15), MinDamagePercent: flat(0.4) },
    cast: (c) => {
      const away = freeHexNear(c.b, c.u.row + (c.u.team === 0 ? 1 : -1), c.u.col);
      if (away) teleport(c.u, away[0], away[1]);
      physical(c.b, c.u, c.t, c.p("ADDamage"));
      beam(c.b, c.u, c.u, c.t);
      c.u.stacks.casts4 = (c.u.stacks.casts4 ?? 0) + 1;
      if (c.u.stacks.casts4 % 4 === 0) {
        buff(c.b, c.u, { asBonus: -(c.u.stacks.flurry ?? 0) });
        c.u.stacks.flurry = 0;
        const line = bestLine(c.b, c.u) ?? c.t;
        beam(c.b, c.u, c.u, line);
        pierce(c, inLine(c.b, c.u, c.u, line), () => c.p("BlastADDamage"), c.v("DamageReductionPerHit"), c.v("MinDamagePercent"));
      } else {
        buff(c.b, c.u, { asBonus: c.v("AttackSpeed") });
        c.u.stacks.flurry = (c.u.stacks.flurry ?? 0) + c.v("AttackSpeed");
      }
    },
  },
  Lillia: {
    vars: { Heal: mag(4, 0.6), NumEnemiesToFireAt: flat(3), Damage: mag(4, 0.45), SleepDuration: flat(2), DamageNeededToAwaken: flat(300), WakeupDamage: flat(0.08) },
    cast: (c) => {
      heal(c.b, c.u, c.p("Heal"));
      for (const e of nearest(enemies(c.b, c.u), c.u, c.v("NumEnemiesToFireAt"))) {
        magic(c.b, c.u, e, c.p("Damage"));
        beam(c.b, c.u, c.u, e);
        sleep(c.b, e, c.v("SleepDuration"), c.v("DamageNeededToAwaken"));
        e.stacks.lilliaWake = 1;
        const wake = (h: { source: Unit }) => {
          if (e.stacks.lilliaWake && e.sleepUntil <= c.b.time) {
            e.stacks.lilliaWake = 0;
            magic(c.b, c.u, e, (c.v("WakeupDamage") * e.maxHp * 100) / c.u.ap, { proc: false });
          }
          return h;
        };
        e.hooks.hurt.push(wake);
      }
    },
  },
  Malphite: {
    vars: { Shield: shd(4, 1.1), ShieldDuration: flat(4), Damage: mag(4, 0.6), AoEHexRange: flat(2) },
    cast: (c) => {
      shield(c.b, c.u, c.p("Shield"), c.v("ShieldDuration"));
      c.u.ccImmuneUntil = Math.max(c.u.ccImmuneUntil, c.b.time + c.v("ShieldDuration"));
      const check = () => {
        if (!c.u.alive || c.u.stacks.malphiteDone) return;
        if (shieldTotal(c.b, c.u) <= 1) {
          c.u.stacks.malphiteDone = 1;
          area(c.b, c.u, c.u.row, c.u.col, c.v("AoEHexRange"));
          for (const e of within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.v("AoEHexRange"))) magic(c.b, c.u, e, c.p("Damage"));
        }
      };
      c.u.stacks.malphiteDone = 0;
      for (let i = 1; i <= 16; i++) schedule(c.b, i * 0.25, check);
    },
  },
  Morgana: {
    vars: { Omnivamp: flat(0.2), NumEnemiesCursed: flat(3), Damage: mag(4, 0.45), SpellDuration: flat(4), ZoneDamagePerSecond: mag(4, 0.12), HexRangeAOE: flat(1), CurseAmp: flat(0.1) },
    setup: (c) => buff(c.b, c.u, { omnivamp: c.v("Omnivamp") }),
    cast: (c) => {
      for (const e of nearest(enemies(c.b, c.u), c.u, c.v("NumEnemiesCursed"))) {
        magic(c.b, c.u, e, c.p("Damage"));
        vulnerable(c.b, e, c.v("CurseAmp"), c.v("SpellDuration"));
        beam(c.b, c.u, c.u, e);
      }
      const center = c.t;
      area(c.b, c.u, center.row, center.col, c.v("HexRangeAOE"));
      every(c.b, c.u, 1, () => {
        for (const e of within(c.b, enemies(c.b, c.u), center.row, center.col, c.v("HexRangeAOE"))) magic(c.b, c.u, e, c.p("ZoneDamagePerSecond"), { proc: false });
      }, c.v("SpellDuration"));
    },
  },
  Nidalee: {
    vars: { BonusAttackSpeed: flat(0.5), NumEmpoweredAttacks: flat(3), Damage: mag(4, 0.35), ThirdDamage: mag(4, 0.8) },
    cast: (c) => {
      buff(c.b, c.u, { asBonus: c.v("BonusAttackSpeed") }, 4);
      empowerAttacks(c.u, "javelin", c.v("NumEmpoweredAttacks"));
    },
    setup: (c) => {
      c.u.attackOverride = (b, u, t) => {
        if (!useEmpowered(u, "javelin")) return false;
        if (u.stacks.javelin === 0) {
          const far = enemies(b, u).sort((a, z) => a.items.length - z.items.length || dist(u, z) - dist(u, a))[0] ?? t;
          magic(b, u, far, c.p("ThirdDamage"), { attack: true });
          beam(b, u, u, far);
        } else magic(b, u, t, c.p("Damage"), { attack: true });
        return true;
      };
    },
  },
  Sentinel: {
    vars: { Shield: shd(4, 1), ShieldDuration: flat(4), Damage: mag(4, 0.6), KnockupDuration: flat(1), ManaReaveFlat: flat(20) },
    cast: (c) => {
      shield(c.b, c.u, c.p("Shield"), c.v("ShieldDuration"));
      const toward = bestLine(c.b, c.u, 5) ?? c.t;
      beam(c.b, c.u, c.u, toward);
      for (const e of inLine(c.b, c.u, c.u, toward, 5)) {
        magic(c.b, c.u, e, c.p("Damage"));
        stun(c.b, e, c.v("KnockupDuration"));
        e.manaReave += c.v("ManaReaveFlat");
      }
    },
    notModeled: "Blue Buff (a Riftbeast mark)",
  },
  Sett: {
    vars: { ManaHPThreshold: flat(0.5), Heal: mag(4, 0.7), ADDamage: pct(4, 1.2) },
    channel: 0.75,
    setup: (c) =>
      c.u.hooks.hurt.push(() => {
        if (!c.u.stacks.settMana && healthPct(c.u) < c.v("ManaHPThreshold")) {
          c.u.stacks.settMana = 1;
          gainMana(c.b, c.u, 100);
        }
      }),
    cast: (c) => {
      heals(c, c.p("Heal"), 0.75);
      const t = c.t;
      schedule(c.b, 0.75, () => {
        if (!c.u.alive) return;
        area(c.b, c.u, t.row, t.col, 1.5);
        for (const e of inCone(c.b, c.u, t, 3)) physical(c.b, c.u, e, c.p("ADDamage"));
      });
    },
  },
  Sivir: {
    vars: { ADDamage: pct(4, 0.8), NumBounces: flat(4), BounceADDamage: pct(4, 0.45), BonusKillBounces: flat(2) },
    cast: (c) => {
      physical(c.b, c.u, c.t, c.p("ADDamage"));
      let at = c.t;
      let bounces = c.v("NumBounces") + (c.t.alive ? 0 : c.v("BonusKillBounces"));
      const hit = new Set([at.uid]);
      while (bounces-- > 0) {
        const next = nearest(enemies(c.b, c.u).filter((e) => !hit.has(e.uid) || enemies(c.b, c.u).length <= hit.size), at)[0];
        if (!next) break;
        beam(c.b, c.u, at, next);
        physical(c.b, c.u, next, c.p("BounceADDamage"));
        if (!next.alive) bounces += c.v("BonusKillBounces");
        hit.add(next.uid);
        at = next;
      }
    },
  },
  Soraka: {
    vars: { Damage: mag(4, 0.75), NumAdditionalStars: flat(2), StarDamage: mag(4, 0.35) },
    cast: (c) => {
      magic(c.b, c.u, c.t, c.p("Damage"));
      area(c.b, c.u, c.t.row, c.t.col, 0.8);
      if (c.t.stacks.starred) for (let i = 0; i < c.v("NumAdditionalStars"); i++) magic(c.b, c.u, c.t, c.p("StarDamage"));
      c.t.stacks.starred = 1;
    },
  },
  Zyra: {
    vars: { NumPlantsToSpawn: flat(2), ThornSpitterNumAttacks: flat(4), Damage: mag(4, 0.2) },
    cast: (c) => {
      for (let i = 0; i < c.v("NumPlantsToSpawn"); i++) {
        const near = c.t;
        const plant = summon(c.b, c.u, { name: "Thorn Spitter", icon: c.u.champion.icon, hp: 300, ad: 0, as: 1, range: 4, armor: 20, mr: 20, rooted: true }, near.row + (c.u.team === 0 ? 2 : -2), near.col);
        if (!plant) continue;
        plant.stacks.zyraPlant = 1;
        let left = c.v("ThornSpitterNumAttacks") + (c.u.stacks.summonerAttacks ?? 0);
        plant.attackOverride = (b, p, t) => {
          magic(b, c.u, t, c.p("Damage"), { proc: false });
          beam(b, c.u, p, t);
          if (--left <= 0) {
            p.alive = false;
            b.events.push({ t: b.time, kind: "death", from: p.uid, to: p.uid });
          }
          return true;
        };
      }
    },
  },

  // ------------------------------------------------------------------ 5-cost
  Alune: {
    vars: { NumMoonshards: flat(8), NumEnemies: flat(3), PrimaryMagicDamage: [0, 160, 240, 380], MagicDamage: [0, 380, 570, 900], ShredPercent: flat(20), ShredDuration: flat(6) },
    cast: (c) => {
      const phase = (c.u.stacks.moon ?? 0) % 4;
      c.u.stacks.moon = phase + 1;
      if (phase === 3) {
        const all = enemies(c.b, c.u);
        for (const e of all) {
          magic(c.b, c.u, e, (c.p("MagicDamage") * 3) / Math.max(1, all.length));
          shred(c.b, e, c.v("ShredPercent") / 100, c.v("ShredDuration"));
        }
        area(c.b, c.u, c.t.row, c.t.col, 3);
      } else {
        const targets = nearest(enemies(c.b, c.u), c.u, c.v("NumEnemies"));
        for (let i = 0; i < c.v("NumMoonshards") && targets.length; i++) {
          const e = targets[i % targets.length];
          magic(c.b, c.u, e, c.p("PrimaryMagicDamage") / 2);
          shred(c.b, e, c.v("ShredPercent") / 100, c.v("ShredDuration"));
        }
      }
    },
  },
  Ashe: {
    vars: { ADDamage: pct(5, 1.4), DamageFalloffPerEnemy: flat(0.1), MinDamagePercent: flat(0.5), RiftDuration: flat(4), TrailADDamage: pct(5, 0.15), MaxHealthDamagePerSecond: flat(0.02), ChillPercent: flat(30), ManaRefund: flat(0.5) },
    cast: (c) => {
      const toward = bestLine(c.b, c.u) ?? c.t;
      const hit = inLine(c.b, c.u, c.u, toward);
      beam(c.b, c.u, c.u, toward);
      if (!hit.length) return void (c.u.mana = c.u.maxMana * c.v("ManaRefund"));
      pierce(c, hit, () => c.p("ADDamage"), c.v("DamageFalloffPerEnemy"), c.v("MinDamagePercent"));
      const from = c.u;
      every(c.b, c.u, 1, () => {
        for (const e of inLine(c.b, from, from, toward)) {
          physical(c.b, c.u, e, c.p("TrailADDamage") + (c.v("MaxHealthDamagePerSecond") * e.maxHp * 100) / ad(c.u), { proc: false });
          slowDown(c.b, e, c.v("ChillPercent") / 100, 1.2);
        }
      }, c.v("RiftDuration"));
    },
  },
  Draven: {
    vars: { BleedADDamage: pct(5, 0.3), BleedDuration: flat(3), SpinChance: flat(0.25), SpinningAxeDamageRatio: flat(0.5), AxeADDamage: pct(5, 1.6), ReturnADDamage: pct(5, 0.5), ManaRefund: flat(0.5) },
    setup: (c) => {
      c.u.attackOverride = (b, u) => {
        const inRange = enemies(b, u).filter((e) => dist(u, e) <= u.range);
        if (!inRange.length) return false;
        const t = inRange[Math.floor(b.rng() * inRange.length)];
        const spin = b.rng() < c.v("SpinChance");
        damage(b, u, t, ad(u) * (spin ? 1 + c.v("SpinningAxeDamageRatio") : 1), "physical", { attack: true });
        for (let i = 0; i < (spin ? 2 : 1); i++) dot(b, u, t, (c.p("BleedADDamage") / 100) * ad(u), c.v("BleedDuration"), "physical");
        t.stacks.bleeds = (t.stacks.bleeds ?? 0) + (spin ? 2 : 1);
        beam(b, u, u, t);
        return true;
      };
    },
    cast: (c) => {
      const mark = enemies(c.b, c.u).sort((a, z) => (z.stacks.bleeds ?? 0) - (a.stacks.bleeds ?? 0))[0] ?? c.t;
      const hit = inLine(c.b, c.u, c.u, mark);
      beam(c.b, c.u, c.u, mark);
      if (!hit.length) return void (c.u.mana = c.u.maxMana * c.v("ManaRefund"));
      for (const e of hit) {
        // consume bleeds: the rest of their damage at once
        const rest = e.dots.filter((d) => d.source === c.u && d.until > c.b.time).reduce((s, d) => s + d.perSec * (d.until - c.b.time), 0);
        e.dots = e.dots.filter((d) => d.source !== c.u);
        e.stacks.bleeds = 0;
        physical(c.b, c.u, e, c.p("AxeADDamage"));
        if (rest > 0) damage(c.b, c.u, e, rest, "physical", { proc: false });
      }
      schedule(c.b, 0.6, () => c.u.alive && hit.forEach((e) => e.alive && physical(c.b, c.u, e, c.p("ReturnADDamage"), { proc: false })));
    },
  },
  "Elder Dragon": {
    vars: { AttackAoERatio: flat(0.3), StunDuration: flat(1.5), Omnivamp: flat(0.2), IgniteDuration: flat(4), IgniteMaxHealthDamage: flat(0.03), BreathADDamage: pct(5, 1.1), DamageReductionPerHit: flat(0.15), MinimumDamageThreshold: flat(0.5) },
    setup: (c) =>
      c.u.hooks.attack.push((t) => {
        for (const e of within(c.b, enemies(c.b, c.u), t.row, t.col, 1)) if (e !== t) damage(c.b, c.u, e, ad(c.u) * c.v("AttackAoERatio"), "physical", { proc: false });
      }),
    cast: (c) => {
      if (!c.u.stacks.flown) {
        c.u.stacks.flown = 1;
        c.u.invulnerableUntil = c.b.time + 1.5;
        c.u.untargetableUntil = c.b.time + 1.5;
        c.u.castingUntil = c.b.time + 1.5;
        schedule(c.b, 1.5, () => {
          if (!c.u.alive) return;
          area(c.b, c.u, 3.5, 3, 4);
          buff(c.b, c.u, { omnivamp: c.v("Omnivamp") });
          for (const e of enemies(c.b, c.u)) {
            stun(c.b, e, c.v("StunDuration"));
            burn(c.b, c.u, e, c.v("IgniteMaxHealthDamage"), c.v("IgniteDuration"), "ignite");
          }
          breath(c);
        });
      } else breath(c);
    },
  },
  Gnar: {
    vars: { TransformSearchRadius: flat(3), TransformHexRadius: flat(1), TransformADDamage: pct(5, 1.2), ResistReduction: flat(20), StunDuration: flat(1), MegaHealth: [0, 600, 900, 5000], ThrowADDamage: pct(5, 1.5), PassThroughADDamage: pct(5, 0.6) },
    setup: (c) => {
      // Rage: mana from attacks and every second, on top of the usual
      every(c.b, c.u, 1, () => gainMana(c.b, c.u, 5));
    },
    cast: (c) => {
      if (!c.u.stacks.mega) {
        c.u.stacks.mega = 1;
        const center = bestCluster(c.b, c.u, 1, c.v("TransformSearchRadius")) ?? c.t;
        leapTo(c.b, c.u, center);
        addMaxHp(c.u, c.p("MegaHealth"));
        c.u.range = 1;
        area(c.b, c.u, c.u.row, c.u.col, c.v("TransformHexRadius"));
        for (const e of within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.v("TransformHexRadius"))) {
          physical(c.b, c.u, e, c.p("TransformADDamage"));
          e.armorReduction += c.v("ResistReduction");
          e.mrReduction += c.v("ResistReduction");
          stun(c.b, e, c.v("StunDuration"));
        }
      } else {
        const others = enemies(c.b, c.u).filter((e) => e !== c.t);
        const far = others.sort((a, z) => dist(c.t, z) - dist(c.t, a))[0];
        if (!far) return void physical(c.b, c.u, c.t, c.p("ThrowADDamage") * 2); // thrown off the board
        for (const e of inLine(c.b, c.u, c.t, far)) if (e !== far) physical(c.b, c.u, e, c.p("PassThroughADDamage"));
        physical(c.b, c.u, far, c.p("ThrowADDamage"));
        physical(c.b, c.u, c.t, c.p("ThrowADDamage"));
        beam(c.b, c.u, c.t, far);
        const land = freeHexNear(c.b, far.row, far.col);
        if (land) teleport(c.t, land[0], land[1]);
      }
    },
  },
  Ivern: {
    vars: { NumAlliesToShield: flat(3), Shield: shd(5, 0.6), DamageAmpAmount: flat(0.15), ShieldDuration: flat(4), Damage: mag(5, 0.25), CastThreshold: flat(3), AttackSpeed: flat(0.15) },
    cast: (c) => {
      const team = allies(c.b, c.u).sort((a, z) => z.damageDealt - a.damageDealt).slice(0, c.v("NumAlliesToShield"));
      for (const a of team) {
        const crit = c.u.precision && c.b.rng() < c.u.crit ? c.u.critMult : 1;
        shield(c.b, a, c.p("Shield") * crit, c.v("ShieldDuration"));
        buff(c.b, a, { amp: c.v("DamageAmpAmount") }, c.v("ShieldDuration"));
        if (c.u.casts >= c.v("CastThreshold")) buff(c.b, a, { asBonus: c.v("AttackSpeed") });
        for (const e of within(c.b, enemies(c.b, c.u), a.row, a.col, 1)) magic(c.b, c.u, e, c.p("Damage"));
      }
    },
    notModeled: "Greenfather's seeds and grown hexes",
  },
  Kennen: {
    vars: { APPerBurningEnemy: flat(10), Shield: shd(5, 0.6), ShieldDuration: flat(3), Damage: mag(5, 0.4), FirestormHexRadius: flat(2), FirestormDamage: mag(5, 1.2), FirestormDuration: flat(3) },
    cast: (c) => {
      c.u.ap += c.v("APPerBurningEnemy") * enemies(c.b, c.u).filter((e) => burning(c, e)).length;
      shield(c.b, c.u, c.p("Shield"), c.v("ShieldDuration"));
      const center = bestCluster(c.b, c.u, 1, 4) ?? c.t;
      for (const e of within(c.b, enemies(c.b, c.u), center.row, center.col, 1)) magic(c.b, c.u, e, c.p("Damage"));
      leapTo(c.b, c.u, center);
      const [r, col] = [c.u.row, c.u.col];
      area(c.b, c.u, r, col, c.v("FirestormHexRadius"));
      const ticks = 6;
      for (let i = 1; i <= ticks; i++)
        schedule(c.b, (c.v("FirestormDuration") * i) / ticks, () => {
          if (!c.u.alive) return;
          const hit = within(c.b, enemies(c.b, c.u), r, col, c.v("FirestormHexRadius"));
          for (const e of hit) magic(c.b, c.u, e, c.p("FirestormDamage") / ticks / Math.max(1, hit.length) * 2, { proc: false });
        });
    },
  },
  Lux: {
    vars: { ManaCalc: flat(10), Damage: mag(5, 0.9), DamageReductionPerUnit: flat(0.15), MinimumFalloffDamageRatio: flat(0.4), BlackthornStunDuration: flat(1), BlossomBonusDamageRatio: flat(0.5), CovenResistReduction: flat(15), ElderwoodHealthIncrease: flat(0.04), FaeHealRatio: flat(0.25), InfernoManaRestore: flat(20), LunarVulnerablePercent: flat(15), LunarVulnerableDuration: flat(4), PrimalAttackSpeed: flat(0.4), PrimalASDuration: flat(4), SolarBonusDamageRatio: flat(0.2), SolarBonusDamagePer3StarRadio: flat(0.1) },
    setup: (c) => {
      if (luxVariant(c.u) === "Inferno") c.u.hooks.kill.push(() => gainMana(c.b, c.u, c.v("InfernoManaRestore")));
    },
    cast: (c) => {
      const variant = luxVariant(c.u);
      for (const a of allies(c.b, c.u, false)) if (a.champion.traits.some((t) => c.u.champion.traits.includes(t))) gainMana(c.b, a, c.v("ManaCalc"));
      const toward = bestLine(c.b, c.u) ?? c.t;
      beam(c.b, c.u, c.u, toward);
      let total = 0;
      let bonus = 1;
      if (variant === "Solar") bonus += c.v("SolarBonusDamageRatio") + c.v("SolarBonusDamagePer3StarRadio") * new Set(allies(c.b, c.u).filter((a) => a.star >= 3).map((a) => a.champion.id)).size;
      inLine(c.b, c.u, c.u, toward).forEach((e, i) => {
        const falloff = Math.max(c.v("MinimumFalloffDamageRatio"), 1 - c.v("DamageReductionPerUnit") * i);
        total += magic(c.b, c.u, e, c.p("Damage") * falloff * bonus * (variant === "Blossom" && i === 0 ? 1 + c.v("BlossomBonusDamageRatio") : 1));
        if (variant === "Blackthorn") stun(c.b, e, c.v("BlackthornStunDuration"));
        if (variant === "Coven") (e.armorReduction += c.v("CovenResistReduction")), (e.mrReduction += c.v("CovenResistReduction"));
        if (variant === "Lunar") vulnerable(c.b, e, c.v("LunarVulnerablePercent") / 100, c.v("LunarVulnerableDuration"));
      });
      if (variant === "Elderwood") for (const a of allies(c.b, c.u)) addMaxHp(a, a.maxHp * c.v("ElderwoodHealthIncrease"));
      if (variant === "Fae") {
        const low = lowestPct(allies(c.b, c.u));
        if (low) heal(c.b, low, total * c.v("FaeHealRatio"));
      }
      if (variant === "Primal") buff(c.b, c.u, { asBonus: c.v("PrimalAttackSpeed") }, c.v("PrimalASDuration"));
    },
  },
  Maokai: {
    vars: { DamageMitigatedPerSapling: flat(400), SaplingDamage: mag(5, 0.25), SaplingsOnDeath: flat(3), Damage: mag(5, 0.7), Heal: mag(5, 0.6), ActiveMissingHealthHeal: flat(0.15) },
    setup: (c) => {
      const sapling = () => {
        const e = nearest(enemies(c.b, c.u), c.u)[0];
        if (!e) return;
        magic(c.b, c.u, e, c.p("SaplingDamage"), { proc: false });
        area(c.b, c.u, e.row, e.col, 0.6);
      };
      c.u.hooks.hurt.push((h) => {
        // damage blocked: what Armor, Magic Resist and Durability took off
        c.u.stacks.blocked = (c.u.stacks.blocked ?? 0) + Math.max(0, h.raw - h.dealt);
        while (c.u.stacks.blocked >= c.v("DamageMitigatedPerSapling")) {
          c.u.stacks.blocked -= c.v("DamageMitigatedPerSapling");
          sapling();
        }
      });
      c.u.hooks.death.push(() => {
        for (let i = 0; i < c.v("SaplingsOnDeath"); i++) sapling();
      });
    },
    cast: (c) => {
      magic(c.b, c.u, c.t, c.p("Damage"));
      heal(c.b, c.u, c.p("Heal") + (c.u.maxHp - c.u.hp) * c.v("ActiveMissingHealthHeal"));
    },
  },
  Taric: {
    vars: { PassivePercentHealthThreshold: flat(0.4), PassiveShield: shd(5, 0.5), PassiveHexRadius: flat(2), PassiveShieldDuration: flat(4), Heal: mag(5, 0.6), BonusDamage: mag(5, 0.2), NumAttacks: flat(3) },
    setup: (c) => {
      // Emerald Aspect pairs Taric with an ally between rounds; here, the nearest one.
      const pair = nearest(allies(c.b, c.u, false), c.u)[0];
      c.u.stacks.pair = pair ? pair.uid : -1;
      const burst = () => {
        if (c.u.stacks.taricBurst) return;
        c.u.stacks.taricBurst = 1;
        for (const from of pair && pair.alive ? [c.u, pair] : [c.u]) {
          area(c.b, c.u, from.row, from.col, c.v("PassiveHexRadius"));
          for (const a of within(c.b, allies(c.b, c.u), from.row, from.col, c.v("PassiveHexRadius"))) shield(c.b, a, c.p("PassiveShield"), c.v("PassiveShieldDuration"));
        }
      };
      for (const x of pair ? [c.u, pair] : [c.u]) x.hooks.hurt.push(() => healthPct(x) < c.v("PassivePercentHealthThreshold") && burst());
    },
    cast: (c) => {
      heal(c.b, c.u, c.p("Heal"));
      const pair = c.b.units.find((x) => x.uid === c.u.stacks.pair && x.alive);
      for (const x of pair ? [c.u, pair] : [c.u]) {
        empowerAttacks(x, "taric", c.v("NumAttacks"));
        x.stacks.taricDamage = c.p("BonusDamage");
        if (!x.stacks.taricHooked) {
          x.stacks.taricHooked = 1;
          x.hooks.attack.push((t) => useEmpowered(x, "taric") && magic(c.b, c.u, t, x.stacks.taricDamage, { proc: false }));
        }
      }
    },
    notModeled: "Emerald Aspect pairing is picked between rounds; the simulator pairs Taric with his nearest ally",
  },
};

function breath(c: Ctx): void {
  const toward = bestLine(c.b, c.u, 4) ?? c.t;
  beam(c.b, c.u, c.u, toward);
  inLine(c.b, c.u, c.u, toward, 4).forEach((e, i) => {
    physical(c.b, c.u, e, c.p("BreathADDamage") * Math.max(c.v("MinimumDamageThreshold"), 1 - c.v("DamageReductionPerHit") * i));
    burn(c.b, c.u, e, c.v("IgniteMaxHealthDamage"), c.v("IgniteDuration"), "ignite");
  });
}

/** The spell definition for a champion ("Lux (Fae)" uses Lux's). */
export function spellFor(name: string): SpellDef | undefined {
  return SPELLS[name] ?? SPELLS[name.split(" (")[0]];
}

/** Which of a spell's values come from the game data, and which are estimates. */
export function spellCoverage(name: string, real: Record<string, number[]>): { real: string[]; estimated: string[] } {
  const def = spellFor(name);
  const keys = Object.keys(def?.vars ?? {});
  return { real: keys.filter((k) => real[k]?.length), estimated: keys.filter((k) => !real[k]?.length) };
}
