import { useState } from "react";
import { load } from "./data";
import type { GameData } from "./sim/core";
import { useAsync } from "./ui";

const SLOTS = [[2, 0], [3, 0], [4, 0], [1, 1], [5, 1], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2]];
const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

function hex(x: number, y: number, radius: number) {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (i * 60 - 30) * Math.PI / 180;
    return `${x + radius * Math.cos(angle)},${y + radius * Math.sin(angle)}`;
  }).join(" ");
}

export function ArenaPreview() {
  const { data: game, error } = useAsync(() => load<GameData>("game.json"), []);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(0);
  if (error) return <div className="arena-loading"><p>The sample board didn’t load.</p><a href="#/simulator">Open the simulator →</a></div>;
  if (!game) return <div className="arena-loading" role="status">Scouting a lobby…</div>;

  const patch = Object.keys(game.patches).at(-1)!;
  const boards = game.patches[patch].boards;
  const board = boards[index % boards.length];
  const units = board.units.slice(0, SLOTS.length).map(([id, star]) => ({ champion: game.champions.find((c) => c.id === id)!, star }));
  const pick = units[selected] ?? units[0];
  const traits = pick.champion.traits.map((id) => game.traits.find((trait) => trait.id === id)?.name).filter(Boolean);

  return (
    <div className="arena-scene">
      <span className="arena-sticker">Set {game.set}<span>sample lobby</span></span>
      <span className="scene-spark spark-one" aria-hidden="true">✦</span>
      <span className="scene-spark spark-two" aria-hidden="true">✧</span>
      <svg className="arena-board" viewBox="0 0 570 410" role="group" aria-label="Sampled lobby board. Select a champion to see their details.">
        <defs>
          <linearGradient id="island-top" x2="0.7" y2="1">
            <stop stopColor="#5156a0" /><stop offset="1" stopColor="#32305c" />
          </linearGradient>
          <linearGradient id="island-edge" x2="0" y2="1">
            <stop stopColor="#3d2767" /><stop offset="1" stopColor="#20183d" />
          </linearGradient>
          <clipPath id="unit-portrait"><circle r="25" /></clipPath>
        </defs>
        <ellipse className="island-shadow" cx="285" cy="352" rx="224" ry="26" />
        <g transform="rotate(-9 285 200)">
          <path d="M30 115 85 65 483 65 540 115 540 295 485 350 85 350 30 295Z" fill="url(#island-edge)" stroke="#20183d" strokeWidth="5" />
          <path d="M30 90 85 40 483 40 540 90 540 270 485 325 85 325 30 270Z" fill="url(#island-top)" stroke="#b8a0f5" strokeWidth="4" />
          {Array.from({ length: 21 }, (_, i) => {
            const row = Math.floor(i / 7), col = i % 7;
            return <polygon key={i} points={hex(79 + col * 65 + (row % 2) * 32, 108 + row * 61, 36)} fill={row === 0 ? "#49517f" : "#3d436e"} stroke="#7886bc" strokeWidth="1.5" />;
          })}
          {units.map(({ champion, star }, i) => {
            const [col, row] = SLOTS[i];
            const x = 79 + col * 65 + (row % 2) * 32, y = 108 + row * 61;
            const choose = () => setSelected(i);
            return (
              <g key={`${index}-${i}`} className={`arena-unit cost-${champion.cost}${selected === i ? " chosen" : ""}`}
                transform={`translate(${x} ${y})`} role="button" tabIndex={0}
                aria-label={`${champion.name}, ${star} star, ${champion.cost} gold`} aria-pressed={selected === i}
                onClick={choose} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } }}>
                <title>{champion.name}</title>
                <ellipse className="unit-shadow" cy="19" rx="30" ry="13" />
                <circle className="unit-ring" r="29" />
                <text textAnchor="middle" y="5" fill="#fff">{champion.name.slice(0, 2)}</text>
                <image href={champion.icon ?? undefined} x="-25" y="-25" width="50" height="50" clipPath="url(#unit-portrait)" />
                <text className="unit-stars" textAnchor="middle" y="-32">{"★".repeat(star)}</text>
              </g>
            );
          })}
          <path d="M46 96 60 80 68 98 59 119Z M503 280 520 262 528 284 516 301Z" fill="#63e5c4" stroke="#215c67" strokeWidth="3" />
        </g>
        <g className="little-scout" transform="translate(58 260) rotate(-12)">
          <ellipse cy="73" rx="37" ry="10" fill="#0e0c23" opacity=".3" />
          <path d="M-28 26Q-57 46-34 59L-20 46M28 26Q57 46 34 59L20 46" fill="#5c5993" stroke="#22203d" strokeWidth="3" />
          <ellipse cy="30" rx="32" ry="42" fill="#302b52" stroke="#aaa4dd" strokeWidth="3" />
          <path d="M-24 23Q-18-5 0 10Q18-5 24 23L24 44Q0 75-24 44Z" fill="#fff0d3" />
          <ellipse cx="-10" cy="23" rx="4" ry="6" fill="#28233f" /><ellipse cx="10" cy="23" rx="4" ry="6" fill="#28233f" />
          <path d="M-7 33 0 43 8 33Z" fill="#ffbb61" />
          <ellipse cx="-20" cy="35" rx="6" ry="3" fill="#f78eab" /><ellipse cx="20" cy="35" rx="6" ry="3" fill="#f78eab" />
          <path d="M-18-8-22-25-7-17 0-32 8-17 23-25 19-8Z" fill="#ffcc68" stroke="#ac7337" strokeWidth="2" />
          <path d="M-19 68-28 78-5 75M19 68 28 78 5 75" fill="#ffbb61" />
        </g>
      </svg>
      <div className="scout-info" aria-live="polite">
        <span className="scout-stars" aria-hidden="true">{"★".repeat(pick.star)}</span>
        <b>{pick.champion.name}</b><span>{pick.champion.cost}g · {traits.join(" / ")}</span>
      </div>
      <div className="arena-controls">
        <p>Patch {patch} · finished {ORDINAL[board.placement]}<small>Sampled units; positions are illustrative.</small></p>
        <button className="reroll" onClick={() => { setIndex((i) => (i + 37) % boards.length); setSelected(0); }}><span aria-hidden="true">↻</span> Scout another</button>
      </div>
    </div>
  );
}
