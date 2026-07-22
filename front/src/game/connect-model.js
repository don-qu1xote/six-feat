// ════════════════════════════════════════════════════════════════════════════
// game/connect-model.js — [design: ветвящийся веб] Branching web model for
// "Connect" mode.
//
// The player is given a fixed start and goal artist and grows a WEB of
// collaborators between them — not a single line. Every artist they add
// attaches to a `parent` node already in the web (a tree rooted at `start`),
// and they can move the `focus` to ANY node and branch off it, running
// several routes toward the goal at once. The round is won the moment the
// goal joins the web (from any node); scoring uses the winning line — the
// start→goal path through the tree (winningPath).
//
// This module is only the data model — no DOM, no network — so the mechanic
// is unit-testable without a canvas or a running game service.
//
// A game is `{ start, goal, nodes, focus, completed, gaveUp, startedAt,
// finishedAt, challengeId, result, leaderboard }`:
//   - start / goal   — the two fixed endpoints (normalized artist names).
//   - nodes          — the web as a flat list of { name, parent } (start is
//                      the root, parent null). Edges are each node→parent.
//   - focus          — the node the next add attaches to (click any node to
//                      move it and branch from there). Typing keeps chaining
//                      linearly because a successful add moves focus onto the
//                      new node.
//   - completed      — the goal has joined the web.
//   - gaveUp         — the player explicitly gave up before completing.
//   - startedAt/finishedAt — see elapsedMs below (the right-hand timer).
//   - challengeId    — the numeric id POST /api/v1/game/challenge handed
//                      back for this (start, goal) pair — set once by
//                      connect.js; submit needs it, this model just carries it.
//   - result         — the server's last POST /api/v1/game/submit response
//                      for this game, or null before any submit. The ideal
//                      (optimal_path) never enters this model any other way,
//                      so "hidden until submit" is structural.
//   - leaderboard    — the server's last GET /api/v1/game/leaderboard
//                      response, or null until one has been shown.
//
// Artist identity here is by NAME for the web shape itself — numeric Genius
// ids (needed for the real network calls) are kept separately by connect.js
// (setId/idFor), the same "presentation/network detail, not shape" split
// photos already use there.
// ════════════════════════════════════════════════════════════════════════════

function norm(name) {
  return String(name || "").replace(/\s+/g, " ").trim();
}

