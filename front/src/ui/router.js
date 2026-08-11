import { State } from "../state/state.js";

export const SURFACE_GRAPH = "graph";
export const SURFACE_GAME = "game";
export const SURFACE_GAME_LEADERBOARD = "game/leaderboard";
export const SURFACE_GAME_PROFILE = "game/profile";
export const SURFACE_GAME_CHALLENGES = "game/challenges";
export const SURFACE_GAME_SEASON = "game/season";
const SURFACES = new Set([
  SURFACE_GRAPH,
  SURFACE_GAME,
  SURFACE_GAME_LEADERBOARD,
  SURFACE_GAME_PROFILE,
  SURFACE_GAME_CHALLENGES,
  SURFACE_GAME_SEASON,
]);
export const DEFAULT_SURFACE = SURFACE_GRAPH;

export function isGameSurface(surface) {
  return surface === SURFACE_GAME || String(surface || "").startsWith("game/");
}

const listeners = new Set();

export function parseSurfaceFromHash(hash) {
  const raw = String(hash || "")
    .replace(/^#\/?/, "")
    .trim();
  return SURFACES.has(raw) ? raw : DEFAULT_SURFACE;
}

export function getCurrentSurface() {
  return parseSurfaceFromHash(window.location.hash);
}

export function onSurfaceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setSurface(surface) {
  State.surface = surface;
  listeners.forEach((fn) => fn(surface));
}

export function navigateToSurface(surface, { replace = false } = {}) {
  const target = SURFACES.has(surface) ? surface : DEFAULT_SURFACE;
  const url = new URL(window.location.href);
  url.hash = `#/${target}`;
  history[replace ? "replaceState" : "pushState"]({ surface: target }, "", url.toString());
  setSurface(target);
  return target;
}

export function restoreSurfaceFromUrl() {
  const raw = String(window.location.hash || "")
    .replace(/^#\/?/, "")
    .trim();
  return navigateToSurface(raw, { replace: true });
}

window.addEventListener("popstate", () => setSurface(getCurrentSurface()));
window.addEventListener("hashchange", () => setSurface(getCurrentSurface()));
