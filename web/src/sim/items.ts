/**
 * Item passives, written from their in-game descriptions with Riot's real values. Plain
 * stats (Attack Damage, Ability Power, Health...) are applied by the engine for every
 * item; these add what each item does on top. Values are Community Dragon's units:
 * "Pct"/"Percent" fields named in whole percents (e.g. 25) are divided by 100 here.
 */
import {
  type Battle,
  type ItemData,
  type Unit,
  addMaxHp,
  area,
  buff,
  burn,
  damage,
  enemies,
  every,
  gainMana,
  heal,
  healthPct,
  shield,
  shred,
  sunder,
  within,
  wound,
} from "./core.ts";

export interface ItemCtx {
  b: Battle;
  u: Unit;
  item: ItemData;
  /** one of the item's effect values, as Riot ships it */
  e: (name: string) => number;
  /** equips another item on the same unit (Thief's Gloves) */
  install: (itemId: string) => void;
}

export interface ItemDef {
  apply?: (c: ItemCtx) => void;
  notModeled?: string;
}

/** Runs `fn` once, the first time the unit drops below `threshold` (a 0-1 fraction) of max Health. */
function onceBelow(u: Unit, threshold: number, fn: () => void): void {
  let done = false;
  u.hooks.hurt.push(() => {
    if (!done && u.alive && healthPct(u) < threshold) {
      done = true;
      fn();
    }
  });
}

const isTank = (u: Unit) => u.range <= 1 && u.maxHp >= 1500;

