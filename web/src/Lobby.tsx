import { useState } from "react";
import { HBars } from "./charts";
import { load, type Lobby as LobbyData, type Meta, type TierLists } from "./data";
import { Empty, Tile, fmt, useAsync } from "./ui";

// Both sides of a contested/uncontested comparison need this many games to be listed.
const MIN_SIDE_GAMES = 15;
const contested = (n: number) => (n === 0 ? "Uncontested" : n >= 3 ? "3+ other boards" : `${n} other board${n > 1 ? "s" : ""}`);

export function Lobby() {
  const { data, error } = useAsync(
    () => Promise.all([load<Meta>("meta.json"), load<LobbyData>("lobby.json"), load<TierLists>("tierlists.json")]),
    [],
  );
  const [patch, setPatch] = useState<string | null>(null);
  if (error) return <Empty title="No lobby data yet">{error}</Empty>;
  if (!data) return <Empty title="Loading lobby dynamics…" />;
  const [meta, lobby, lists] = data;
  const current = patch ?? meta.patches[meta.patches.length - 1];
  const view = lobby[current];
  const carry = view.carryContest;
  const free = carry.find((c) => c.contestedBy === 0);
  const fought = carry.filter((c) => c.contestedBy > 0);
  const foughtGames = fought.reduce((a, c) => a + c.games, 0);
  const foughtAvg = fought.reduce((a, c) => a + c.avgPlacement * c.games, 0) / (foughtGames || 1);
  const comps = lists[current].comp
    .filter((c) => c.tier && c.avgUncontested != null && c.avgContested != null)
    .filter((c) => Math.min(c.games * (c.contestRate ?? 0), c.games * (1 - (c.contestRate ?? 0))) >= MIN_SIDE_GAMES)
    .map((c) => ({ ...c, penalty: (c.avgContested as number) - (c.avgUncontested as number) }));
  const hurt = [...comps].sort((a, b) => b.penalty - a.penalty).slice(0, 8);

  return (
    <>
      <section>
        <h1>Lobby dynamics</h1>
        <p>
          A board isn't played alone. Each player follows an economy plan, all eight draw champions from one shared pool, and fights are won
          or lost partly on positioning. Match data shows the first two only indirectly (the final level, star levels and who else held a
          champion), so the ETL reads them back from the boards. Positioning isn't in the data at all; the <a href="#/truth">truth check</a>{" "}
          measures it from the simulator's side.
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
      </div>

      <div className="tiles">
        {free && <Tile value={fmt.place(free.avgPlacement)} label="Avg place, carry uncontested" sub={`${fmt.int(free.games)} boards`} />}
        <Tile value={fmt.place(foughtAvg)} label="Avg place, carry contested" sub={`${fmt.int(foughtGames)} boards share their carry`} />
        {free && (
          <Tile
            value={fmt.pct(free.threeStarRate, 1)}
            label="Carries 3-starred, uncontested"
            sub={`${fmt.pct(fought[0]?.threeStarRate ?? 0, 1)} with one rival`}
          />
        )}
      </div>

      <section className="panel">
        <h2>Contested units: one pool, eight players</h2>
        <p className="small">
          Every champion has a fixed number of copies (30 of each 1-cost down to 9 of each 5-cost), and a 2-star takes 3 of them, a 3-star
          9. The more boards hold a champion, the fewer copies each player sees.
        </p>
        <div className="grid-2">
          <div>
            <h3>Units reaching 2 stars or more</h3>
            <HBars
              ariaLabel={`Share of units at 2 stars or more by how many other boards held the champion, patch ${current}`}
              data={view.unitContest.map((u) => ({ label: contested(u.contestedBy), value: u.twoStarRate }))}
              format={(v) => fmt.pct(v)}
            />
          </div>
          <div>
            <h3>Top-4 rate by carry contest</h3>
            <HBars
              ariaLabel={`Top-4 rate by how many other boards held the board's carry, patch ${current}`}
              data={carry.map((c) => ({ label: contested(c.contestedBy), value: c.top4Rate }))}
              format={(v) => fmt.pct(v)}
            />
          </div>
        </div>
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Carry held by</th>
                <th className="num">Boards</th>
                <th className="num">Avg place</th>
                <th className="num">Top 4</th>
                <th className="num">Carry avg stars</th>
                <th className="num">Carry 3-star</th>
              </tr>
            </thead>
            <tbody>
              {carry.map((c) => (
                <tr key={c.contestedBy}>
                  <td>{contested(c.contestedBy)}</td>
                  <td className="num">{fmt.int(c.games)}</td>
                  <td className="num">{fmt.place(c.avgPlacement)}</td>
                  <td className="num">{fmt.pct(c.top4Rate)}</td>
                  <td className="num">{c.avgStar.toFixed(2)}</td>
                  <td className="num">{fmt.pct(c.threeStarRate, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {hurt.length > 0 && (
        <section className="panel">
          <h2>Comps that suffer most when contested</h2>
          <p className="small">
            Ranked comps, comparing games where nobody else held the carry with games where someone did (at least {MIN_SIDE_GAMES} of each).
          </p>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Comp</th>
                  <th className="num">Contested</th>
                  <th className="num">Avg alone</th>
                  <th className="num">Avg contested</th>
                  <th className="num">Penalty</th>
                </tr>
              </thead>
              <tbody>
                {hurt.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="num">{fmt.pct(c.contestRate ?? 0)}</td>
                    <td className="num">{fmt.place(c.avgUncontested as number)}</td>
                    <td className="num">{fmt.place(c.avgContested as number)}</td>
                    <td className="num bad">+{c.penalty.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Economy: how the gold was spent</h2>
        <p className="small">
          Read from the final board: a 3-star 1-3 cost below level 9 is a reroll comp, level 9 or more is fast 9, the rest fast 8.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Playstyle</th>
                <th className="num">Share</th>
                <th className="num">Avg place</th>
                <th className="num">Top 4</th>
                <th className="num">Win</th>
                <th className="num">Avg level</th>
                <th className="num">Gold left</th>
                <th className="num">Last round</th>
              </tr>
            </thead>
            <tbody>
              {view.playstyles.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="num">{fmt.pct(p.share)}</td>
                  <td className="num">{fmt.place(p.avgPlacement)}</td>
                  <td className="num">{fmt.pct(p.top4Rate)}</td>
                  <td className="num">{fmt.pct(p.winRate, 1)}</td>
                  <td className="num">{p.avgLevel.toFixed(1)}</td>
                  <td className="num">{p.avgGoldLeft.toFixed(0)}</td>
                  <td className="num">{p.avgLastRound.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div>
            <h3>Top-4 rate by final level</h3>
            <HBars
              ariaLabel={`Top-4 rate by final level, patch ${current}`}
              data={view.levels.map((l) => ({ label: `Level ${l.level} (${fmt.int(l.games)} boards)`, value: l.top4Rate }))}
              format={(v) => fmt.pct(v)}
            />
          </div>
          <p className="callout" style={{ alignSelf: "start", margin: 0 }}>
            Don't read either as a ranking. A player knocked out in stage 4 never reached level 9, so whoever <i>did</i> reach it mostly
            survived: "Fast 9" boards place well partly by definition. Playstyles get no tier for that reason, and the{" "}
            <a href="#/truth">truth check</a> compares these numbers with the plans players actually followed.
          </p>
        </div>
      </section>
    </>
  );
}
