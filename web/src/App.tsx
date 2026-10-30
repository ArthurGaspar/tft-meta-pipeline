import { useEffect, useState } from "react";
import { Lobby } from "./Lobby";
import { PatchChanges } from "./PatchChanges";
import { Simulator } from "./Simulator";
import { Pipeline } from "./Pipeline";
import { TierLists } from "./TierLists";
import { Truth } from "./Truth";

type Theme = "system" | "light" | "dark";

const PAGES = [
  { hash: "#/", label: "Tier lists" },
  { hash: "#/patch", label: "Patch changes" },
  { hash: "#/lobby", label: "Lobby dynamics" },
  { hash: "#/simulator", label: "Simulator" },
  { hash: "#/pipeline", label: "Pipeline" },
  { hash: "#/truth", label: "Truth check" },
];

export function App() {
  const [hash, setHash] = useState(location.hash || "#/");
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("tft-theme") as Theme) || "system";
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    const on = () => {
      setHash(location.hash || "#/");
      window.scrollTo(0, 0);
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

  const page = PAGES.some((p) => p.hash === hash) ? hash : "#/";

  return (
    <>
      <header className="top">
        <a className="brand" href="#/">
          <b>TFT Meta Pipeline</b>
          <span>tier lists from a serverless-style ETL</span>
        </a>
        <nav>
          {PAGES.map((p) => (
            <a key={p.hash} href={p.hash} aria-current={page === p.hash ? "page" : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <button className="theme" onClick={() => setTheme((t) => (t === "system" ? "light" : t === "light" ? "dark" : "system"))} aria-label={`Theme: ${theme}`}>
          {theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark"}
        </button>
      </header>
      <main>
        {page === "#/" && <TierLists />}
        {page === "#/patch" && <PatchChanges />}
        {page === "#/lobby" && <Lobby />}
        {page === "#/simulator" && <Simulator />}
        {page === "#/pipeline" && <Pipeline />}
        {page === "#/truth" && <Truth />}
      </main>
    </>
  );
}
