// ════════════════════════════════════════════════════════════════════════════
// game/game-board.js — [design: настоящий граф эксплорера с ограничениями]
//
// The Connect game renders on the REAL graph engine — the SAME State.network on
// #network the Explorer drives, through the SAME replaceGraph() pipeline
// (graph.js → vis-adapter render/physics/visuals/highlight). This is not a
// copy of the graph; it IS the graph, put into a restricted "game mode":
//
//   • RESTRICTED node set — only the player's line + the FOCUSED artist's real
//     collaborators (the dandelion) are ever in the DataSet. No free browsing.
//   • RESTRICTED interaction — while State.graphGameMode is on, the Explorer's
//     click handler (events.js) hands every node click to State.gameClick
//     instead of its own expand/select, so a click is a game move (add a hop /
//     re-focus / reach the goal), never an Explorer expand.
//   • Explorer-only chrome (search rail, compare, bubble-sets, sidebar) is not
//     shown on the game surface.
//
// #network is physically MOVED into the game's graph column while playing and
// moved back to #app-canvas on exit (mountBoard/unmountBoard), so the exact
// same vis.Network instance — same physics, layout, glow, seed-hero, tooltips —
// renders inside the game layout.
//
// Exports mirror the old chain-graph.js surface (renderBoard≈drawChain, zoom,
// fit) plus mount/unmount, so connect.js's call sites barely change.
// ════════════════════════════════════════════════════════════════════════════
import { State, setNodes, setEdges } from "../state/state.js";
import { els } from "../dom/dom.js";
import { replaceGraph } from "../graph.js";
import { webEdges } from "./connect-model.js";

let _cbs = {};
let _byId = new Map();           // numeric id -> { name, kind, neighbour? }
let _homeParent = null;          // where #network lives outside the game
let _ringNet = null;             // network instance our ring hook is attached to
let _lastGame = null;            // for the ring hook to know focus/goal names

function tok(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function rgba(hex, a) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return `rgba(94,230,197,${a})`;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// A stable synthetic id for a name with no resolved artist id yet — negative so
// it can never collide with a real Genius id, deterministic so edges line up.
function synthId(name) {
  let h = 0; const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return -(Math.abs(h) + 1);
}

// ── Mount / unmount: move the real #network into (and out of) the game column ──
export function mountBoard(container) {
  if (!els.network || !container) return;
  if (els.network.parentElement !== container) {
    // Capture where #network lives right now (between games it's always back
    // in #app-canvas) so unmount can return it exactly there.
    _homeParent = els.network.parentElement;
    container.appendChild(els.network);
  }
  State.graphGameMode = true;
  State.gameClick = handleClick;
  // vis autoResize picks up the new box on the next frame; nudge it.
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => { try { State.network && State.network.redraw(); } catch { /* not up yet */ } });
  }
}

export function unmountBoard() {
  State.graphGameMode = false;
  State.gameClick = null;
  // Clear the game graph so the Explorer canvas returns to empty rather than
  // showing the leftover chain when the player heads back to #/graph.
  try {
    if (State.nodesDS) State.nodesDS.clear();
    if (State.edgesDS) State.edgesDS.clear();
  } catch { /* network not up */ }
  setNodes([]);
  setEdges([]);
  _byId = new Map();
  _lastGame = null;
  if (els.network && _homeParent && els.network.parentElement !== _homeParent) {
    _homeParent.appendChild(els.network);
  }
  _homeParent = null;
}

// ── Click routing (called by events.js while in game mode) ────────────────────
function handleClick(params) {
  const id = params?.nodes?.[0];
  if (id == null) return;
  const info = _byId.get(id);
  if (!info) return;
  if (info.kind === "goalTarget") { _cbs.onReachGoal && _cbs.onReachGoal(); return; }
  if (info.kind === "neighbour")  { info.neighbour && _cbs.onPick && _cbs.onPick(info.neighbour); return; }
  // start / goal / hop — a node already on the web: re-focus there.
  _cbs.onFocus && _cbs.onFocus(info.name);
}

