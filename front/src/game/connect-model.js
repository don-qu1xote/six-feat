// ════════════════════════════════════════════════════════════════════════════
// game/connect-model.js — [SF-GAME-01] Pure chain model for "Connect" mode.
//
// The Connect game: the player is given a fixed start and goal artist and
// builds a collaboration chain between them by entering intermediate artists
// one at a time, WITHOUT seeing our own ideal path. This module is only the
// data model of that chain — no DOM, no network. Still no scoring (SF-GAME-15,
// ELO). Keeping the model pure and framework-free is what lets the whole
// "build a chain" mechanic be unit-tested without a canvas, a running
// game-service, or a real mousemove.
//
// A chain is `{ start, goal, hops, completed, validation, result }`:
//   - start / goal   — the two fixed endpoints (normalized artist names).
//   - hops           — ordered intermediate artist names the player added,
//                      EXCLUDING the goal (the goal is always the endpoint,
//                      never stored as a hop — see addHop's goal branch).
//   - completed      — the player connected the last hop to the goal.
//   - validation     — [SF-GAME-14/02] the server's last verdict on this
//                      EXACT chain, or null if it hasn't been checked (or was
//                      edited since) — see applyValidation/hopStatuses below.
//   - result         — [SF-GAME-15/03] the server's last POST
//                      /api/v1/game/submit response for this EXACT chain, or
//                      null before any submit — see applyResult/resultView
//                      below. The ideal (optimal_path) never enters this
//                      model any other way, so "hidden until submit" is
//                      structural, not a flag someone could forget to check.
//   - leaderboard    — [SF-GAME-17/04] the server's last GET
//                      /api/v1/game/leaderboard response for this challenge,
//                      or null until one has been shown — see
//                      applyLeaderboard/leaderboardView below. Only ever
//                      populated after a submit reveals a result (same
//                      "after finish" gate as result itself), never fetched
//                      by this module on its own.
// The full visible chain is always [start, ...hops, goal] (chainNodes) so the
// goal shows as the target endpoint whether or not it's been reached yet.
//
// Artist identity here is by NAME, not id: SF-GAME-01 has no backend, and the
// autocomplete (ui/autocomplete.js) hands back a name string on select — so
// the model honestly keys on the same thing the UI actually has. The server
// validator/submit endpoints (SF-GAME-14/15) need numeric Genius ids, which
// this model still doesn't carry — wiring the real network calls is blocked
// on that id-resolution gap, left to whichever ticket adds it.
// applyValidation/hopStatuses and applyResult/resultView below only render
// an already-computed server response; none of them fetch one.
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
  return {
    start: norm(startName), goal: norm(goalName), hops: [],
    completed: false, validation: null, result: null, leaderboard: null,
  };
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
    game.validation = null;
    game.result = null;
    game.leaderboard = null;
    return { ok: true, completed: true };
  }

  game.hops.push(name);
  game.validation = null;
  game.result = null;
  game.leaderboard = null;
  return { ok: true, completed: false };
}

// Removes the most recent step. If the chain was completed, the first undo
// re-opens it (drops the goal connection) without touching hops; otherwise it
// pops the last hop. Returns what was undone (the goal sentinel "goal",
// a hop name, or null when there was nothing to undo).
export function undoHop(game) {
  game.validation = null;
  game.result = null;
  game.leaderboard = null;
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
  game.validation = null;
  game.result = null;
  game.leaderboard = null;
}

// ── Server validation (SF-GAME-14/02) ───────────────────────────────────────
//
// The server (POST /api/v1/game/validate, services/game/chain_validator.hpp)
// is the only authority on whether a chain's hops are real collaborations —
// this module never re-derives that verdict locally, and never looks at any
// "valid"-shaped field a caller might pass in besides the server's own
// response. applyValidation just stores that response shape on the chain
// ({valid:true} | {valid:false, reason:"endpoint_mismatch"} |
// {valid:false, reason:"invalid_hop", invalid_hop_index}) so the UI can
// render it. Every mutating call above (addHop on success, undoHop,
// resetChain) clears it: a verdict computed against a chain that no longer
// exists is actively misleading, not just stale.

export function applyValidation(game, result) {
  game.validation = normalizeValidation(result);
}

export function clearValidation(game) {
  game.validation = null;
}

