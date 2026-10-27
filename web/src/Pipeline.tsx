import { HBars } from "./charts";
import { load, type Pipeline as Report } from "./data";
import { Empty, Tile, fmt, useAsync } from "./ui";

const FLOW = [
  { name: "tft-raw", aws: "S3 bucket", what: "Raw match files land here (NDJSON, Riot match-API shape)." },
  { name: "Validate", aws: "Lambda · S3 trigger", what: "Checks every record; stages good ones, quarantines bad ones." },
  { name: "tft-staged", aws: "S3 bucket", what: "Validated matches, one file per raw file." },
  { name: "Load", aws: "Lambda · S3 trigger", what: "Upserts into normalized tables, labels comps; idempotent." },
  { name: "MetaDb", aws: "RDS for MySQL", what: "Matches, boards, units, items, traits, augments." },
  { name: "Aggregate", aws: "Lambda · EventBridge rate(1 hour)", what: "Stats, tier lists, patch changes." },
  { name: "tft-public", aws: "S3 bucket", what: "JSON the website reads." },
];

const SIDE = [
  { name: "tft-quarantine", aws: "S3 bucket", what: "Rejected records, each with its reasons." },
  { name: "tft-failed-events", aws: "SQS dead-letter queue", what: "Events that failed after 2 retries." },
  { name: "Logs", aws: "CloudWatch Logs", what: "START / END / REPORT per invocation." },
];

const REASON: Record<string, string> = {
  invalid_placements: "Placements not 1 to 8",
  duplicate_in_file: "Duplicate match in a file",
  missing_placement: "Missing placement",
  unknown_version: "Unreadable game version",
  unknown_champion: "Unknown champion",
  wrong_lobby_size: "Not 8 players",
  malformed_json: "Malformed JSON line",
  unknown_item: "Unknown item",
  unknown_augment: "Unknown augment",
  wrong_set: "Wrong set",
  missing_field: "Missing field",
};

export function Pipeline() {
  const { data: r, error } = useAsync(() => load<Report>("pipeline.json"), []);
  if (error) return <Empty title="No pipeline run yet">{error}</Empty>;
  if (!r) return <Empty title="Loading the run report…" />;
  const fns = Object.entries(r.functions);
  const invocations = fns.reduce((s, [, f]) => s + f.invocations, 0);

  return (
    <>
      <section>
        <h1>How the data gets here</h1>
        <p>
          A serverless ETL on <b>minicloud</b>, a small AWS imitation built for this project. It reads an infrastructure template,
          stores files in buckets, fires S3-style events, runs functions with Lambda's <code>handler(event, context)</code> contract,
          retries failures and parks the hopeless ones in a dead-letter queue. The database is real MySQL.
        </p>
      </section>

      <section className="panel">
        <h2>The stack ({Object.keys(r.stack.resources).length} resources from infra/stack.yaml)</h2>
        <div className="flow">
          {FLOW.map((n, i) => (
            <div className="node" key={n.name}>
              <span className="small">{i + 1}</span>
              <b>{n.name}</b>
              <span className="aws">{n.aws}</span>
              <div className="what">{n.what}</div>
            </div>
          ))}
        </div>
        <div className="flow" style={{ marginTop: 10 }}>
          {SIDE.map((n) => (
            <div className="node" key={n.name} style={{ borderStyle: "dashed" }}>
              <b>{n.name}</b>
              <span className="aws">{n.aws}</span>
              <div className="what">{n.what}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="tiles">
        <Tile value={fmt.int(invocations)} label="Function invocations" sub={`${r.rawFiles} raw files uploaded`} />
        <Tile value={fmt.int(r.quality.quarantined)} label="Records quarantined" sub="kept with their reasons" />
        <Tile value={r.deadLetters.length} label="Events dead-lettered" sub="after 3 attempts each" />
        <Tile value={`$${(r.cost.lambdaUsd + r.cost.s3RequestsUsd).toFixed(4)}`} label="This run on AWS" sub="Lambda + S3 requests, list prices" />
      </div>

      <div className="grid-2">
        <section className="panel">
          <h2>Functions</h2>
          <table>
            <thead>
              <tr>
                <th>Function</th>
                <th className="num">Calls</th>
                <th className="num">Errors</th>
                <th className="num">Cold starts</th>
                <th className="num">Avg duration</th>
                <th className="num">GB-s</th>
              </tr>
            </thead>
            <tbody>
              {fns.map(([name, f]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="num">{f.invocations}</td>
                  <td className={`num ${f.errors ? "bad" : ""}`}>{f.errors}</td>
                  <td className="num">{f.coldStarts}</td>
                  <td className="num">{f.invocations ? `${fmt.int(Math.round(f.durationMs / f.invocations))} ms` : "-"}</td>
                  <td className="num">{f.gbSeconds.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small" style={{ marginTop: 8 }}>
            Errors include retries: a function that fails is called again twice before its event goes to the dead-letter queue.
          </p>
        </section>

        <section className="panel">
          <h2>Why records were quarantined</h2>
          <HBars
            ariaLabel="Quarantined records by reason"
            data={Object.entries(r.quality.reasons).map(([k, v]) => ({ label: REASON[k] ?? k, value: v }))}
            format={(v) => fmt.int(v)}
          />
        </section>
      </div>

      <div className="grid-2">
        <section className="panel">
          <h2>Dead-letter queue</h2>
          {r.deadLetters.length ? (
            r.deadLetters.map((m, i) => (
              <div className="callout" key={i} style={{ marginBottom: 8 }}>
                <b>{m.function}</b> failed {m.attempts} times
                <div className="small">
                  <code>{m.error}</code>
                </div>
              </div>
            ))
          ) : (
            <p className="small">Empty.</p>
          )}
          <p className="small">
            A file that isn't text can't be filtered record by record, so Validate raises instead of quarantining. It needs a person,
            and the queue is where they'd look.
          </p>
        </section>
        <section className="panel">
          <h2>What this would cost on AWS</h2>
          <table>
            <tbody>
              <tr>
                <td>Lambda (requests + GB-seconds)</td>
                <td className="num">${r.cost.lambdaUsd.toFixed(5)}</td>
              </tr>
              <tr>
                <td>S3 requests ({fmt.int(Object.values(r.s3.requests).reduce((a, b) => a + b, 0))})</td>
                <td className="num">${r.cost.s3RequestsUsd.toFixed(5)}</td>
              </tr>
              <tr>
                <td>S3 storage ({(r.s3.bytesStored / 1024 ** 2).toFixed(0)} MB), per month</td>
                <td className="num">${r.cost.s3StoragePerMonthUsd.toFixed(4)}</td>
              </tr>
              <tr>
                <td>RDS db.t4g.micro, per month</td>
                <td className="num">${r.cost.rdsPerMonthUsd.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
          <p className="small" style={{ marginTop: 8 }}>
            {r.cost.note} The database is the only real cost; the serverless parts are fractions of a cent per run.
          </p>
        </section>
      </div>
      <p className="small">
        Run finished in {r.wallSeconds} s on {new Date(r.stack.deployedAt).toLocaleString("en-GB")}.
      </p>
    </>
  );
}
