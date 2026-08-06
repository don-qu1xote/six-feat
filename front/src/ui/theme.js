import { State } from "../state/state.js";
import { refreshNodeDimBorders } from "../graph.js";
import { invalidateColorCache, recolorInPlace } from "../vis-adapter/index.js";

export const THEME_STORAGE_KEY = "six-feat-theme";

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

function storedTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : null;
  } catch {
    return null;
  }
}

export function setTheme(theme, { persist = true } = {}) {
  document.documentElement.setAttribute("data-theme", theme);
  State.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {}
  }
  recolorRenderedGraph();
}

export function initTheme() {
  const saved = storedTheme();
  const prefersLight =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  const initial = saved || (prefersLight ? "light" : "dark");
  setTheme(initial, { persist: false });
}
