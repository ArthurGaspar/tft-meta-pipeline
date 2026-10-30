/**
 * Set 18's traits, written from their in-game descriptions with Riot's real values for
 * the active breakpoint. The patch's hidden meta scales each trait's magnitudes up or
 * down, so a buffed trait is stronger here too. Traits that act between rounds (shops,
 * essence, rewards, placeable plants) have no effect inside a single fight and say so.
 */
import {
  type Battle,
  type TraitData,
  type Unit,
  addMaxHp,
  allies,
  buff,
  burn,
  damage,
  dist,
  dot,
  enemies,
  every,
  gainMana,
  heal,
  healthPct,
  shield,
  shieldTotal,
  shred,
  sunder,
  wound,
} from "./core.ts";

export interface TraitCtx {
  b: Battle;
  trait: TraitData;
  tier: number;
  /** champions on the team with this trait */
  members: Unit[];
  /** every unit on the team */
  team: Unit[];
  /** a magnitude for the active breakpoint, scaled by the hidden meta */
  val: (name: string) => number;
  /** a threshold, duration or count for the active breakpoint, as Riot ships it */
  raw: (name: string) => number;
}

export interface TraitDef {
  apply?: (c: TraitCtx) => void;
  /** what the trait does that a single fight can't show */
  notModeled?: string;
}

const strongest = (list: Unit[]) => [...list].sort((a, z) => z.champion.cost * z.star - a.champion.cost * a.star || z.items.length - a.items.length)[0];