function normalizeValidation(result) {
  if (!result || typeof result !== "object") return null;
  if (result.valid === true) return { valid: true, reason: null, invalidHopIndex: null };
  if (result.reason === "invalid_hop" && Number.isInteger(result.invalid_hop_index)) {
    return { valid: false, reason: "invalid_hop", invalidHopIndex: result.invalid_hop_index };
  }
  return { valid: false, reason: result.reason || "unknown", invalidHopIndex: null };
}

// Per-transition status for chainNodes(game) — one entry per edge
// a_i -> a_{i+1}, so length is chainNodes(game).length - 1:
//   "valid"   — confirmed real (at or before the first break, or the whole
//               chain came back valid)
//   "invalid" — the first transition the server rejected
//   "unknown" — no check has run yet, or this transition is past the first
//               break (chain_validator.hpp never checks past it, so there is
//               genuinely nothing to report here yet)
export function hopStatuses(game) {
  const n = chainNodes(game).length - 1;
  if (n <= 0) return [];
  const v = game.validation;
  if (!v) return new Array(n).fill("unknown");
  if (v.valid) return new Array(n).fill("valid");
  if (v.reason === "invalid_hop" && v.invalidHopIndex != null) {
    return Array.from({ length: n }, (_, i) =>
      i < v.invalidHopIndex ? "valid" : i === v.invalidHopIndex ? "invalid" : "unknown");
  }
  return new Array(n).fill("unknown");
}

// ── Result screen (SF-GAME-15/03) ───────────────────────────────────────────
//
// POST /api/v1/game/submit (services/game/submit_handler.cpp) is the ONLY
// place the ideal path is ever sent to the client — every field below comes
// straight from that one response, stored as-is by applyResult. There is no
// separate "peek at the ideal" call anywhere in this codebase for this
// module to accidentally expose early: resultView() returns null (nothing
// to show) until applyResult() has actually been called with a real
// {valid:true, ...} response, which — per submit_handler.hpp's own
// contract — can only happen after the player has finished (or failed) an
// attempt.

export function applyResult(game, submitResponse) {
  game.result = normalizeResult(game, submitResponse);
}

export function clearResult(game) {
  game.result = null;
}

function normalizeResult(game, r) {
  if (!r || typeof r !== "object") return null;
  if (r.valid !== true) {
    return {
      revealed: false,
      reason: r.reason || "unknown",
      invalidHopIndex: Number.isInteger(r.invalid_hop_index) ? r.invalid_hop_index : null,
    };
  }
  return {
    revealed: true,
    playerChain: chainNodes(game),
    playerLen: r.player_len,
    optimalPath: Array.isArray(r.optimal_path) ? [...r.optimal_path] : [],
    optimalLen: r.optimal_len,
    score: r.score,
    maxScore: r.max_score,
    eloBefore: r.elo_before,
    eloAfter: r.elo_after,
    eloDelta: r.elo_delta,
  };
}

// The stored result view, or null if nothing has been submitted yet (or the
// chain was edited since — see the *_result clearing in addHop/undoHop/
// resetChain above). Pass-through accessor kept alongside hopStatuses() for
// symmetry — game.result is already the normalized view, but callers
// shouldn't need to know that.
export function resultView(game) {
  return game.result;
}

// ── Leaderboard (SF-GAME-17/04) ─────────────────────────────────────────────
//
// GET /api/v1/game/leaderboard?challenge_id=… (services/game/
// leaderboard_handler.cpp) is the source for this — applyLeaderboard just
// stores that response shape ({entries:[{user_id, display_name, score,
// hops, ts}], next_cursor}) so the UI can render "the challenge's
// leaderboard" right after a result is shown. Like validation/result, every
// mutating call above clears it: a leaderboard snapshot fetched for a chain
// that's since been edited is stale, not just unlabeled.

export function applyLeaderboard(game, leaderboardResponse) {
  game.leaderboard = normalizeLeaderboard(leaderboardResponse);
}

export function clearLeaderboard(game) {
  game.leaderboard = null;
}

function normalizeLeaderboard(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.entries)) return null;
  return {
    entries: r.entries.map(e => ({
      userId: e.user_id,
      displayName: String(e.display_name || ""),
      score: e.score,
      hops: e.hops,
      ts: e.ts,
    })),
    nextCursor: typeof r.next_cursor === "string" ? r.next_cursor : null,
  };
}

// The stored leaderboard view, or null if none has been shown yet (or the
// chain was edited since — see the *_leaderboard clearing in addHop/undoHop/
// resetChain above).
export function leaderboardView(game) {
  return game.leaderboard;
}
