// ════════════════════════════════════════════════════════════════════════════
// game/connect-model.js — [SF-GAME-01] Pure chain model for "Connect" mode.
//
// The Connect game: the player is given a fixed start and goal artist and
// builds a collaboration chain between them by entering intermediate artists
// one at a time, WITHOUT seeing our own ideal path. This module is only the
// data model of that chain — no DOM, no network, no validation/scoring
// (those are separate, backend-gated tickets: SF-GAME-14 server-side
// anti-cheat validation, SF-GAME-15 scoring/ELO). Keeping the model pure and
// framework-free is what lets the whole "build a chain" mechanic be unit-
// tested without a canvas, a running game-service, or a real mousemove.
//
// A chain is `{ start, goal, hops, completed }`:
//   - start / goal   — the two fixed endpoints (normalized artist names).
//   - hops           — ordered intermediate artist names the player added,
//                      EXCLUDING the goal (the goal is always the endpoint,
//                      never stored as a hop — see addHop's goal branch).
//   - completed      — the player connected the last hop to the goal.
// The full visible chain is always [start, ...hops, goal] (chainNodes) so the
// goal shows as the target endpoint whether or not it's been reached yet.
//
// Artist identity here is by NAME, not id: SF-GAME-01 has no backend, and the
// autocomplete (ui/autocomplete.js) hands back a name string on select — so
// the model honestly keys on the same thing the UI actually has. Genius-id
// resolution + real hop validation arrive with SF-GAME-13/14.
// ════════════════════════════════════════════════════════════════════════════

// Collapse surrounding/inner whitespace and drop empties — the same light
// touch the search input already tolerates, so "  Drake " and "Drake" are one
// artist. Case is preserved for display but compared case-insensitively (eq).
function norm(name) {
  return String(name || "").replace(/\s+/g, " ").trim();
}

function eq(a, b) {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

export function createConnectChain(startName, goalName) {
  return { start: norm(startName), goal: norm(goalName), hops: [], completed: false };
}

// The full visible chain, endpoints included: [start, ...hops, goal].
export function chainNodes(game) {
  return [game.start, ...game.hops, game.goal];
}

export function hopCount(game) {
  return game.hops.length;
}

export function isComplete(game) {
  return game.completed === true;
}

// Adds an intermediate artist to the chain. Returns { ok, reason?, completed }.
//   - empty/whitespace name         → rejected ("empty")
//   - same as the current tail node → rejected ("duplicate"): a self-loop
//     A→A is never a real collaboration hop, and the one guard that's true
//     without any backend (you can't collaborate with yourself in the same
//     step). The tail is the last hop, or the start if there are no hops yet.
//   - equals the goal               → does NOT push a hop (the goal is the
//     endpoint, not an intermediate); marks the chain completed instead.
//   - anything else                 → appended as the newest hop.
// Adding to an already-completed chain is a no-op ("completed") — undo first.
export function addHop(game, rawName) {
  if (game.completed) return { ok: false, reason: "completed" };
  const name = norm(rawName);
  if (!name) return { ok: false, reason: "empty" };

  const tail = game.hops.length ? game.hops[game.hops.length - 1] : game.start;
  if (eq(name, tail)) return { ok: false, reason: "duplicate" };

  if (eq(name, game.goal)) {
    game.completed = true;
    return { ok: true, completed: true };
  }

  game.hops.push(name);
  return { ok: true, completed: false };
}

// Removes the most recent step. If the chain was completed, the first undo
// re-opens it (drops the goal connection) without touching hops; otherwise it
// pops the last hop. Returns what was undone (the goal sentinel "goal",
// a hop name, or null when there was nothing to undo).
export function undoHop(game) {
  if (game.completed) {
    game.completed = false;
    return { undone: "goal" };
  }
  const popped = game.hops.length ? game.hops.pop() : null;
  return { undone: popped };
}

// Clears every intermediate + the completion flag, keeping the two fixed
// endpoints — "start over on the same challenge", not "pick new artists".
export function resetChain(game) {
  game.hops = [];
  game.completed = false;
}
