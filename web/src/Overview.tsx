import { load, type Lobby, type Meta, type Pipeline, type TruthCheck } from "./data";
import { ArenaPreview } from "./ArenaPreview";
import { fmt, useAsync } from "./ui";

const SOURCE = "https://github.com/ArthurGaspar/tft-meta-pipeline";

export function Overview() {
  return (
    <>
      <section className="lobby-intro">
        <div className="lobby-copy">
          <p className="eyebrow"><span className="status-dot" /> Arthur’s TFT side project</p>
          <h1><span>TFT Meta</span><br />Pipeline<span className="title-spark" aria-hidden="true">✦</span></h1>
          <p className="lobby-lede">
            I play TFT. This is my side project for messing with match data: simulated lobbies,
            comp rankings, and a board you can fight on.
          </p>
          <div className="lobby-actions">
            <a className="action-link" href="#/tiers">Check the comps <span aria-hidden="true">→</span></a>
            <a className="secondary-action" href="#/simulator">Build a board <span aria-hidden="true">⚔</span></a>
          </div>
          <p className="lobby-disclaimer">Simulated matches, not live ranked data. Please don’t blame this for your next eighth.</p>
        </div>
        <ArenaPreview />
      </section>

      <RunEvidence />

      <section className="under-the-hood" aria-labelledby="under-the-hood-title">
        <div>
          <p className="eyebrow">Okay, but what’s running this?</p>
          <h2 id="under-the-hood-title">There’s a database under the board.</h2>
          <p>
            Python generates the lobbies. An ETL checks each record, loads MySQL, and calculates the rankings.
            The React site reads the output. The whole thing runs locally on minicloud, a small AWS-style emulator.
          </p>
          <div className="code-links">
            <a href="#/pipeline">Follow a match through the pipeline →</a>
            <a href={SOURCE}>Code on GitHub ↗</a>
          </div>
        </div>
        <ol className="data-trail" aria-label="Pipeline stages">
          <li><span aria-hidden="true">✧</span><b>Simulate</b><small>play the lobbies</small></li>
          <li><span aria-hidden="true">◇</span><b>Validate</b><small>keep the bad records out</small></li>
          <li><span aria-hidden="true">▥</span><b>Load</b><small>write MySQL</small></li>
          <li><span aria-hidden="true">✦</span><b>Aggregate</b><small>work out the rankings</small></li>
        </ol>
      </section>

      <details className="model-notes">
        <summary>What’s made up, and what comes from the game?</summary>
        <div>
          <p>
            The champion, item, and trait snapshots come from Community Dragon. The matches and hidden strength
            values are simulated. The combat model estimates missing ability values and skips systems between rounds.
          </p>
          <p>
            That lets me compare the rankings with a known answer, but it doesn’t tell us how well they would work
            on real matches. minicloud also runs functions one at a time; it isn’t a test of AWS at scale.
          </p>
          <a href={`${SOURCE}#run-it-locally`}>Run it yourself ↗</a>
        </div>
      </details>
    </>
  );
}

function RunEvidence() {
  const { data, error } = useAsync(
    () => Promise.all([
      load<Meta>("meta.json"),
      load<Pipeline>("pipeline.json"),
      load<TruthCheck>("truth-check.json"),
      load<Lobby>("lobby.json"),
    ]),
    [],
  );
  if (error) return <p className="run-unavailable">Couldn’t load the last run. <a href={`${SOURCE}#run-it-locally`}>Local setup instructions ↗</a></p>;
  if (!data) return <p role="status">Loading the last run…</p>;

  const [meta, pipeline, truth, lobby] = data;
  const boards = Object.values(meta.boards).reduce((sum, count) => sum + count, 0);
  const fast9 = truth.playstyle?.hidden.find((p) => p.id === "fast9");
  const inferred = Object.values(lobby).flatMap((patch) => patch.playstyles).filter((p) => p.id === "fast9");
  const games = inferred.reduce((sum, p) => sum + p.games, 0);
  const observed = games ? inferred.reduce((sum, p) => sum + p.games * p.avgPlacement, 0) / games : null;

  return (
    <>
      <section className="run-summary" aria-labelledby="run-title">
        <div className="run-label">
          <h2 id="run-title">The last run</h2>
          <span>{new Date(meta.generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}</span>
        </div>
        <dl className="run-numbers">
          <div><dt>matches</dt><dd>{fmt.int(meta.matches)}</dd></div>
          <div><dt>player boards</dt><dd>{fmt.int(boards)}</dd></div>
          <div><dt>records rejected</dt><dd>{fmt.int(pipeline.quality.quarantined)}</dd></div>
          <div><dt>seconds to run</dt><dd>{pipeline.wallSeconds.toFixed(0)}</dd></div>
        </dl>
      </section>

      {fast9 && observed !== null && (
        <section className="fast-nine" aria-labelledby="fast-nine-title">
          <span className="finding-sticker" aria-hidden="true">LVL 9</span>
          <div className="finding-copy">
            <p className="eyebrow">Something weird in the stats</p>
            <h2 id="fast-nine-title">Fast 9 looks a little too good here.</h2>
            <p>
              Count only the boards that reached level 9 and it looks busted. Count everyone who started with that
              plan, including the players who died trying, and it comes back down to earth. That’s survivorship bias.
            </p>
            <a href="#/truth">See who got left out →</a>
          </div>
          <dl className="finding-numbers">
            <div><dt>Made it to level 9</dt><dd>{observed.toFixed(2)}</dd></div>
            <span aria-hidden="true">vs.</span>
            <div><dt>Started with the plan</dt><dd>{fast9.avgPlacement.toFixed(2)}</dd></div>
          </dl>
          <p className="finding-caption">Average placement · lower is better · simulated matches</p>
        </section>
      )}
    </>
  );
}