// ── Build a graph-response-shaped object from the game state ──────────────────
// nodes/edges are id-based (real ids where resolved, synthetic otherwise), so
// the real replaceGraph() pipeline renders them exactly like an Explorer graph.
function buildGraph(game, photos, ids, frontier) {
  const idOf = name => {
    const real = ids ? ids[name] : null;
    return real != null ? real : synthId(name);
  };
  _byId = new Map();
  const nodes = [];
  const seen = new Set();
  const push = (name, kind, extra) => {
    const id = idOf(name);
    if (seen.has(id)) return id;
    seen.add(id);
    nodes.push({ id, name, image: (photos && photos[name]) || undefined });
    _byId.set(id, { name, kind, ...(extra || {}) });
    return id;
  };

  (game.nodes || []).forEach(n => {
    const kind = n.name === game.start ? "start" : n.name === game.goal ? "goal" : "hop";
    push(n.name, kind);
  });

  const edges = webEdges(game).map(e => ({ from: idOf(e.from), to: idOf(e.to) }));

  const goalInWeb = (game.nodes || []).some(n => n.name === game.goal);
  if (!goalInWeb) {
    push(game.goal, "goalTarget");
    if (game.focus) edges.push({ from: idOf(game.focus), to: idOf(game.goal) });
  }

  // Dandelion: the focus's real collaborators (already filtered by the caller).
  if (frontier && !frontier.loading && !frontier.unavailable && Array.isArray(frontier.neighbours)) {
    const inWeb = new Set((game.nodes || []).map(n => n.name.toLowerCase()));
    frontier.neighbours
      .filter(n => !inWeb.has(n.name.toLowerCase()) && n.name.toLowerCase() !== (game.goal || "").toLowerCase())
      .slice(0, 12)
      .forEach(n => {
        if (seen.has(n.id)) return;
        seen.add(n.id);
        nodes.push({ id: n.id, name: n.name, image: n.image || undefined });
        _byId.set(n.id, { name: n.name, kind: "neighbour", neighbour: n });
        if (game.focus) edges.push({ from: idOf(game.focus), to: n.id });
      });
  }

  return { seed: game.start, seed_id: idOf(game.start), nodes, edges, truncated: false };
}

// Post-render tint so the game roles read on the real engine: goal = pulse,
// focus = white ring, dandelion = dim. Start is already the seed (signal-hero).
function tintRoles(game) {
  if (!State.nodesDS) return;
  const pulse = tok("--pulse", "#B98AFF");
  const amber = tok("--amber", "#FFD27A");
  const paper = tok("--paper", "#EDEFF4");
  const mist  = tok("--mist",  "#8A94A6");
  const panel = tok("--panel", "#141A28");
  const updates = [];
  _byId.forEach((info, id) => {
    if (info.kind === "goal" || info.kind === "goalTarget") {
      updates.push({ id, color: { border: pulse, background: panel }, borderWidth: 3 });
    } else if (info.kind === "hop") {
      updates.push({ id, color: { border: amber, background: panel }, borderWidth: 3 });
    } else if (info.kind === "neighbour") {
      updates.push({ id, color: { border: mist, background: panel }, borderWidth: 1.5, opacity: 0.8 });
    }
    if (game.focus && info.name === game.focus && info.kind !== "goalTarget") {
      updates.push({ id, color: { border: paper, background: panel }, borderWidth: 5 });
    }
  });
  try { if (updates.length) State.nodesDS.update(updates); } catch { /* DataSet not ready */ }
}

// Animated focus + goal rings, drawn on the real network's own canvas overlay
// (the same beforeDrawing seam the Explorer uses for its ring-guides).
function ringHook(ctx) {
  if (!State.network || !_lastGame) return;
  const draw = (name, color) => {
    let id = null;
    _byId.forEach((info, nid) => { if (info.name === name) id = nid; });
    if (id == null) return;
    let pos; try { pos = State.network.getPositions([id])[id]; } catch { return; }
    if (!pos) return;
    const t = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
    ctx.save();
    for (let k = 0; k < 2; k++) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 30 + k * 11 + Math.sin(t * 1.6 + k) * 3, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(color, 0.4 - k * 0.16);
      ctx.lineWidth = 2; ctx.setLineDash([4, 6]); ctx.stroke();
    }
    ctx.restore();
  };
  if (!(_lastGame.nodes || []).some(n => n.name === _lastGame.goal)) draw(_lastGame.goal, tok("--pulse", "#B98AFF"));
}

function ensureRingHook() {
  if (State.network && _ringNet !== State.network) {
    try { State.network.on("beforeDrawing", ringHook); _ringNet = State.network; } catch { /* not up */ }
  }
}

// ── Public render (≈ drawChain) ───────────────────────────────────────────────
export function renderBoard(game, photos, frontier, ids, callbacks) {
  _cbs = callbacks || {};
  if (!State.graphGameMode) return;   // only draws while mounted in game mode
  if (!game) { _lastGame = null; return; }
  _lastGame = game;
  try {
    replaceGraph(buildGraph(game, photos, ids, frontier));
  } catch { return; }
  tintRoles(game);
  ensureRingHook();
}

export function zoomBoard(factor) {
  if (!State.network) return;
  try { State.network.moveTo({ scale: State.network.getScale() * factor, animation: { duration: 200 } }); } catch { /* */ }
}
export function fitBoard() {
  if (State.network) { try { State.network.fit({ animation: { duration: 220 } }); } catch { /* */ } }
}
