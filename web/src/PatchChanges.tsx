import { useState } from "react";
import { load, type Change, type Meta } from "./data";
import type { GameData } from "./sim/engine";
import { Empty, Icon, fmt, useAsync } from "./ui";

const KIND: Record<Change["kind"], string> = { champion: "Champion", item: "Item", trait: "Trait" };

/** One stat Riot changed from the patch before, as game.json records it. */
interface RiotChange {
  kind: "champion" | "spell" | "trait" | "item";
  id: string;
  name: string;
  stat: string;
  before: number | number[] | null;
  after: number | number[] | null;
}

const STAT: Record<string, string> = {
  hp: "Health",
  ad: "Attack Damage",
  as: "Attack Speed",
  armor: "Armor",
  mr: "Magic Resist",
  range: "Range",
  mana: "Mana",
  startMana: "Starting Mana",
  crit: "Crit Chance",
  cost: "Cost",
};

const show = (v: number | number[] | null) => (v == null ? "-" : Array.isArray(v) ? v.slice(1, 4).join("/") : String(Math.round(v * 1000) / 1000));

function statLabel(c: RiotChange): string {
  if (c.kind === "trait") {
    const [units, name] = c.stat.split(": ");
    return `(${units}) ${name}`;
  }
  if (c.kind === "spell") return `Ability: ${c.stat}`;
  return STAT[c.stat] ?? c.stat;
}

export function PatchChanges() {
  const { data, error } = useAsync(
    () => Promise.all([load<Meta>("meta.json"), load<Change[]>("patch-changes.json"), load<GameData & { patches: Record<string, { riotChanges?: RiotChange[] }> }>("game.json").catch(() => null)]),
    [],
  );
  const [pick, setPick] = useState<number | null>(null);
  if (error) return <Empty title="No patch data yet">{error}</Empty>;
  if (!data) return <Empty title="Loading patch changes…" />;
  const [meta, changes, game] = data;
  const pairs = meta.patches.slice(1).map((to, i) => [meta.patches[i], to] as const);
  if (!pairs.length) return <Empty title="Only one patch so far">Patch changes need at least two patches.</Empty>;
  const index = pick ?? pairs.length - 1;
  const [from, to] = pairs[index];
  const here = changes.filter((c) => c.from === from && c.to === to);
  const significant = here.filter((c) => c.significant);
  const winners = significant.filter((c) => c.delta < 0);
  const losers = significant.filter((c) => c.delta > 0).reverse();
  const riot = game?.patches[to]?.riotChanges ?? [];

  return (
    <>
      <section>
        <h1>
          Patch {from} → {to}
        </h1>
        <p>
          The simulated lobbies are played on Set {meta.set}'s real patches, with the data Riot shipped in each. Every change Riot made from
          one patch to the next makes the simulator's hidden meta stronger or weaker, and the pipeline has to find it from match results alone.
          A shift is listed only when it is at least {meta.method.zSignificant} standard errors from zero. The bar is strict because around a
          hundred things are compared at once, and a looser one would flag noise.
        </p>
      </section>

      <div className="seg" role="group" aria-label="Patch">
        {pairs.map(([a, b], i) => (
          <button key={b} aria-pressed={i === index} onClick={() => setPick(i)}>
            {a} → {b}
          </button>
        ))}
      </div>

      <div className="grid-2">
        <ChangeList title={`Stronger in ${to}`} rows={winners} empty="No significant gains." />
        <ChangeList title={`Weaker in ${to}`} rows={losers} empty="No significant losses." />
      </div>
      <p className="small">
        {here.length - significant.length} other comparisons moved too little to tell apart from chance. The{" "}
        <a href="#/truth">truth check</a> scores how many of Riot's changes the pipeline caught.
      </p>

      {game && <RiotPatch to={to} riot={riot} flagged={significant} />}
    </>
  );
}

function RiotPatch({ to, riot, flagged }: { to: string; riot: RiotChange[]; flagged: Change[] }) {
  // One row per champion, trait or item, with every stat Riot changed on it.
  const groups = new Map<string, { kind: string; id: string; name: string; rows: RiotChange[] }>();
  for (const c of riot) {
    const kind = c.kind === "spell" ? "champion" : c.kind;
    const key = `${kind}:${c.id}`;
    if (!groups.has(key)) groups.set(key, { kind, id: c.id, name: c.name, rows: [] });
    groups.get(key)!.rows.push(c);
  }
  const seen = (kind: string, id: string) => flagged.find((f) => f.kind === kind && (kind === "trait" ? f.id.split(":")[0] === id : f.id === id));
  const list = [...groups.values()].sort((a, b) => Number(!!seen(b.kind, b.id)) - Number(!!seen(a.kind, a.id)) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  return (
    <section className="panel">
      <h2>What Riot changed in {to}</h2>
      <p className="small" style={{ marginTop: 0 }}>
        {riot.length
          ? `${riot.length} stat changes to ${groups.size} champions, traits and items, read from the data Riot shipped in each patch (Community Dragon). Some only matter between rounds, like Coven's essence, and can't show in placements.`
          : "Riot changed nothing in this set's champions, traits or items this patch."}
      </p>
      {list.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Changed</th>
                <th>What Riot changed</th>
                <th>Pipeline</th>
              </tr>
            </thead>
            <tbody>
              {list.map((g) => {
                const f = seen(g.kind, g.id);
                return (
                  <tr key={`${g.kind}:${g.id}`}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{g.name}</div>
                      <div className="small">{g.kind === "champion" ? "Champion" : g.kind === "trait" ? "Trait" : "Item"}</div>
                    </td>
                    <td className="small" style={{ color: "var(--ink-2)" }}>
                      {g.rows.map((r, i) => (
                        <div key={i}>
                          {statLabel(r)}: {show(r.before)} → {show(r.after)}
                        </div>
                      ))}
                    </td>
                    <td>
                      {f ? (
                        <span className={f.delta < 0 ? "good" : "bad"}>
                          {f.delta < 0 ? "Placed better" : "Placed worse"} ({f.delta > 0 ? "+" : ""}
                          {f.delta.toFixed(2)})
                        </span>
                      ) : (
                        <span className="small">Not detected</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ChangeList({ title, rows, empty }: { title: string; rows: Change[]; empty: string }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {!rows.length && <p className="small">{empty}</p>}
      <table>
        <tbody>
          {rows.map((c) => (
            <tr key={`${c.kind}:${c.id}`}>
              <td style={{ width: 46 }}>
                <span className="entity" style={{ padding: 0, background: "none" }}>
                  <Icon src={c.icon} name={c.name} />
                </span>
              </td>
              <td>
                <div style={{ fontWeight: 600 }}>{c.name}</div>
                <div className="small">{KIND[c.kind]}</div>
              </td>
              <td className="num">
                {fmt.place(c.before)} → {fmt.place(c.after)}
                <div className={`small ${c.delta < 0 ? "good" : "bad"}`}>
                  {c.delta > 0 ? "+" : ""}
                  {c.delta.toFixed(2)} places · z {c.z.toFixed(1)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
