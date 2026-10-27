import { load, type Change, type Meta } from "./data";
import { Empty, Icon, fmt, useAsync } from "./ui";

const KIND: Record<Change["kind"], string> = { champion: "Champion", item: "Item", trait: "Trait" };

export function PatchChanges() {
  const { data, error } = useAsync(() => Promise.all([load<Meta>("meta.json"), load<Change[]>("patch-changes.json")]), []);
  if (error) return <Empty title="No patch data yet">{error}</Empty>;
  if (!data) return <Empty title="Loading patch changes…" />;
  const [meta, changes] = data;
  const significant = changes.filter((c) => c.significant);
  const winners = significant.filter((c) => c.delta < 0);
  const losers = significant.filter((c) => c.delta > 0).reverse();
  const [from, to] = [meta.patches[0], meta.patches[meta.patches.length - 1]];

  return (
    <>
      <section>
        <h1>
          Patch {from} → {to}
        </h1>
        <p>
          Which champions, items and traits placed differently after the balance patch. A shift is listed only when it is at least{" "}
          {meta.method.zSignificant} standard errors from zero. The bar is strict because around a hundred things are compared at
          once, and a looser one would flag noise.
        </p>
      </section>
      <div className="grid-2">
        <ChangeList title={`Stronger in ${to}`} rows={winners} empty="No significant gains." />
        <ChangeList title={`Weaker in ${to}`} rows={losers} empty="No significant losses." />
      </div>
      <p className="small">
        {changes.length - significant.length} other comparisons moved too little to tell apart from chance. The{" "}
        <a href="#/truth">truth check</a> shows how many of the patch's real changes this caught.
      </p>
    </>
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
