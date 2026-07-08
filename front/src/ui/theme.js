// ════════════════════════════════════════════════════════════════════════════
// ui/theme.js — IDEA-23: dark/light theme toggle.
//
// Session-only: the starting theme comes from prefers-color-scheme; the
// toggle button flips it in memory only (State.theme / <html data-theme>)
// — nothing is written to localStorage, so a reload goes back to
// prefers-color-scheme instead of remembering the last click. This has to
// run from here (main.js's init(), called on DOMContentLoaded) rather than
// an inline <head> script — the page's Content-Security-Policy is
// script-src 'self' https://unpkg.com with no 'unsafe-inline', so an inline
// script is simply never executed (silently blocked, no console throw to
// even notice). init() calls setupThemeToggle() first, before any other
// setup, to keep the unstyled/wrong-theme window as short as possible.
// COLOR/ROLE_STYLE (state.js) read the resulting CSS custom properties
// live, so vis-adapter's node/edge colours follow automatically on the
// *next* graph build; for a graph already on screen we also force a
// recolor pass here, otherwise already-drawn nodes/edges would keep the old
// theme's baked-in colours until the next search/expand.
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { refreshNodeDimBorders } from "../graph.js";
import { invalidateColorCache, refreshNetwork } from "../vis-adapter/index.js";

function applyThemeToButton(theme) {
  if (!els.themeToggle) return;
  const isLight = theme === "light";
  els.themeToggle.setAttribute("aria-pressed", String(isLight));
  els.themeToggle.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
  const use = els.themeToggle.querySelector("use");
  if (use) use.setAttribute("href", isLight ? "#icon-moon" : "#icon-sun");
}

// A graph already drawn has its node/edge colours baked into vis.js's
// DataSet — flipping the CSS variables alone won't repaint it. Reuses the
// same recolor path finalizeGraphState() takes after a role/graph change
// (refreshNodeDimBorders → invalidateColorCache → refreshNetwork) instead of
// duplicating that sequence.
function recolorRenderedGraph() {
  if (!State.network || !State.graphNodes.length) return;
  refreshNodeDimBorders();
  invalidateColorCache();
  const nameById = {};
  State.graphNodes.forEach(n => { nameById[n.id] = n.name; });
  refreshNetwork(nameById, State.network.getPositions());
}

export function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  State.theme = theme;
  applyThemeToButton(theme);
  recolorRenderedGraph();
}

export function setupThemeToggle() {
  const prefersLight = window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  const initial = prefersLight ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", initial);
  State.theme = initial;
  applyThemeToButton(initial);

  els.themeToggle?.addEventListener("click", () => {
    setTheme(State.theme === "light" ? "dark" : "light");
  });
}