export const TRAITS: Record<string, TraitDef> = {
  Adaptor: {
    apply: (c) => {
      for (const u of c.members) {
        // Adaptors gain whichever of Attack Damage or Ability Power their kit leans on.
        if (/_AP$/i.test(u.champion.id)) u.ap += c.val("ADAPGain") * 100;
        else u.adMult += c.val("ADAPGain");
      }
    },
  },
  "Apex Predator": { notModeled: "Elder Dragon's two team slots and +2 Riftbeast" },
  Attuned: {
    apply: (c) => {
      const alune = c.members[0];
      if (!alune) return;
      // The moon phase cycles on each Alune cast: at or below half full the team is tougher, above it hits harder.
      const waxing = () => ((alune.stacks.moon ?? 0) % 4) >= 2;
      for (const u of c.team) {
        u.hooks.takeMult.push(() => (waxing() ? 1 : 1 - c.val("Durability")));
        u.hooks.dealMult.push(() => (waxing() ? 1 + c.val("DamageAmp") : 1));
      }
    },
  },
  Avatar: { notModeled: "an Avatar's chosen trait counting twice (chosen in the shop)" },
  Blackthorn: {
    apply: (c) => {
      for (const u of c.team) if (!u.summon) addMaxHp(u, c.val("Health"));
    },
    notModeled: "the sacrifice before combat and its extra stats for Blackthorn champions",
  },
  Blossom: {
    apply: (c) => {
      for (const u of c.members) {
        u.adMult += c.val("ADAP");
        u.ap += c.val("ADAP") * 100;
        addMaxHp(u, u.maxHp * c.val("BonusHealth"));
      }
    },
    notModeled: "Wisps, bought between rounds",
  },
  "Bounty Seeker": { notModeled: "bounties and their rewards, earned over many rounds" },
  Brawler: {
    apply: (c) => {
      for (const u of c.team) if (!u.summon) addMaxHp(u, c.val("BrawlerTeamHealth"));
      for (const u of c.members) addMaxHp(u, u.maxHp * c.val("BrawlerHealthPercent"));
    },
  },
  Caustic: {
    apply: (c) => {
      for (const u of c.members)
        u.hooks.hit.push((h) => {
          shred(c.b, h.target, c.raw("ShredPercent") / 100, c.raw("ShredDuration"));
          sunder(c.b, h.target, c.raw("ShredPercent") / 100, c.raw("ShredDuration"));
        });
    },
  },
  Coven: { notModeled: "Essence and its rewards, gathered over many rounds" },
  Defender: {
    apply: (c) => {
      for (const u of c.team) {
        const r = c.members.includes(u) ? c.val("DefenderDefenseGain") : c.val("NonDefenderDefenseGain");
        buff(c.b, u, { armor: r, mr: r });
      }
    },
  },
  Elderwood: { notModeled: "the placeable Stonebark Trees, Lifebloom and Deepwood Protector" },
  "Emerald Aspect": { notModeled: "pairing an ally with Taric (the simulator pairs his nearest ally)" },
  Executioner: {
    apply: (c) => {
      for (const u of c.members) {
        u.precision = true;
        u.crit += c.val("CritChance");
        if (c.raw("BonusBleedPercent") > 0)
          u.hooks.hit.push((h) => h.crit && dot(c.b, u, h.target, h.dealt * c.val("BonusBleedPercent"), c.raw("BleedDuration"), "true"));
      }
    },
  },
  Fae: {
    apply: (c) => {
      if (!c.members.length) return;
      // Pixies come with the team's damage, healing and shielding: one per ~1,200 damage here, up to 7.
      let pixies = 0;
      every(c.b, c.members[0], 1, () => {
        const total = c.team.reduce((s, u) => s + u.damageDealt, 0);
        const now = Math.min(7, Math.floor(total / 1200));
        for (const u of c.members) {
          u.adMult += ((now - pixies) * c.val("ADAP")) / 100;
          u.ap += (now - pixies) * c.val("ADAP");
          if (u.alive && healthPct(u) < c.raw("HealThreshold")) heal(c.b, u, (u.maxHp * c.val("Heal") * now) / 100 / 4);
        }
        pixies = now;
      });
    },
    notModeled: "Golden Pixies (gold)",
  },
  "Flora Fatalis": {
    apply: (c) => {
      for (const u of c.members)
        u.hooks.kill.push(() => {
          gainMana(c.b, u, c.val("Mana"));
          if (c.raw("PercentHeal") > 0) {
            const low = allies(c.b, u).sort((a, z) => a.hp - z.hp)[0];
            if (low) heal(c.b, low, low.maxHp * c.val("PercentHeal"));
          }
        });
    },
  },
  Greenfather: { notModeled: "seeds and grown hexes, built up over rounds" },
  Hunter: {
    apply: (c) => {
      for (const u of c.members) {
        u.adMult += c.val("HunterAD");
        u.hooks.dealMult.push(() => (c.b.time - u.sameTargetSince >= c.raw("HunterDuration") ? 1 + c.val("DamageAmp") : 1));
      }
    },
  },
  Inferno: {
    apply: (c) => {
      for (const u of c.members)
        u.hooks.hit.push((h) => {
          burn(c.b, u, h.target, c.val("HPBurnPerSecond") / 100, c.raw("Duration"), "inferno");
          wound(c.b, h.target, c.raw("WoundPercent") / 100, c.raw("Duration"));
        });
    },
    notModeled: "ignited shop slots",
  },
  Invoker: {
    apply: (c) => {
      for (const u of c.team) u.manaRegen += c.members.includes(u) ? c.val("InvokerManaBonus") : c.val("TeamManaRegen");
    },
  },
  Juggernaut: {
    apply: (c) => {
      for (const u of c.team) u.durability += c.members.includes(u) ? c.val("JuggernautDurability") : c.val("TeamDurability");
    },
  },
  Lunar: {
    apply: (c) => {
      // Lunar champions and the allies next to them when combat starts: placement matters.
      for (const u of c.team) {
        const lunar = c.members.includes(u);
        if (!lunar && !c.members.some((m) => dist(m, u) <= 1)) continue;
        const k = lunar ? 1 + c.raw("LunarMultiplier") : 1;
        u.asBonus += c.val("AttackSpeed") * k;
        u.ap += c.val("AbilityPower") * 100 * k;
      }
    },
  },
  Monolith: {
    apply: (c) => {
      for (const u of c.members) {
        let applied = 0;
        every(c.b, u, 0.5, () => {
          const n = enemies(c.b, u).filter((e) => e.target === u.uid).length;
          buff(c.b, u, { armor: (n - applied) * c.val("Resists"), mr: (n - applied) * c.val("Resists") });
          applied = n;
        });
      }
    },
  },
  "Old Growth": {
    apply: (c) => {
      const keeper = strongest(c.members);
      if (!keeper) return;
      for (const e of c.b.units.filter((x) => x.team !== keeper.team))
        e.hooks.death.push(() => keeper.alive && dist(keeper, e) <= c.raw("UniqueTraitHexRange") && addMaxHp(keeper, c.val("UniqueTraitHealthPerStack")));
    },
    notModeled: "max Health kept from earlier rounds",
  },
  Primal: { notModeled: "the Primal Blessing chosen between rounds" },
  Rapidfire: {
    apply: (c) => {
      for (const u of c.team) u.asBonus += c.val("TeamAS");
      for (const u of c.members)
        u.hooks.attack.push(() => {
          if ((u.stacks.rapidfire ?? 0) >= c.raw("MaxStacks")) return;
          u.stacks.rapidfire = (u.stacks.rapidfire ?? 0) + 1;
          u.asBonus += c.val("ASperAttack");
        });
    },
  },
  Ravager: {
    apply: (c) => {
      for (const u of c.members) {
        u.omnivamp += c.val("Omnivamp");
        u.hooks.dealMult.push((h) => 1 + c.val("BonusDamagePercentBase") * (healthPct(h.target) < c.raw("EnemyHealthThreshold") ? 2 : 1));
      }
    },
  },
  Riftbeast: {
    apply: (c) => {
      if (!(c.raw("CapstoneAD") > 0)) return;
      const grow = () => {
        for (const u of c.members) {
          if (!u.alive) continue;
          u.adMult += c.val("CapstoneAD");
          u.ap += c.val("CapstoneAP") * 100;
          u.asBonus += c.val("CapstoneAspd");
          buff(c.b, u, { armor: c.val("CapstoneArmor"), mr: c.val("CapstoneMR"), manaRegen: c.val("CapstoneManaRegen") });
          addMaxHp(u, c.val("CapstoneHealth"));
        }
      };
      grow();
      if (c.members[0]) every(c.b, c.members[0], 5, grow);
    },
    notModeled: "the Alpha Mark buffs and Riftbeast shops (between rounds)",
  },
  Rival: { notModeled: "takedown rewards and Kha'Zix's evolutions, earned over many rounds" },
  Solar: {
    apply: (c) => {
      const threeStars = new Set(c.team.filter((u) => u.star >= 3 && !u.summon).map((u) => u.champion.id)).size;
      const boost = 1 + c.raw("PercentIncreasePer3Star") * threeStars;
      const trueShare = threeStars >= c.raw("NumThreeStarThreshold2") ? c.raw("Threshold2TrueDamageConversion") : 0;
      for (const u of c.team) {
        if (u.summon) continue;
        u.hooks.start.push(() => shield(c.b, u, u.maxHp * c.val("ShieldRatio") * boost, 30));
        u.hooks.hit.push((h) => {
          if (h.kind === "true") return;
          const extra = h.dealt * c.val("BonusMagicDamage") * boost;
          if (extra < 1) return;
          // a separate hit that doesn't proc, so it can't trigger itself
          damage(c.b, u, h.target, extra * (1 - trueShare), "magic", { proc: false });
          if (trueShare) damage(c.b, u, h.target, extra * trueShare, "true", { proc: false });
        });
        if (threeStars >= c.raw("NumThreeStarThreshold1")) {
          u.asBonus += c.raw("Threshold1AttackSpeed");
          buff(c.b, u, { armor: c.raw("Threshold1ArmorMagicResist"), mr: c.raw("Threshold1ArmorMagicResist") });
        }
      }
    },
  },
  Spellweaver: {
    apply: (c) => {
      for (const u of c.team) u.ap += (c.members.includes(u) ? c.val("SpellweaverAP") : c.val("TeamwideAP")) * 100;
      for (const u of c.members) u.hooks.cast.push(() => (u.ap += c.val("APPerCast") * 100));
    },
  },
  Sprykin: {
    apply: (c) => {
      // The Rider (dropped on the Big Furry Friend between rounds): here, the strongest Sprykin.
      const rider = strongest(c.members);
      if (!rider) return;
      addMaxHp(rider, rider.maxHp * c.val("HealthIncrease"));
      rider.asBonus += c.val("AttackSpeedIncrease");
    },
    notModeled: "the Big Furry Friend itself and its ability; the strongest Sprykin is treated as the Rider",
  },
  Summoner: {
    apply: (c) => {
      const k = c.tier >= 2 ? 1.5 : 1;
      for (const u of c.members) {
        const name = u.champion.name;
        if (name === "Yorick") u.stacks.summonerHealth = c.val("HealthMult") * k;
        if (name === "Azir") u.stacks.summonerDamage = c.val("AzirDamageMult") * k;
        if (name === "Mama Beak") u.stacks.summonerDamage = c.val("DamageMult") * k;
        if (name === "Zyra") u.stacks.summonerAttacks = Math.round(c.raw("NumExtraAttacks") * k);
      }
    },
  },
  Thornmaiden: {
    apply: (c) => {
      for (const u of c.team)
        u.hooks.takeMult.push(() => {
          const plants = c.b.units.filter((x) => x.alive && x.team === u.team && x.stacks.zyraPlant).length;
          return 1 - (plants >= c.raw("PlantNumThreshold") ? c.val("IncreasedDurability") : c.val("BaseDurability"));
        });
    },
  },
  Vanguard: {
    apply: (c) => {
      for (const u of c.members) {
        const give = () => shield(c.b, u, u.maxHp * c.val("MaxHealthShield"), c.raw("ShieldDuration"));
        u.hooks.start.push(give);
        u.hooks.hurt.push(() => {
          if (!u.stacks.vanguardAgain && healthPct(u) < c.raw("HealthThreshold")) {
            u.stacks.vanguardAgain = 1;
            give();
          }
        });
        if (c.raw("DurabilityIncrease") > 0) u.hooks.takeMult.push(() => (shieldTotal(c.b, u) > 0 ? 1 - c.val("DurabilityIncrease") : 1));
      }
    },
  },
};

/** The values of a trait's active breakpoint, carrying forward ones a higher breakpoint doesn't repeat. */
export function traitValues(trait: TraitData, tier: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of (trait.effects ?? []).slice(0, tier)) Object.assign(out, e.values);
  return out;
}
