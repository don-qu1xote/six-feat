// ════════════════════════════════════════════════════════════════════════════
// ui/router.js — [SF-WEB-25] Minimal client-side routing.
//
// The front-end is still one page: which "surface" is active (the graph
// explorer, and — not built yet — a game mode) is state, not a route in the
// SPA-framework sense. This is just an explicit, URL-addressable name for
// that state, ahead of the game surface actually landing (§ SF-WEB-25's own
// framing: "перед вводом отдельного игрового режима").
//
// A thin wrapper over the History API's hash — no router library. Reuses
// history.js's existing query-string state encoding (updateShareableUrl/
// loadArtistFromUrl) unchanged: this module only ever touches
// window.location.hash, never .search, so the two compose for free — e.g.
// updateShareableUrl's `new URL(window.location.href)` + reassigning just
// `.search` naturally carries whatever hash this module last set straight
// through to its own history.replaceState call.
//
// Current graph behavior is unchanged: "graph" is the default surface, and
// is what a missing or unrecognized hash resolves to (exactly the same
// no-hash-at-all behavior the app had before this ticket).
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";

export const SURFACE_GRAPH = "graph";
export const SURFACE_GAME  = "game";
// [design: routed game windows] The game is no longer one screen — Play,
// Leaderboard and Profile are sibling routed surfaces under #/game/*, the
// same URL-addressable-state model SURFACE_GAME already established (a
// hashchange/popstate swaps which one shows). Each is a plain hash any
// <a href> can link to (see game/game-shell.js's nav).
export const SURFACE_GAME_LEADERBOARD = "game/leaderboard";
export const SURFACE_GAME_PROFILE     = "game/profile";
export const SURFACE_GAME_CHALLENGES  = "game/challenges";
export const SURFACE_GAME_SEASON      = "game/season";
const SURFACES = new Set([
  SURFACE_GRAPH, SURFACE_GAME,
  SURFACE_GAME_LEADERBOARD, SURFACE_GAME_PROFILE, SURFACE_GAME_CHALLENGES,
  SURFACE_GAME_SEASON,
]);
export const DEFAULT_SURFACE = SURFACE_GRAPH;

// True for any #/game or #/game/* surface — used by the game shell to stay
// mounted (nav + chrome) across the game's own sub-screens while the graph
// explorer stays hidden.
export function isGameSurface(surface) {
  return surface === SURFACE_GAME || String(surface || "").startsWith("game/");
}

const listeners = new Set();

// Pure: hash string -> surface name. Never throws; anything missing/
// unrecognized quietly falls back to DEFAULT_SURFACE, same "no state" fallback
// shape as history.js's parseGraphState.
export function parseSurfaceFromHash(hash) {
  const raw = String(hash || "").replace(/^#\/?/, "").trim();
  return SURFACES.has(raw) ? raw : DEFAULT_SURFACE;
}

export function getCurrentSurface() {
  return parseSurfaceFromHash(window.location.hash);
}

// Subscribe to surface changes (navigateToSurface calls and browser back/
// forward alike). Returns an unsubscribe function.
export function onSurfaceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setSurface(surface) {
  State.surface = surface;
  listeners.forEach(fn => fn(surface));
}

// Navigates to `surface`, updating the URL hash. Defaults to pushState (a
// surface switch is a top-level navigation a user expects back/forward to
// undo) — pass { replace: true } for restoring state without adding a new
// history entry (e.g. normalizing an invalid hash on load).
export function navigateToSurface(surface, { replace = false } = {}) {
  const target = SURFACES.has(surface) ? surface : DEFAULT_SURFACE;
  const url = new URL(window.location.href);
  url.hash = `#/${target}`;
  history[replace ? "replaceState" : "pushState"]({ surface: target }, "", url.toString());
  setSurface(target);
  return target;
}

// Called once on startup (main.js), before loadArtistFromUrl() — restores
// whichever surface the URL's hash encodes. An invalid/missing hash is
// normalized to the default surface's own hash via replaceState (not left
// bare), so the URL always reflects what's actually showing.
export function restoreSurfaceFromUrl() {
  const raw = String(window.location.hash || "").replace(/^#\/?/, "").trim();
  return navigateToSurface(raw, { replace: true });
}

// Back/forward between surfaces (popstate) AND any direct hash change that
// ISN'T routed through navigateToSurface — a plain `<a href="#/graph">`
// click (e.g. the game surface's own "← Back to graph" link) changes
// window.location.hash and fires "hashchange", but browsers do NOT also
// fire "popstate" for that (popstate is for back/forward traversal only).
// Without this listener the URL updates but State.surface/the visible
// surface never does, so the app looks stuck on whichever surface was
// active before the click.
window.addEventListener("popstate", () => setSurface(getCurrentSurface()));
window.addEventListener("hashchange", () => setSurface(getCurrentSurface()));
