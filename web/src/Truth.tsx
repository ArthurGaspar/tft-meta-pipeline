import { useState } from "react";
import { Scatter } from "./charts";
import { load, type TruthCheck } from "./data";
import { Empty, Tile, useAsync } from "./ui";

type Kind = "champion" | "item" | "augment";
const LABEL: Record<Kind, string> = { champion: "Champions", item: "Items", augment: "Augments" };

export function Truth() {
  const { data: t, error } = useAsync(() => load<TruthCheck>("truth-check.json"), []);
  const [kind, setKind] = useState<Kind>("champion");
  const [patch, setPatch] = useState<string | null>(null);
  if (error) return <Empty title="No truth check yet">{error}</Empty>;
  if (!t) return <Empty title="Loading the truth check…" />;
  const patches = Object.keys(t.patches);
  const current = patch ?? patches[patches.length - 1];
  const view = t.patches[current][kind];
  const changePatch = Object.keys(t.changes)[0];
  const ch = t.changes[changePatch];

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

      <div className="tiles">
        {patches.flatMap((p) =>
          (Object.keys(LABEL) as Kind[]).map((k) => (
            <Tile key={`${p}${k}`} value={t.patches[p][k].spearman?.toFixed(2) ?? "-"} label={`${LABEL[k]}, patch ${p}`} sub="rank correlation with hidden power" />
          )),
        )}
      </div>

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

      {ch && (
        <section className="panel">
          <h2>Balance patch {changePatch}: changes caught</h2>
          <p>
            The patch secretly changed <b>{ch.trueChanges}</b> champions, items and traits. The pipeline flagged <b>{ch.flagged}</b>{" "}
            significant shifts, <b>{ch.flaggedAndReal}</b> of them real changes, all <b>{ch.rightDirection}</b> in the right direction.
            {ch.flagged > ch.flaggedAndReal &&
              ` The other ${ch.flagged - ch.flaggedAndReal} weren't changed directly; they may have moved through synergy with something that was.`}
          </p>
          <p className="small">
            The {ch.missed.length} missed changes were too small to separate from noise with {` `}the matches in one patch. More matches
            per patch would catch more of them.
          </p>
        </section>
      )}
    </>
  );
}
