import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Overview } from "./Overview";

const TierLists = lazy(() => import("./TierLists").then((m) => ({ default: m.TierLists })));
const PatchChanges = lazy(() => import("./PatchChanges").then((m) => ({ default: m.PatchChanges })));
const Lobby = lazy(() => import("./Lobby").then((m) => ({ default: m.Lobby })));
const Simulator = lazy(() => import("./Simulator").then((m) => ({ default: m.Simulator })));
const Pipeline = lazy(() => import("./Pipeline").then((m) => ({ default: m.Pipeline })));
const Truth = lazy(() => import("./Truth").then((m) => ({ default: m.Truth })));

type Theme = "system" | "light" | "dark";

const PAGES = [
  { hash: "#/", label: "Home", component: Overview },
  { hash: "#/tiers", label: "Tier lists", component: TierLists },
  { hash: "#/patch", label: "Patch changes", component: PatchChanges },
  { hash: "#/lobby", label: "Lobby dynamics", component: Lobby },
  { hash: "#/simulator", label: "Simulator", component: Simulator },
  { hash: "#/pipeline", label: "Pipeline", component: Pipeline },
  { hash: "#/truth", label: "Truth check", component: Truth },
];

export function App() {
  const [hash, setHash] = useState(location.hash || "#/");
  const main = useRef<HTMLElement>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("tft-theme");
      return saved === "light" || saved === "dark" || saved === "system" ? saved : "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    const on = () => {
      setHash(location.hash || "#/");
      window.scrollTo(0, 0);
      main.current?.focus();
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("tft-theme", theme);
    } catch {
      // storage can be unavailable; the theme still applies for this visit
    }
  }, [theme]);

  const page = PAGES.find((p) => p.hash === hash) ?? PAGES[0];
  const Page = page.component;

  useEffect(() => {
    document.title = `${page.label} · TFT Meta Pipeline · Arthur`;
  }, [page]);

  return (
    <>
      <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); main.current?.focus(); }}>Skip to content</a>
      <header className="top">
        <a className="brand" href="#/">
          <svg className="brand-mark" viewBox="0 0 44 44" aria-hidden="true">
            <path d="m22 2 18 10v20L22 42 4 32V12Z" fill="#6650b7" stroke="#c1a4ff" strokeWidth="2" />
            <path d="m22 9 4 9 10 4-10 4-4 10-4-10-10-4 10-4Z" fill="#ffe09a" />
            <path d="m35 4 2 4 5 1-5 2-2 4-1-4-5-2 5-1Z" fill="#65e2cf" />
          </svg>
          <span className="brand-text"><b>TFT Meta Pipeline</b><span>Arthur’s corner of TFT</span></span>
        </a>
        <nav aria-label="Project">
          {PAGES.map((p) => (
            <a key={p.hash} href={p.hash} aria-current={page.hash === p.hash ? "page" : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <button className="theme" onClick={() => setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"))} aria-label={`Theme: ${theme}`}>
          {theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark"}
        </button>
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        <Suspense fallback={<p role="status">Loading section…</p>}>
          <Page />
        </Suspense>
      </main>
      <footer className="site-footer">
        <span>Made by Arthur <span className="footer-separator">✦</span> A TFT side project</span>
        <span>Game art via Community Dragon · Unofficial fan project <a href="https://github.com/ArthurGaspar/tft-meta-pipeline">GitHub ↗</a></span>
      </footer>
    </>
  );
}