function eq(a, b) {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

export function createConnectChain(startName, goalName) {
  const start = norm(startName);
  return {
    start, goal: norm(goalName),
    nodes: [{ name: start, parent: null }],
    focus: start,
    completed: false, gaveUp: false,
    startedAt: Date.now(), finishedAt: null,
    challengeId: null, result: null, leaderboard: null,
  };
}

function findNode(game, name) {
  return game.nodes.find(n => eq(n.name, name)) || null;
}

// The start→name path by walking parents up to the root. `name` must be in
// the web. Cycle-guarded (a well-formed tree never has one, but never loop).
function pathTo(game, name) {
  const out = [];
  const seen = new Set();
  let cur = findNode(game, name);
  while (cur && !seen.has(cur.name.toLowerCase())) {
    seen.add(cur.name.toLowerCase());
    out.unshift(cur.name);
    cur = cur.parent ? findNode(game, cur.parent) : null;
  }
  return out;
}

// [compat] "The current line" — the branch from start to the focused node.
// The panel's "Your line" renders this; completing focuses the goal, so it
// becomes the winning line then.
export function chainNodes(game) {
  return pathTo(game, game.focus);
}

// Every artist in the web (for the graph).
export function webNodes(game) {
  return game.nodes.map(n => n.name);
}

// Every built edge as { from: parent, to: child } (for the graph).
export function webEdges(game) {
  return game.nodes.filter(n => n.parent).map(n => ({ from: n.parent, to: n.name }));
}

// The start→goal path once the goal has joined the web, else null — the
// winning line, and exactly what gets submitted for scoring.
export function winningPath(game) {
  return game.completed ? pathTo(game, game.goal) : null;
}

export function focusName(game) {
  return game.focus;
}

// Move the focus (branch point) to any node already in the web. No-op once
// the round is over or if the name isn't in the web.
export function setFocus(game, rawName) {
  if (game.completed || game.gaveUp) return { ok: false };
  const node = findNode(game, rawName);
  if (!node) return { ok: false };
  game.focus = node.name;
  return { ok: true };
}

// Hops along the current line (start→focus), i.e. the winning line once
// complete. The "N hops" badge reads "your line so far", not "nodes built".
export function hopCount(game) {
  return Math.max(0, chainNodes(game).length - 1);
}

export function isComplete(game) {
  return game.completed === true;
}

// Total artists the player has added (start excluded) — "web size".
export function webSize(game) {
  return Math.max(0, game.nodes.length - 1);
}

// [design: path hidden until victory] Marks the round done without claiming
// the goal was reached. No-op once already complete or given up.
export function giveUp(game) {
  if (game.completed || game.gaveUp) return;
  game.gaveUp = true;
  game.finishedAt = Date.now();
}

export function pathRevealed(game) {
  return game.completed === true || game.gaveUp === true;
}

// Milliseconds since the game was created, frozen at game.finishedAt once
// the round is over — a live read (not a stored value).
export function elapsedMs(game) {
  return (game.finishedAt || Date.now()) - game.startedAt;
}

// Attaches an artist to the web as a child of the current focus. Returns
// { ok, reason?, completed }.
//   - empty/whitespace name        → rejected ("empty")
//   - same as the focused node     → rejected ("duplicate")
//   - already elsewhere in the web → rejected ("exists"): re-focus it to
//                                     branch, don't clone it.
//   - equals the goal              → joins the web under focus, marks complete.
//   - anything else                → new node under focus; focus moves onto it
//                                     (so typing keeps chaining linearly).
// Adding to an already-completed or given-up web is a no-op.
export function addHop(game, rawName) {
  if (game.completed || game.gaveUp) return { ok: false, reason: "over" };
  const name = norm(rawName);
  if (!name) return { ok: false, reason: "empty" };
  if (eq(name, game.focus)) return { ok: false, reason: "duplicate" };

  if (eq(name, game.goal)) {
    if (!findNode(game, game.goal)) game.nodes.push({ name: game.goal, parent: game.focus });
    game.completed = true;
    game.finishedAt = Date.now();
    game.focus = game.goal;
    return { ok: true, completed: true };
  }

  if (findNode(game, name)) return { ok: false, reason: "exists" };

  game.nodes.push({ name, parent: game.focus });
  game.focus = name;
  return { ok: true, completed: false };
}

// Undo the last action. A completed round reopens (drops the goal node,
// focuses its parent, resumes the clock). Otherwise removes the
// most-recently-added node (always a leaf — adds only ever append) and
// focuses its parent.
export function undoHop(game) {
  if (game.completed) {
    const goalNode = findNode(game, game.goal);
    const parent = goalNode && goalNode.parent ? goalNode.parent : game.start;
    game.nodes = game.nodes.filter(n => !eq(n.name, game.goal));
    game.completed = false;
    game.finishedAt = null;
    game.focus = parent;
    return { undone: "goal" };
  }
  if (game.nodes.length <= 1) return { undone: null };
  const last = game.nodes[game.nodes.length - 1];
  game.nodes = game.nodes.slice(0, -1);
  game.focus = last.parent || game.start;
  return { undone: last.name };
}

// Clears the whole web back to just the start, refocuses it and restarts the
// clock — same challenge, fresh attempt.
export function resetChain(game) {
  game.nodes = [{ name: game.start, parent: null }];
  game.focus = game.start;
  game.completed = false;
  game.gaveUp = false;
  game.startedAt = Date.now();
  game.finishedAt = null;
  game.result = null;
  game.leaderboard = null;
}

export function setChallengeId(game, id) {
  game.challengeId = id;
}

// ── Result (SF-GAME-15/03) ──────────────────────────────────────────────
export function applyResult(game, submitResponse) {
  game.result = normalizeResult(submitResponse);
}

export function clearResult(game) {
  game.result = null;
}

function normalizeResult(r) {
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
    playerLen: r.player_len,
    optimalLen: r.optimal_len,
    optimalPath: Array.isArray(r.optimal_path) ? [...r.optimal_path] : [],
    score: r.score,
    maxScore: r.max_score,
    eloBefore: r.elo_before,
    eloAfter: r.elo_after,
    eloDelta: r.elo_delta,
  };
}

export function resultView(game) {
  return game.result;
}

// ── Leaderboard (SF-GAME-17/04) ─────────────────────────────────────────
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

export function leaderboardView(game) {
  return game.leaderboard;
}
