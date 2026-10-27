import { useState, type MouseEvent } from "react";
import { TIERS, type Tier } from "./data";

interface Tip {
  x: number;
  y: number;
  text: string;
}

const TipBox = ({ tip }: { tip: Tip | null }) =>
  tip ? (
    <div className="tip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
      {tip.text}
    </div>
  ) : null;

/** Single-series horizontal bars, value labels at the end; the title names the series. */
export function HBars({ data, format, ariaLabel }: { data: { label: string; value: number }[]; format: (v: number) => string; ariaLabel: string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const width = 560;
  const labelW = 190;
  const valueW = 44;
  const rowH = 28;
  const max = Math.max(1, ...data.map((d) => d.value));
  const x = (v: number) => (v / max) * (width - labelW - valueW);
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${width} ${data.length * rowH}`} width="100%" role="img" aria-label={ariaLabel}>
        {data.map((d, i) => {
          const y = i * rowH + 7;
          const w = Math.max(2, x(d.value));
          return (
            <g key={d.label} onMouseMove={(e: MouseEvent) => setTip({ x: e.clientX, y: e.clientY, text: `${d.label}: ${format(d.value)}` })} onMouseLeave={() => setTip(null)}>
              <rect x={0} y={i * rowH} width={width} height={rowH} fill="transparent" />
              <text x={labelW - 10} y={y + 11} textAnchor="end">{d.label}</text>
              <path d={`M${labelW},${y} H${labelW + w - 4} a4,4 0 0 1 4,4 V${y + 10} a4,4 0 0 1 -4,4 H${labelW} Z`} fill="var(--bar)" />
              <text x={labelW + w + 6} y={y + 11} style={{ fill: "var(--ink)" }}>{format(d.value)}</text>
            </g>
          );
        })}
      </svg>
      <TipBox tip={tip} />
    </>
  );
}

interface Point {
  x: number;
  y: number;
  label: string;
  tier: Tier;
}

/** Hidden power (x) against the published score (y, lower is better, drawn upwards). */
export function Scatter({ points, xLabel, yLabel, ariaLabel }: { points: Point[]; xLabel: string; yLabel: string; ariaLabel: string }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const W = 640;
  const H = 360;
  const pad = { l: 48, r: 14, t: 12, b: 40 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (v: number) => pad.l + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const sy = (v: number) => pad.t + ((v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
  const yTicks = [y0, (y0 + y1) / 2, y1];
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={ariaLabel}>
        {yTicks.map((t) => (
          <g key={t}>
            <line className="grid" x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} />
            <text x={pad.l - 6} y={sy(t) + 4} textAnchor="end">{t.toFixed(2)}</text>
          </g>
        ))}
        <line className="axis" x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} />
        <text x={(W + pad.l) / 2} y={H - 8} textAnchor="middle">{xLabel} →</text>
        <text x={14} y={(H - pad.b) / 2} textAnchor="middle" transform={`rotate(-90 14 ${(H - pad.b) / 2})`}>{yLabel}</text>
        {points.map((p) => (
          <circle
            key={p.label}
            cx={sx(p.x)}
            cy={sy(p.y)}
            r={6}
            fill={`var(--tier-${p.tier})`}
            stroke="var(--panel)"
            strokeWidth={2}
            onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, text: `${p.label} · tier ${p.tier} · hidden power ${p.x.toFixed(2)} · score ${p.y.toFixed(2)}` })}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </svg>
      <div className="row small" aria-label="Legend">
        {TIERS.map((t) => (
          <span key={t} className="row" style={{ gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: `var(--tier-${t})`, display: "inline-block" }} />
            Tier {t}
          </span>
        ))}
      </div>
      <TipBox tip={tip} />
    </>
  );
}
