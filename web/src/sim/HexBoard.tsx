import { COLS, ROWS, type Battle, type GameData, type Placed, type Unit } from "./engine";

const SIZE = 30; // hex radius
const W = Math.sqrt(3) * SIZE;
const PAD = 6;
export const BOARD_W = W * (COLS + 0.5) + PAD * 2;
export const BOARD_H = SIZE * 1.5 * (ROWS - 1) + SIZE * 2 + PAD * 2;

function center(row: number, col: number): [number, number] {
  return [PAD + W * (col + 0.5 + 0.5 * (row & 1)), PAD + SIZE + SIZE * 1.5 * row];
}

function hexPoints(cx: number, cy: number, r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

/** Where a unit is drawn: between the hex it left and the one it's walking to. */
function position(u: Unit): [number, number] {
  const [x0, y0] = center(u.fromRow, u.fromCol);
  const [x1, y1] = center(u.row, u.col);
  const t = u.moveProgress;
  return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
}

interface Token {
  key: string;
  team: 0 | 1;
  id: string;
  star: number;
  items: string[];
  x: number;
  y: number;
  hp?: number; // 0-1, during a fight
  mana?: number;
  index?: number; // your units, for selection
}

interface Props {
  game: GameData;
  mine: Placed[];
  opponent: Placed[];
  battle: Battle | null;
  selected: number | null;
  /** True when a champion or unit is waiting to be placed: your empty hexes light up. */
  placing: boolean;
  onHex: (row: number, col: number) => void;
  onUnit: (index: number) => void;
}

export function HexBoard({ game, mine, opponent, battle, selected, placing, onHex, onUnit }: Props) {
  const champs = new Map(game.champions.map((c) => [c.id, c]));
  const items = new Map(game.items.map((i) => [i.id, i]));
  const tokens: Token[] = battle
    ? battle.units
        .filter((u) => u.alive)
        .map((u) => {
          const [x, y] = position(u);
          return { key: `u${u.uid}`, team: u.team, id: u.champion.id, star: u.star, items: u.items, x, y, hp: u.hp / u.maxHp, mana: u.mana / u.maxMana };
        })
    : [
        ...mine.map((p, index) => ({ key: `m${index}`, team: 0 as const, ...p, index, x: center(p.row, p.col)[0], y: center(p.row, p.col)[1] })),
        ...opponent.map((p, i) => ({ key: `o${i}`, team: 1 as const, ...p, x: center(p.row, p.col)[0], y: center(p.row, p.col)[1] })),
      ];
  const byUid = battle ? new Map(battle.units.map((u) => [u.uid, u])) : null;
  const taken = new Set(mine.map((p) => `${p.row}:${p.col}`));

  return (
    <svg className="hexboard" viewBox={`0 0 ${BOARD_W.toFixed(0)} ${BOARD_H.toFixed(0)}`} width="100%" role="img" aria-label="Combat board: the opponent's half on top, yours below">
      <defs>
        <clipPath id="unit-clip">
          <circle r={SIZE * 0.72} />
        </clipPath>
      </defs>
      {Array.from({ length: ROWS }, (_, row) =>
        Array.from({ length: COLS }, (_, col) => {
          const [cx, cy] = center(row, col);
          const own = row >= ROWS / 2;
          const open = own && placing && !battle && !taken.has(`${row}:${col}`);
          return (
            <polygon
              key={`${row}:${col}`}
              className={`hex ${own ? "own" : "theirs"}${open ? " open" : ""}`}
              points={hexPoints(cx, cy, SIZE - 1.5)}
              onClick={() => own && !battle && onHex(row, col)}
            />
          );
        }),
      )}

      {battle &&
        battle.events.map((e, i) => {
          const from = byUid!.get(e.from);
          const to = byUid!.get(e.to);
          if (!from || !to) return null;
          const age = battle.time - e.t;
          if (e.kind === "attack" && age < 0.15) {
            const [x1, y1] = position(from);
            const [x2, y2] = position(to);
            return <line key={i} className={`shot team${from.team}${e.crit ? " crit" : ""}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
          }
          if (e.kind === "spell" && age < 0.45) {
            const [x, y] = position(to);
            return <circle key={i} className={`burst team${from.team}`} cx={x} cy={y} r={SIZE * (1.2 + age * 2)} style={{ opacity: 1 - age / 0.45 }} />;
          }
          return null;
        })}

      {tokens.map((t) => {
        const c = champs.get(t.id);
        const r = SIZE * 0.72;
        const pickable = t.index !== undefined && !battle;
        return (
          <g
            key={t.key}
            transform={`translate(${t.x.toFixed(1)},${t.y.toFixed(1)})`}
            className={`token team${t.team}${pickable ? " pickable" : ""}${t.index !== undefined && t.index === selected ? " selected" : ""}`}
            onClick={pickable ? () => onUnit(t.index!) : undefined}
          >
            <title>{`${c?.name ?? t.id} ${"★".repeat(t.star)}${t.items.length ? ` · ${t.items.map((i) => items.get(i)?.name ?? i).join(", ")}` : ""}`}</title>
            <circle className={`ring cost${c?.cost ?? 1}`} r={r + 2.5} />
            {c?.icon ? (
              <image href={c.icon} x={-r} y={-r} width={r * 2} height={r * 2} clipPath="url(#unit-clip)" preserveAspectRatio="xMidYMid slice" />
            ) : (
              <text textAnchor="middle" dy="0.35em">{c?.name.slice(0, 2)}</text>
            )}
            <text className="stars" y={-r - 4} textAnchor="middle">{"★".repeat(t.star)}</text>
            {t.items.slice(0, 3).map((id, k) => {
              const icon = items.get(id)?.icon;
              const x = (k - (t.items.length - 1) / 2) * 11 - 5;
              return icon ? <image key={k} href={icon} x={x} y={r - 7} width={10} height={10} /> : <rect key={k} className="item-dot" x={x} y={r - 7} width={10} height={10} />;
            })}
            {t.hp !== undefined && (
              <g transform={`translate(${-r},${r + 5})`}>
                <rect className="bar-bg" width={r * 2} height={4} rx={2} />
                <rect className={`hp team${t.team}`} width={Math.max(0, r * 2 * t.hp)} height={4} rx={2} />
                <rect className="bar-bg" y={5} width={r * 2} height={3} rx={1.5} />
                <rect className="mana" y={5} width={Math.max(0, r * 2 * (t.mana ?? 0))} height={3} rx={1.5} />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
