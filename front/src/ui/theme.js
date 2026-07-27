import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { refreshNodeDimBorders } from "../graph.js";
import { invalidateColorCache, recolorInPlace } from "../vis-adapter/index.js";

function applyThemeToButton(theme) {
  if (!els.themeToggle) return;
  const isLight = theme === "light";
  els.themeToggle.setAttribute("aria-pressed", String(isLight));
  els.themeToggle.setAttribute(
    "aria-label",
    isLight ? "Switch to dark theme" : "Switch to light theme",
  );
  const use = els.themeToggle.querySelector("use");
  if (use) use.setAttribute("href", isLight ? "#icon-moon" : "#icon-sun");
}

function recolorRenderedGraph() {
  if (!State.network || !State.graphNodes.length) return;
  refreshNodeDimBorders();
  invalidateColorCache();
  const nameById = {};
  State.graphNodes.forEach((n) => {
    nameById[n.id] = n.name;
  });
  recolorInPlace(nameById);
}

export function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  State.theme = theme;
  applyThemeToButton(theme);
  recolorRenderedGraph();
}

export function setupThemeToggle() {
  const prefersLight =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  const initial = prefersLight ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", initial);
  State.theme = initial;
  applyThemeToButton(initial);

  els.themeToggle?.addEventListener("click", () => {
    setTheme(State.theme === "light" ? "dark" : "light");
  });
}
