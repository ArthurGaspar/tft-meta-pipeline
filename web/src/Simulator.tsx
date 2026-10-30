import { useEffect, useMemo, useRef, useState } from "react";
import { HBars } from "./charts";
import { PLAYSTYLE_LABEL, load } from "./data";
import { HexBoard } from "./sim/HexBoard";
import {
  ITEMS,
  TICK,
  TRAITS,
  activeTraits,
  autoPlace,
  createBattle,
  gameForPatch,
  runToEnd,
  sampleToUnits,
  spellCoverage,
  spellFor,
  step,
  traitValues,
  type ActiveTrait,
  type Battle,
  type GameData,
  type Placed,
} from "./sim/engine";
import { Empty, Icon, Tile, useAsync } from "./ui";

const MAX_UNITS = 10;
const BATCH = 200;
const STORAGE_KEY = "tft-sim-board-v1";
const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];
const units = (n: number, noun = "unit") => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Fills a tooltip's @Value@ / @Value*100@ placeholders from known values; the rest read "?". */
function fill(desc: string | undefined, values: Record<string, number> = {}): string {
  return (desc ?? "").replace(/@([A-Za-z0-9_.:]+?)(\*100)?@/g, (_, name: string, pct?: string) => {
    const v = values[name];
    if (v === undefined) return "?";
    const x = pct ? v * 100 : v;
    return String(Math.round(x * 100) / 100);
  });
}

/** An item's tooltip with its values; flavour-only tooltips (Deathcap, Deathblade) get their hidden effect spelled out. */
function itemText(desc: string | undefined, effects: Record<string, number> = {}): string {
  const text = fill((desc ?? "").replace(/@TFTUnitProperty[^@]*@/g, ""), effects).trim();
  const bonus = effects.BonusDamage ? ` Deals ${Math.round(effects.BonusDamage * 100)}% more damage.` : "";
  return (text || "Stats only.") + (text.includes("more damage") ? "" : bonus);
}

function traitTooltip(t: ActiveTrait): string {
  const tier = Math.max(1, t.tier);
  const lines = [`${t.trait.name} (${t.trait.breakpoints.join(" / ")})`, fill(t.trait.desc, traitValues(t.trait, tier)).replace(/\(\?\)\s*/g, "")];
  const missing = TRAITS[t.trait.name]?.notModeled;
  if (missing) lines.push(`Not in a single fight: ${missing}.`);
  return lines.join("\n\n");
}

interface BatchResult {
  label: string;
  fights: number;
  wins: number;
  draws: number;
  survivors: number;
  time: number;
}

function savedBoard(game: GameData): Placed[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const known = new Set(game.champions.map((c) => c.id));
    const board = (JSON.parse(raw) as Placed[]).filter((p) => known.has(p.id));
    return board.length ? board : null;
  } catch {
    return null;
  }
}

export function Simulator() {
  const { data, error } = useAsync(() => load<GameData>("game.json"), []);
  if (error) return <Empty title="No game data yet">{error}</Empty>;
  if (!data) return <Empty title="Loading the simulator…" />;
  return <SimulatorView game={data} />;
}

