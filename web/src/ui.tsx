import { useEffect, useState, type ReactNode } from "react";
import type { Tier } from "./data";

/** Runs `load` when `deps` change. `load` is a new closure on every render, so it isn't a dependency itself. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ data, error: null }),
      (err) => live && setState({ data: null, error: String(err.message ?? err) }),
    );
    return () => {
      live = false;
    };
  }, deps);
  return state;
}

export function Tile({ value, label, sub }: { value: ReactNode; label: string; sub?: ReactNode }) {
  return (
    <div className="tile">
      <div className="v">{value}</div>
      <div className="l">{label}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

export function Icon({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="ph" aria-hidden="true">{name.slice(0, 2)}</span>;
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span className="tier-badge" style={{ background: `var(--tier-${tier})`, color: `var(--tier-ink-${tier})` }}>
      {tier}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h1>{title}</h1>
      {children && <p style={{ margin: "0 auto" }}>{children}</p>}
    </div>
  );
}

export const fmt = {
  pct: (x: number, d = 0) => `${(x * 100).toFixed(d)}%`,
  place: (x: number) => x.toFixed(2),
  int: (x: number) => x.toLocaleString("en-US"),
};
