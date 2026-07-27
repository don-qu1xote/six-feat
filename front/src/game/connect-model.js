function norm(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim();
}

function eq(a, b) {
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

export function createConnectChain(startName, goalName) {
  const start = norm(startName);
  return {
    start,
    goal: norm(goalName),
    nodes: [{ name: start, parent: null }],
    focus: start,
    completed: false,
    gaveUp: false,
    startedAt: Date.now(),
    finishedAt: null,
    challengeId: null,
    result: null,
    leaderboard: null,
  };
}

function findNode(game, name) {
  return game.nodes.find((n) => eq(n.name, name)) || null;
}

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

export function chainNodes(game) {
  return pathTo(game, game.focus);
}

export function webNodes(game) {
  return game.nodes.map((n) => n.name);
}

export function webEdges(game) {
  return game.nodes.filter((n) => n.parent).map((n) => ({ from: n.parent, to: n.name }));
}

export function winningPath(game) {
  return game.completed ? pathTo(game, game.goal) : null;
}

export function focusName(game) {
  return game.focus;
}

export function setFocus(game, rawName) {
  if (game.completed || game.gaveUp) return { ok: false };
  const node = findNode(game, rawName);
  if (!node) return { ok: false };
  game.focus = node.name;
  return { ok: true };
}

export function hopCount(game) {
  return Math.max(0, chainNodes(game).length - 1);
}

export function isComplete(game) {
  return game.completed === true;
}

export function webSize(game) {
  return Math.max(0, game.nodes.length - 1);
}

export function giveUp(game) {
  if (game.completed || game.gaveUp) return;
  game.gaveUp = true;
  game.finishedAt = Date.now();
}

export function pathRevealed(game) {
  return game.completed === true || game.gaveUp === true;
}

export function elapsedMs(game) {
  return (game.finishedAt || Date.now()) - game.startedAt;
}

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

export function undoHop(game) {
  if (game.completed) {
    const goalNode = findNode(game, game.goal);
    const parent = goalNode && goalNode.parent ? goalNode.parent : game.start;
    game.nodes = game.nodes.filter((n) => !eq(n.name, game.goal));
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

export function applyLeaderboard(game, leaderboardResponse) {
  game.leaderboard = normalizeLeaderboard(leaderboardResponse);
}

export function clearLeaderboard(game) {
  game.leaderboard = null;
}

function normalizeLeaderboard(r) {
  if (!r || typeof r !== "object" || !Array.isArray(r.entries)) return null;
  return {
    entries: r.entries.map((e) => ({
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