function SimulatorView({ game }: { game: GameData }) {
  const patches = Object.keys(game.patches);
  const [patch, setPatch] = useState(patches[patches.length - 1]);
  const boards = game.patches[patch].boards;
  const champs = useMemo(() => new Map(game.champions.map((c) => [c.id, c])), [game]);
  const [mine, setMine] = useState<Placed[]>(() => savedBoard(game) ?? autoPlace(sampleToUnits(boards[0]), 0, game));
  const [oppIndex, setOppIndex] = useState(() => Math.floor(Math.random() * boards.length));
  const oppBoard = boards[oppIndex % boards.length];
  const opponent = useMemo(() => autoPlace(sampleToUnits(oppBoard), 1, game), [oppBoard, game]);
  const [selected, setSelected] = useState<number | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const battle = useRef<Battle | null>(null);
  const [, setFrame] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const [busy, setBusy] = useState(false);

  // A batch result describes one board against one opponent; drop it when either changes.
  useEffect(() => setBatch(null), [mine, oppIndex, patch]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mine));
    } catch {
      // storage can be unavailable; the board still works for this visit
    }
  }, [mine]);

  // The animation: fixed-size engine ticks, as many per frame as real time (times speed) asks for.
  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    let pending = 0;
    let raf = 0;
    const frame = (now: number) => {
      const b = battle.current;
      if (!b) return;
      // Catch up on slow or throttled frames, but not on the long gap after a hidden tab comes back.
      pending += Math.min(1, (now - last) / 1000) * speed;
      last = now;
      while (pending >= TICK && !b.done) {
        step(b);
        pending -= TICK;
      }
      setFrame((f) => f + 1);
      if (b.done) setRunning(false);
      else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running, speed]);

  const b = battle.current;
  const editing = !b;
  const sel = selected != null ? mine[selected] : null;

  const placeAt = (row: number, col: number) => {
    if (picking) {
      if (mine.length >= MAX_UNITS) return;
      setMine([...mine, { id: picking, star: 2, items: [], row, col }]);
      setSelected(mine.length);
      setPicking(null);
    } else if (selected != null) {
      setMine(mine.map((p, i) => (i === selected ? { ...p, row, col } : p)));
    }
  };
  const update = (patchUnit: Partial<Placed>) => selected != null && setMine(mine.map((p, i) => (i === selected ? { ...p, ...patchUnit } : p)));
  const remove = () => {
    if (selected == null) return;
    setMine(mine.filter((_, i) => i !== selected));
    setSelected(null);
  };

  const fight = () => {
    battle.current = createBattle(game, patch, [mine, opponent], Math.floor(Math.random() * 2 ** 31));
    setSelected(null);
    setPicking(null);
    setRunning(true);
  };
  const backToSetup = () => {
    battle.current = null;
    setRunning(false);
    setFrame((f) => f + 1);
  };

  const runBatch = (versusField: boolean) => {
    setBusy(true);
    setBatch(null);
    setTimeout(() => {
      const r: BatchResult = { label: versusField ? `1 fight against each of ${BATCH} lobby boards` : `${BATCH} fights against this opponent`, fights: 0, wins: 0, draws: 0, survivors: 0, time: 0 };
      for (let i = 0; i < BATCH; i++) {
        const opp = versusField ? autoPlace(sampleToUnits(boards[i % boards.length]), 1, game) : opponent;
        const out = runToEnd(createBattle(game, patch, [mine, opp], 7919 * (i + 1)));
        r.fights++;
        r.wins += out.winner === 0 ? 1 : 0;
        r.draws += out.winner === null ? 1 : 0;
        r.survivors += out.winner === 0 ? out.survivors[0] : 0;
        r.time += out.time;
      }
      setBatch(r);
      setBusy(false);
    }, 20);
  };

  // the set as Riot shipped it in this patch: its stats, ability values and trait values
  const shipped = gameForPatch(game, patch);
  const myTraits = activeTraits(mine.map((p) => p.id), shipped);
  const theirTraits = activeTraits(opponent.map((p) => p.id), shipped).filter((t) => t.tier > 0);
  const damage = b
    ? b.units
        .filter((u) => u.team === 0)
        .map((u, i, all) => ({
          label: all.filter((x) => x.champion.id === u.champion.id).length > 1 ? `${u.champion.name} #${i + 1}` : u.champion.name,
          value: Math.round(u.damageDealt),
        }))
        .sort((x, y) => y.value - x.value)
    : [];

  return (
    <>
      <section>
        <h1>Fight simulator</h1>
        <p>
          Build a board, place it, and watch it fight a real board from the simulated lobbies, in real time. Units use their Set{" "}
          {game.set} base stats, and every ability, trait and item does what its in-game description says: traits and items with
          Riot's own values, all scaled by the hidden meta of the patch you pick (the balance the tier lists are trying to recover).
          Positioning matters: units walk to the nearest enemy, ranged units hit from afar, and spells hit areas, lines and cones.
        </p>
        <p className="small">
          Riot hasn't published Set {game.set}'s ability numbers yet (only {game.champions.filter((c) => Object.keys(c.spell?.vars ?? {}).length).length} of{" "}
          {game.champions.length} abilities have them), so the rest are estimated by cost and marked as such. They switch to Riot's
          values automatically once the game data has them. Effects that happen between rounds (shops, quests, rewards) aren't part of
          a single fight and are listed where they apply.
        </p>
      </section>

      <div className="row">
        <div className="seg" role="group" aria-label="Patch">
          {patches.map((p) => (
            <button key={p} aria-pressed={p === patch} disabled={!editing} onClick={() => setPatch(p)}>
              Patch {p}
            </button>
          ))}
        </div>
      </div>

      <div className="sim-layout">
        <section className="panel sim-board">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <span className="small">
              <b className="team-label team1">Opponent</b> {PLAYSTYLE_LABEL[oppBoard.strategy] ?? oppBoard.strategy} board, level {oppBoard.level}, placed{" "}
              {ORDINAL[oppBoard.placement]} in its lobby
            </span>
            <button className="btn" disabled={!editing} onClick={() => setOppIndex(Math.floor(Math.random() * boards.length))}>
              New opponent
            </button>
          </div>
          <HexBoard
            game={game}
            mine={mine}
            opponent={opponent}
            battle={b}
            selected={selected}
            placing={picking != null || selected != null}
            onHex={placeAt}
            onUnit={(i) => {
              setPicking(null);
              setSelected(selected === i ? null : i);
            }}
          />
          <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
            <span className="small">
              <b className="team-label team0">You</b> {mine.length}/{MAX_UNITS} units
              {b && ` · ${b.time.toFixed(1)} s`}
            </span>
            {b ? (
              <div className="row">
                <div className="seg" role="group" aria-label="Speed">
                  {[1, 2, 4].map((s) => (
                    <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                      {s}×
                    </button>
                  ))}
                </div>
                <button className="btn" onClick={backToSetup}>
                  Back to setup
                </button>
              </div>
            ) : (
              <button className="btn primary" disabled={!mine.length} onClick={fight}>
                Fight
              </button>
            )}
          </div>
          {b?.done && (
            <p className={`result ${b.winner === 0 ? "good" : b.winner === 1 ? "bad" : ""}`} role="status">
              {b.winner === 0
                ? `You won with ${units(b.units.filter((u) => u.team === 0 && u.alive).length)} standing.`
                : b.winner === 1
                  ? `You lost: ${units(b.units.filter((u) => u.team === 1 && u.alive).length, "enemy unit")} left standing.`
                  : "Time ran out: a draw."}
            </p>
          )}
        </section>

        <div className="sim-side">
          {editing && (
            <section className="panel">
              {sel ? (
                <UnitEditor game={shipped} unit={sel} onChange={update} onRemove={remove} onDone={() => setSelected(null)} />
              ) : (
                <>
                  <h2>Your board</h2>
                  <p className="small" style={{ marginTop: 0 }}>
                    Pick a champion below, then a hex on your half. Click a unit to set its stars and items, or to move it.
                  </p>
                  <div className="row">
                    <button className="btn" onClick={() => setMine(autoPlace(mine, 0, game))} disabled={!mine.length}>
                      Auto-arrange
                    </button>
                    <button className="btn" onClick={() => setMine(autoPlace(sampleToUnits(boards[Math.floor(Math.random() * boards.length)]), 0, game))}>
                      Random lobby board
                    </button>
                    <button className="btn" onClick={() => setMine([])} disabled={!mine.length}>
                      Clear
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          <section className="panel">
            <h2>Traits</h2>
            {myTraits.length ? (
              <div className="trait-list">
                {myTraits.map((t) => (
                  <span key={t.trait.id} className={`trait-chip${t.tier ? " on" : ""}`} title={traitTooltip(t)}>
                    <b>{t.count}</b> {t.trait.name}
                    <span className="small"> / {t.trait.breakpoints.find((x) => x > t.count) ?? t.trait.breakpoints[t.trait.breakpoints.length - 1]}</span>
                  </span>
                ))}
              </div>
            ) : (
              <p className="small">No units yet.</p>
            )}
            {theirTraits.length > 0 && (
              <p className="small" style={{ marginBottom: 0 }}>
                Opponent: {theirTraits.map((t) => `${t.count} ${t.trait.name}`).join(", ")}
              </p>
            )}
            {myTraits.some((t) => t.tier && TRAITS[t.trait.name]?.notModeled) && (
              <p className="small" style={{ marginBottom: 0 }}>
                Not part of a single fight:{" "}
                {myTraits
                  .filter((t) => t.tier && TRAITS[t.trait.name]?.notModeled)
                  .map((t) => `${t.trait.name} (${TRAITS[t.trait.name]?.notModeled})`)
                  .join("; ")}
                .
              </p>
            )}
            <p className="small" style={{ marginBottom: 0 }}>Hover a trait for what it does at your breakpoint.</p>
          </section>

          {editing && (
            <section className="panel">
              <h2>How good is this board?</h2>
              <div className="row">
                <button className="btn" disabled={busy || !mine.length} onClick={() => runBatch(false)}>
                  {BATCH} fights vs this opponent
                </button>
                <button className="btn" disabled={busy || !mine.length} onClick={() => runBatch(true)}>
                  vs {BATCH} lobby boards
                </button>
              </div>
              {busy && <p className="small">Simulating…</p>}
              {batch && (
                <>
                  <div className="tiles" style={{ marginTop: 12 }}>
                    <Tile value={`${((batch.wins / batch.fights) * 100).toFixed(0)}%`} label="Win rate" sub={batch.label} />
                    <Tile
                      value={batch.wins ? (batch.survivors / batch.wins).toFixed(1) : "-"}
                      label="Units left when winning"
                      sub={`${batch.draws} draws · ${(batch.time / batch.fights).toFixed(1)} s per fight`}
                    />
                  </div>
                  <p className="small" style={{ marginBottom: 0 }}>
                    Move a unit and run it again: positioning alone can swing these numbers.
                  </p>
                </>
              )}
            </section>
          )}

          {b?.done && damage.length > 0 && (
            <section className="panel">
              <h2>Damage dealt by your units</h2>
              <HBars ariaLabel="Damage dealt by each of your units in the last fight" data={damage} format={(v) => v.toLocaleString("en-US")} />
            </section>
          )}
        </div>
      </div>

      {editing && <Roster game={game} picking={picking} full={mine.length >= MAX_UNITS} onPick={(id) => {
        setSelected(null);
        setPicking(picking === id ? null : id);
      }} />}
      {picking && (
        <p className="small" role="status">
          Placing {champs.get(picking)?.name}: pick a highlighted hex on your half.
        </p>
      )}
    </>
  );
}

function UnitEditor({ game, unit, onChange, onRemove, onDone }: { game: GameData; unit: Placed; onChange: (p: Partial<Placed>) => void; onRemove: () => void; onDone: () => void }) {
  const c = game.champions.find((x) => x.id === unit.id);
  if (!c) return null;
  const setItem = (slot: number, id: string) => {
    const next = [...unit.items];
    if (id) next[slot] = id;
    else next.splice(slot, 1);
    onChange({ items: next.filter(Boolean).slice(0, 3) });
  };
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="entity" style={{ background: "none", padding: 0 }}>
          <Icon src={c.icon} name={c.name} />
          <div>
            <div className="nm">{c.name}</div>
            <div className="st">
              {c.cost}-cost · range {c.stats.range} · {c.traits.map((t) => game.traits.find((x) => x.id === t)?.name ?? t).join(", ")}
            </div>
          </div>
        </div>
        <button className="btn" onClick={onDone}>
          Done
        </button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <div className="seg" role="group" aria-label="Star level">
          {[1, 2, 3].map((s) => (
            <button key={s} aria-pressed={unit.star === s} onClick={() => onChange({ star: s })}>
              {"★".repeat(s)}
            </button>
          ))}
        </div>
        <button className="btn danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="item-slots">
        {[0, 1, 2].map((slot) => (
          <select key={slot} aria-label={`Item ${slot + 1}`} value={unit.items[slot] ?? ""} disabled={slot > unit.items.length} onChange={(e) => setItem(slot, e.target.value)}>
            <option value="">{slot < unit.items.length ? "Remove item" : "No item"}</option>
            {game.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        ))}
      </div>
      {unit.items.length > 0 && (
        <ul className="effects">
          {unit.items.map((id, k) => {
            const item = game.items.find((i) => i.id === id);
            if (!item) return null;
            const missing = ITEMS[item.name]?.notModeled;
            return (
              <li key={k}>
                <b>{item.name}:</b> {itemText(item.desc, item.effects)}
                {missing && <span className="small"> Not in a single fight: {missing}.</span>}
              </li>
            );
          })}
        </ul>
      )}
      <SpellInfo game={game} name={c.name} />
      <p className="small" style={{ marginBottom: 0 }}>Click any empty hex on your half to move this unit.</p>
    </>
  );
}

function SpellInfo({ game, name }: { game: GameData; name: string }) {
  const c = game.champions.find((x) => x.name === name);
  const def = spellFor(name);
  if (!c?.spell?.desc || !def) return null;
  const cover = spellCoverage(name, c.spell.vars);
  return (
    <div className="spell">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>{c.spell.name ?? "Ability"}</b>
        <span className={`badge${cover.real.length ? " real" : ""}`}>
          {cover.estimated.length === 0 ? "Riot's numbers" : cover.real.length ? "partly estimated" : "numbers estimated"}
        </span>
      </div>
      <p className="spell-text">{fill(c.spell.desc)}</p>
      <p className="small" style={{ margin: 0 }}>
        {cover.real.length
          ? `Uses Riot's values for ${cover.real.join(", ")}${cover.estimated.length ? `; the rest are estimates until Riot publishes them.` : "."}`
          : "Riot's game data has this ability's description but not its numbers yet, so the simulator estimates them by cost."}
        {def.notModeled && ` Not in a single fight: ${def.notModeled}.`}
      </p>
    </div>
  );
}

function Roster({ game, picking, full, onPick }: { game: GameData; picking: string | null; full: boolean; onPick: (id: string) => void }) {
  const [cost, setCost] = useState(0);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const traitNames = new Map(game.traits.map((t) => [t.id, t.name.toLowerCase()]));
  const shown = game.champions.filter(
    (c) => (!cost || c.cost === cost) && (!q || c.name.toLowerCase().includes(q) || c.traits.some((t) => traitNames.get(t)?.includes(q))),
  );
  return (
    <section className="panel">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Champions</h2>
        <div className="row">
          <input className="search" type="search" placeholder="Name or trait" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search champions" />
          <div className="seg" role="group" aria-label="Cost">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <button key={n} aria-pressed={cost === n} onClick={() => setCost(n)}>
                {n ? `${n}g` : "All"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {full && <p className="small">Your board is full ({MAX_UNITS} units). Remove one to add another.</p>}
      <div className="roster">
        {shown.map((c) => (
          <button key={c.id} className={`entity clickable cost${c.cost}`} aria-pressed={picking === c.id} disabled={full} onClick={() => onPick(c.id)} title={`${c.name}: ${c.cost}-cost, range ${c.stats.range}`}>
            <Icon src={c.icon} name={c.name} />
            <div>
              <div className="nm">{c.name}</div>
              <div className="st">{c.cost}g · range {c.stats.range}</div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
