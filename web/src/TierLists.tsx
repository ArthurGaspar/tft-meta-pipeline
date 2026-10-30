import { useState } from "react";
import { KIND_LABEL, TIERS, load, type Build, type Entry, type Kind, type Meta, type TierLists as Lists } from "./data";
import { Empty, Icon, TierBadge, fmt, useAsync } from "./ui";

const KINDS: Kind[] = ["comp", "champion", "item", "augment", "trait"];

export function TierLists() {
  const { data, error } = useAsync(() => Promise.all([load<Meta>("meta.json"), load<Lists>("tierlists.json"), load<Record<string, Build[]>>("builds.json")]), []);
  const [patch, setPatch] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("comp");
  const [selected, setSelected] = useState<string | null>(null);

  if (error) return <Empty title="No tier lists yet">{error}</Empty>;
  if (!data) return <Empty title="Loading tier lists…" />;
  const [meta, lists, builds] = data;
  const current = patch ?? meta.patches[meta.patches.length - 1];
  const rows = lists[current][kind];
  const ranked = rows.filter((r) => r.tier);
  const unranked = rows.length - ranked.length;
  const champion = kind === "champion" && selected ? rows.find((r) => r.id === selected) : undefined;

  return (
    <>
      <section>
        <h1>Set {meta.set} tier lists</h1>
        <p>
          Computed by the ETL from {fmt.int(meta.matches)} simulated matches ({fmt.int(Object.values(meta.boards).reduce((a, b) => a + b, 0))}{" "}
          boards). A tier is how far an entity's average placement sits from the lobby average of 4.5, in standard deviations of
          its own kind; small samples are pulled towards average first, and anything with fewer than {meta.method.minGames} games
          stays unranked.
        </p>
      </section>

      <div className="row">
        <div className="seg" role="group" aria-label="Patch">
          {meta.patches.map((p) => (
            <button key={p} aria-pressed={p === current} onClick={() => setPatch(p)}>
              Patch {p}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Category">
          {KINDS.map((k) => (
            <button
              key={k}
              aria-pressed={k === kind}
              onClick={() => {
                setKind(k);
                setSelected(null);
              }}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      {champion && (
        <section className="panel">
          <h2>Best items on {champion.name} (both patches)</h2>
          {(builds[champion.id] ?? []).length ? (
            <div className="row">
              {builds[champion.id].map((b) => (
                <div className="entity" key={b.id} title={`${b.games} games, average placement ${fmt.place(b.avgPlacement)}`}>
                  <Icon src={b.icon} name={b.name} />
                  <div>
                    <div className="nm">{b.name}</div>
                    <div className="st">avg {fmt.place(b.avgPlacement)} · {fmt.int(b.games)} games</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="small">Not enough games with items on this champion.</p>
          )}
        </section>
      )}

      <section aria-label={`${KIND_LABEL[kind]} tier list for patch ${current}`}>
        {TIERS.map((t) => {
          const inTier = ranked.filter((r) => r.tier === t);
          if (!inTier.length) return null;
          return (
            <div className="tier-row" key={t}>
              <TierBadge tier={t} />
              <div className="tier-items">
                {inTier.map((r) => (
                  <EntityChip
                    key={r.id}
                    entry={r}
                    clickable={kind === "champion"}
                    pressed={selected === r.id}
                    onClick={() => setSelected(selected === r.id ? null : r.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {unranked > 0 && (
          <p className="small" style={{ marginTop: 10 }}>
            {fmt.int(unranked)} more {KIND_LABEL[kind].toLowerCase()} seen with fewer than {meta.method.minGames} games are not ranked.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Table view</h2>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Tier</th>
                <th>{KIND_LABEL[kind].slice(0, -1)}</th>
                <th className="num">Avg place</th>
                <th className="num">Top 4</th>
                <th className="num">Win</th>
                <th className="num">Play rate</th>
                <th className="num">Games</th>
                {kind === "comp" && <th className="num" title="Share of games where another board in the lobby held the same carry">Contested</th>}
                {kind === "comp" && <th className="num" title="Average placement when the carry was contested">Avg if contested</th>}
              </tr>
            </thead>
            <tbody>
              {ranked.map((r) => (
                <tr key={r.id}>
                  <td>{r.tier}</td>
                  <td>{r.name}</td>
                  <td className="num">{fmt.place(r.avgPlacement)}</td>
                  <td className="num">{fmt.pct(r.top4Rate)}</td>
                  <td className="num">{fmt.pct(r.winRate, 1)}</td>
                  <td className="num">{fmt.pct(r.playRate, 1)}</td>
                  <td className="num">{fmt.int(r.games)}</td>
                  {kind === "comp" && <td className="num">{r.contestRate == null ? "-" : fmt.pct(r.contestRate)}</td>}
                  {kind === "comp" && <td className="num">{r.avgContested == null ? "-" : fmt.place(r.avgContested)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function EntityChip({ entry, clickable, pressed, onClick }: { entry: Entry; clickable: boolean; pressed: boolean; onClick: () => void }) {
  const title = `${entry.name}: average placement ${fmt.place(entry.avgPlacement)}, top 4 ${fmt.pct(entry.top4Rate)}, win ${fmt.pct(entry.winRate, 1)}, ${fmt.int(entry.games)} games`;
  const body = (
    <>
      <Icon src={entry.icon} name={entry.name} />
      <div>
        <div className="nm">{entry.name}</div>
        <div className="st">avg {fmt.place(entry.avgPlacement)} · {fmt.pct(entry.top4Rate)} top 4</div>
      </div>
    </>
  );
  return clickable ? (
    <button className="entity clickable" aria-pressed={pressed} onClick={onClick} title={title}>
      {body}
    </button>
  ) : (
    <div className="entity" title={title}>
      {body}
    </div>
  );
}