export const ITEMS: Record<string, ItemDef> = {
  "Adaptive Helm": {
    apply: (c) => {
      c.u.manaMult += c.e("ManaPercIncrease");
      if (c.u.range <= 1) buff(c.b, c.u, { armor: c.e("FrontlineResists"), mr: c.e("FrontlineResists") });
      else {
        c.u.adMult += c.e("BacklineADAP") / 100;
        c.u.ap += c.e("BacklineADAP");
      }
    },
  },
  "Archangel's Staff": { apply: (c) => every(c.b, c.u, c.e("IntervalSeconds"), () => (c.u.ap += c.e("APPerInterval"))) },
  Bloodthirster: {
    apply: (c) => onceBelow(c.u, c.e("HealthThreshold") / 100, () => shield(c.b, c.u, (c.u.maxHp * c.e("ShieldHealthPercent")) / 100, c.e("ShieldDuration"))),
  },
  "Blue Buff": {
    apply: (c) => {
      // "additional Attack Damage and Ability Power from all sources", once everything else is set up
      c.u.hooks.start.push(() => {
        c.u.adMult += (c.u.adMult - 1) * c.e("ModifiedADAP");
        c.u.ap += (c.u.ap - 100) * c.e("ModifiedADAP");
      });
    },
  },
  "Bramble Vest": {
    apply: (c) => {
      addMaxHp(c.u, c.u.maxHp * c.e("PercentMaxHP"));
      c.u.hooks.takeMult.push((h) => (h.attack ? 1 - c.e("AutoDamageReduction") : 1));
      let ready = 0;
      c.u.hooks.hurt.push((h) => {
        if (!h.attack || c.b.time < ready) return;
        ready = c.b.time + c.e("ICD");
        area(c.b, c.u, c.u.row, c.u.col, 1);
        for (const x of within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, 1)) damage(c.b, c.u, x, c.e("1StarAoEDamage"), "magic", { proc: false });
      });
    },
  },
  Crownguard: {
    apply: (c) => {
      c.u.hooks.start.push(() => shield(c.b, c.u, (c.u.maxHp * c.e("ShieldSize")) / 100, c.e("ShieldDuration")));
      every(c.b, c.u, c.e("ShieldDuration"), () => (c.u.ap += c.e("ShieldBonusAP")), 1);
    },
  },
  Deathblade: { apply: (c) => (c.u.amp += c.e("BonusDamage")) },
  "Dragon's Claw": {
    apply: (c) => {
      addMaxHp(c.u, c.u.maxHp * c.e("PercentMaxHP"));
      every(c.b, c.u, c.e("HealthRegenInterval"), () => heal(c.b, c.u, (c.u.maxHp * c.e("PercentHealthDamage")) / 100));
    },
  },
  "Edge of Night": {
    apply: (c) =>
      onceBelow(c.u, c.e("HealthThreshold") / 100, () => {
        c.u.untargetableUntil = c.b.time + c.e("StealthDuration");
        c.u.stunUntil = 0;
        c.u.sleepUntil = 0;
        c.u.burns.clear();
        c.u.dots = [];
        heal(c.b, c.u, (c.u.maxHp - c.u.hp) * c.e("MissingHealthRestore"));
        for (const x of c.b.units) if (x.target === c.u.uid) x.target = null;
      }),
  },
  Evenshroud: {
    apply: (c) => {
      buff(c.b, c.u, { armor: c.e("BonusResists"), mr: c.e("BonusResists") }, c.e("BonusResistDuration"));
      every(c.b, c.u, 0.5, () => {
        for (const x of within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.e("HexRange"))) sunder(c.b, x, c.e("ARReductionAmount") / 100, 0.6);
      });
    },
  },
  "Gargoyle Stoneplate": {
    apply: (c) => {
      let applied = 0;
      every(c.b, c.u, 0.5, () => {
        const n = enemies(c.b, c.u).filter((x) => x.target === c.u.uid).length;
        buff(c.b, c.u, { armor: (n - applied) * c.e("ArmorPerEnemy"), mr: (n - applied) * c.e("MRPerEnemy") });
        applied = n;
      });
    },
  },
  "Giant Slayer": { apply: (c) => c.u.hooks.dealMult.push((h) => (isTank(h.target) ? 1 + c.e("DamageAmp") : 1)) },
  "Guinsoo's Rageblade": { apply: (c) => every(c.b, c.u, 1, () => (c.u.asBonus += c.e("AttackSpeedPerStack") / 100)) },
  "Hand Of Justice": {
    apply: (c) => {
      const [adp, app, vamp] = [c.e("AD_NotStatBar"), c.e("AP_NotStatBar"), c.e("StatOmnivamp_NotStatBar")];
      // Above the threshold: double Attack Damage and Ability Power. Below it: double Omnivamp instead.
      let healthy = true;
      c.u.adMult += 2 * adp;
      c.u.ap += 2 * app;
      c.u.omnivamp += vamp;
      c.u.hooks.hurt.push(() => {
        if (!healthy || healthPct(c.u) > c.e("HealthThreshold")) return;
        healthy = false;
        c.u.adMult -= adp;
        c.u.ap -= app;
        c.u.omnivamp += vamp;
      });
    },
  },
  "Hextech Gunblade": {
    apply: (c) =>
      c.u.hooks.hit.push((h) => {
        const low = c.b.units.filter((a) => a.alive && a.team === c.u.team).sort((a, z) => healthPct(a) - healthPct(z))[0];
        if (low) heal(c.b, low, h.dealt * c.e("AllyHealing"));
      }),
  },
  "Infinity Edge": { apply: (c) => (c.u.precision = true) },
  "Ionic Spark": {
    apply: (c) => {
      every(c.b, c.u, 0.5, () => {
        for (const x of within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.e("HexRange"))) shred(c.b, x, c.e("MRShred") / 100, 0.6);
      });
      for (const x of c.b.units.filter((x) => x.team !== c.u.team))
        x.hooks.cast.push(() => {
          if (c.u.alive && x.alive && within(c.b, [x], c.u.row, c.u.col, c.e("HexRange")).length)
            damage(c.b, c.u, x, (x.maxMana * c.e("ManaRatio")) / 100, "magic", { proc: false });
        });
    },
  },
  "Jeweled Gauntlet": { apply: (c) => (c.u.precision = true) },
  "Kraken's Fury": {
    apply: (c) =>
      c.u.hooks.attack.push(() => {
        const n = (c.u.stacks.kraken = (c.u.stacks.kraken ?? 0) + 1);
        if (n <= c.e("MaxStacks")) c.u.adMult += c.e("ADOnAttack");
        if (n === c.e("MaxStacks")) c.u.asBonus += c.e("ASCapstone");
      }),
  },
  "Last Whisper": { apply: (c) => c.u.hooks.hit.push((h) => sunder(c.b, h.target, c.e("ArmorReductionPercent") / 100, c.e("ArmorBreakDuration"))) },
  Morellonomicon: {
    apply: (c) =>
      c.u.hooks.hit.push((h) => {
        burn(c.b, c.u, h.target, c.e("BurnPercent") / 100, c.e("BurnDuration"));
        wound(c.b, h.target, c.e("GrievousWoundsPercent") / 100, c.e("BurnDuration"));
      }),
  },
  "Nashor's Tooth": { apply: (c) => c.u.hooks.attack.push((_t, h) => gainMana(c.b, c.u, h.crit ? c.e("ManaOnCrit") : c.e("BaseManaOnHit"))) },
  "Protector's Vow": {
    apply: (c) =>
      onceBelow(c.u, c.e("HealthThreshold") / 100, () => {
        gainMana(c.b, c.u, c.e("TriggerMana"));
        shield(c.b, c.u, (c.u.maxHp * c.e("ShieldHealthPercent")) / 100, c.e("ShieldDuration"));
      }),
  },
  Quicksilver: {
    apply: (c) => {
      c.u.ccImmuneUntil = Math.max(c.u.ccImmuneUntil, c.e("SpellShieldDuration"));
      every(c.b, c.u, 1, () => (c.u.asBonus += c.e("ProcAttackSpeed")), c.e("SpellShieldDuration"));
    },
  },
  "Rabadon's Deathcap": { apply: (c) => (c.u.amp += c.e("BonusDamage")) },
  "Red Buff": {
    apply: (c) => {
      c.u.amp += c.e("BonusDamage");
      c.u.hooks.hit.push((h) => {
        burn(c.b, c.u, h.target, c.e("BurnPercent") / 100, c.e("Duration"));
        wound(c.b, h.target, c.e("HealingReductionPct") / 100, c.e("Duration"));
      });
    },
  },
  "Spear of Shojin": { apply: (c) => c.u.hooks.attack.push(() => gainMana(c.b, c.u, c.e("FlatManaRestore"))) },
  "Spirit Visage": {
    apply: (c) => every(c.b, c.u, c.e("HealTickRate") || 1, () => heal(c.b, c.u, Math.min(c.e("MaxHeal") || Infinity, (c.u.maxHp - c.u.hp) * c.e("MissingHealthHeal")))),
  },
  "Steadfast Heart": {
    apply: (c) => c.u.hooks.takeMult.push(() => 1 - (healthPct(c.u) > c.e("ThresholdForEmpower") ? c.e("EmpoweredDurability") : c.e("BaseDurability"))),
  },
  "Sterak's Gage": {
    apply: (c) =>
      onceBelow(c.u, c.e("HealthThreshold") / 100, () => {
        // "rapidly decays": half lasts the full duration, half only the first half
        const total = c.u.maxHp * c.e("PercentHealthShield");
        shield(c.b, c.u, total / 2, c.e("ShieldDuration"));
        shield(c.b, c.u, total / 2, c.e("ShieldDuration") / 2);
      }),
  },
  "Striker's Flail": {
    apply: (c) =>
      c.u.hooks.hit.push((h) => {
        if (!h.crit || (c.u.stacks.flail ?? 0) >= c.e("MaxStacks")) return;
        c.u.stacks.flail = (c.u.stacks.flail ?? 0) + 1;
        c.u.amp += c.e("BuffDamageAmp");
        c.b.timers.push({
          at: c.b.time + c.e("Duration"),
          fn: () => {
            c.u.amp -= c.e("BuffDamageAmp");
            c.u.stacks.flail--;
          },
        });
      }),
  },
  "Sunfire Cape": {
    apply: (c) => {
      addMaxHp(c.u, c.u.maxHp * c.e("BonusPercentHP"));
      every(c.b, c.u, c.e("ICD"), () => {
        const x = within(c.b, enemies(c.b, c.u), c.u.row, c.u.col, c.e("HexRange"))[0];
        if (!x) return;
        burn(c.b, c.u, x, c.e("BurnPercent") / 100, c.e("BurnDuration"));
        wound(c.b, x, c.e("GrievousWoundsPercent") / 100, c.e("BurnDuration"));
      });
    },
  },
  "Tactician's Cape": { notModeled: "+1 team size and gold" },
  "Tactician's Crown": { notModeled: "+1 team size and gold" },
  "Tactician's Shield": { notModeled: "+1 team size and gold" },
  "Thief's Gloves": {
    apply: (c) => {
      // Two random items each round: re-rolled for every fight, from the seeded random source.
      const pool = c.b.game.items.filter((i) => ITEMS[i.name]?.apply && !i.name.startsWith("Tactician") && i.name !== "Thief's Gloves");
      for (let k = 0; k < 2; k++) {
        const pick = pool[Math.floor(c.b.rng() * pool.length)];
        if (pick) c.install(pick.id);
      }
    },
  },
  "Titan's Resolve": {
    apply: (c) => {
      const stack = () => {
        const n = c.u.stacks.titan ?? 0;
        if (n >= c.e("StackCap")) return;
        c.u.stacks.titan = n + 1;
        c.u.adMult += c.e("StackingAD");
        c.u.ap += c.e("StackingSP");
        if (n + 1 === c.e("StackCap")) {
          c.u.amp += c.e("StackedAmp");
          c.u.ccImmuneUntil = Infinity;
        }
      };
      c.u.hooks.attack.push(stack);
      c.u.hooks.hurt.push(stack);
    },
  },
  "Void Staff": { apply: (c) => c.u.hooks.hit.push((h) => shred(c.b, h.target, c.e("MRShred") / 100, c.e("MRShredDuration"))) },
  "Warmog's Armor": { apply: (c) => addMaxHp(c.u, c.u.maxHp * c.e("BonusPercentHP")) },
};
