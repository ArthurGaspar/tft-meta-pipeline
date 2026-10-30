import { useState } from "react";
import { HBars, Scatter } from "./charts";
import { PLAYSTYLE_LABEL, load, type Lobby, type TruthCheck } from "./data";
import { Empty, useAsync } from "./ui";

type Kind = "champion" | "item" | "augment";
const LABEL: Record<Kind, string> = { champion: "Champions", item: "Items", augment: "Augments" };

export function Truth() {
  const { data, error } = useAsync(() => Promise.all([load<TruthCheck>("truth-check.json"), load<Lobby>("lobby.json").catch(() => null)]), []);
  const t = data?.[0];
  const lobby = data?.[1];
  const [kind, setKind] = useState<Kind>("champion");
  const [patch, setPatch] = useState<string | null>(null);
  if (error) return <Empty title="No truth check yet">{error}</Empty>;
  if (!t) return <Empty title="Loading the truth check…" />;
  const patches = Object.keys(t.patches);
  const current = patch ?? patches[patches.length - 1];
  const view = t.patches[current][kind];
  const changePatches = Object.keys(t.changes);

  return (
    <>
      <section>
        <h1>Did the ETL find the real meta?</h1>
        <p>
          The simulator gives every champion, item and augment a hidden power and keeps it out of the pipeline. Here the published
          tier lists are graded against it. A perfect pipeline would order everything exactly by hidden power; it can't, because
          placements are noisy, items and augments ride on whole boards, and strong units pull weak teammates along.
        </p>
      </section>

      <section className="panel">
        <h2>Rank correlation with hidden power, per patch</h2>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Patch</th>
                {(Object.keys(LABEL) as Kind[]).map((k) => (
                  <th key={k} className="num">
                    {LABEL[k]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {patches.map((p) => (
                <tr key={p}>
                  <td>{p}</td>
                  {(Object.keys(LABEL) as Kind[]).map((k) => (
                    <td key={k} className="num">
                      {t.patches[p][k].spearman?.toFixed(2) ?? "-"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small" style={{ marginBottom: 0 }}>1.00 would mean the tier list orders them exactly by hidden power.</p>
      </section>

      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Hidden power against published score</h2>
          <div className="row">
            <div className="seg" role="group" aria-label="Patch">
              {patches.map((p) => (
                <button key={p} aria-pressed={p === current} onClick={() => setPatch(p)}>
                  {p}
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Category">
              {(Object.keys(LABEL) as Kind[]).map((k) => (
                <button key={k} aria-pressed={k === kind} onClick={() => setKind(k)}>
                  {LABEL[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <Scatter
          ariaLabel={`${LABEL[kind]}: hidden power against published score, patch ${current}`}
          points={view.points.map((p) => ({ x: p.power, y: p.score, label: p.name, tier: p.tier }))}
          xLabel="Hidden power (stronger to the right)"
          yLabel="Score: shrunk avg placement (better is higher)"
        />
        <p className="small" style={{ marginTop: 8 }}>
          Spearman {view.spearman?.toFixed(2)} over {view.entities} ranked {LABEL[kind].toLowerCase()}. 1.00 would mean the tier list
          orders them exactly by hidden power.
        </p>
      </section>

      {changePatches.length > 0 && (
        <section className="panel">
          <h2>Riot's patches: changes caught</h2>
          <p>
            Each patch, Riot changed some champions, traits and items (read from the data it shipped), and the simulator's hidden meta moved
            with them. Did the pipeline's <a href="#/patch">patch changes</a> find them?
          </p>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Patch</th>
                  <th className="num">Riot's stat changes</th>
                  <th className="num">Champions, traits, items changed</th>
                  <th className="num">Flagged</th>
                  <th className="num">Real</th>
                  <th className="num">Right direction</th>
                </tr>
              </thead>
              <tbody>
                {changePatches.map((p) => {
                  const c = t.changes[p];
                  return (
                    <tr key={p}>
                      <td>{p}</td>
                      <td className="num">{c.riotChanges ?? "-"}</td>
                      <td className="num">{c.trueChanges}</td>
                      <td className="num">{c.flagged}</td>
                      <td className="num">{c.flaggedAndReal}</td>
                      <td className="num">{c.rightDirection}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small" style={{ marginBottom: 0 }}>
            Most of Riot's changes are small (a few percent of a stat, a point of mana) and can't be told apart from noise with the matches
            one patch gets here; real stat sites see hundreds of thousands of games per patch. Flags that aren't real changes usually moved
            through synergy: a trait change shifts every champion that carries it.
          </p>
        </section>
      )}

      {t.playstyle && <PlaystyleCheck check={t.playstyle} lobby={lobby} />}

      {t.positioning && (
        <section className="panel">
          <h2>Positioning: what the match data can't show</h2>
          <p>
            Every simulated player has a hidden positioning skill and picks a formation (corner, clump or spread), each of which beats
            another. Riot's match data has no positions, so the ETL can't see any of this; it only shows up as noise in the placements.
            Split by hidden skill:
          </p>
          <div style={{ maxWidth: 560 }}>
            <HBars
              ariaLabel="Top-4 rate by hidden positioning skill"
              data={t.positioning.thirds.map((x) => ({ label: `${x.label} (avg ${x.avgPlacement.toFixed(2)})`, value: x.top4Rate }))}
              format={(v) => `${(v * 100).toFixed(0)}%`}
            />
          </div>
          <p className="small">
            Players re-positioned {t.positioning.adaptations.toLocaleString("en-US")} times to counter a board that beat them. The
            countering side won {t.positioning.counterWinRate != null ? `${(t.positioning.counterWinRate * 100).toFixed(1)}%` : "-"} of{" "}
            {t.positioning.counterFights.toLocaleString("en-US")} such fights: barely more than half, because it's mostly the weaker boards
            that re-position to counter the stronger ones.
            {t.starsLostToPool != null &&
              ` The shared pool ran dry ${t.starsLostToPool} times, leaving a unit a star lower than it would have been.`}
          </p>
        </section>
      )}
    </>
  );
}

function PlaystyleCheck({ check, lobby }: { check: NonNullable<TruthCheck["playstyle"]>; lobby: Lobby | null | undefined }) {
  const plans = Object.keys(PLAYSTYLE_LABEL);
  const read: Record<string, { games: number; sum: number }> = {};
  for (const sections of Object.values(lobby ?? {}))
    for (const p of sections.playstyles) {
      read[p.id] ??= { games: 0, sum: 0 };
      read[p.id].games += p.games;
      read[p.id].sum += p.avgPlacement * p.games;
    }
  return (
    <section className="panel">
      <h2>Economy: did the ETL read the right playstyle?</h2>
      <p>
        Match data doesn't say how a player spent their gold, so the ETL infers it from the final board. It matches the plan the player
        actually followed on <b>{(check.accuracy * 100).toFixed(0)}%</b> of {check.boards.toLocaleString("en-US")} boards. The errors aren't
        random: a fast 9 player knocked out at level 8 reads as fast 8, and a missed 3-star hides a reroll.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Plan followed</th>
              {plans.map((p) => (
                <th key={p} className="num">
                  Read as {PLAYSTYLE_LABEL[p]}
                </th>
              ))}
              <th className="num">Avg place, true plan</th>
              <th className="num">Avg place, as read</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => {
              const row = check.confusion[plan] ?? {};
              const total = Object.values(row).reduce((a, b) => a + b, 0) || 1;
              const hidden = check.hidden.find((h) => h.id === plan);
              const r = read[plan];
              return (
                <tr key={plan}>
                  <td>{PLAYSTYLE_LABEL[plan]}</td>
                  {plans.map((p) => (
                    <td key={p} className="num" style={p === plan ? { fontWeight: 700 } : undefined}>
                      {(((row[p] ?? 0) / total) * 100).toFixed(0)}%
                    </td>
                  ))}
                  <td className="num">{hidden ? hidden.avgPlacement.toFixed(2) : "-"}</td>
                  <td className="num">{r ? (r.sum / r.games).toFixed(2) : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small">
        The last two columns are the lesson. Read from boards, Fast 9 looks dominant, but the plan itself is about as good as the others:
        reaching level 9 is mostly a sign of having survived. Any stat site that groups games by final level has the same bias.
      </p>
    </section>
  );
}
