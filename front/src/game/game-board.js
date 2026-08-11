import { State, MOTION, visAnimation } from "../state/state.js";
import { replaceGraph } from "../graph.js";
import {
  enterGameMode,
  exitGameMode,
  isGameModeActive,
  applyGameEngineOptions,
} from "../vis-adapter/game-mode.js";
import { webEdges } from "./connect-model.js";
import { computeGameLayout, layoutBounds } from "./game-layout.js";
import { FIXED_NODE_RADIUS } from "../vis-adapter/visuals.js";

let _cbs = {};
let _byId = new Map();
let _ringNet = null;
let _lastGame = null;
let _rootStyle = null;
function tok(name, fallback) {
  if (!_rootStyle) _rootStyle = getComputedStyle(document.documentElement);
  const v = _rootStyle.getPropertyValue(name).trim();
  return v || fallback;
}
function rgba(hex, a) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return `rgba(94,230,197,${a})`;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function mountBoard(container) {
  enterGameMode({ container, onNodeClick: handleClick });
}

export function unmountBoard() {
  _wasOver = false;
  exitGameMode();
  _byId = new Map();
  _lastGame = null;
  _lastSig = "";
}

function handleClick(params) {
  const id = params?.nodes?.[0];
  if (id == null) return;
  const info = _byId.get(id);
  if (!info) return;
  if (info.kind === "goalTarget") {
    _cbs.onReachGoal && _cbs.onReachGoal();
    return;
  }
  if (info.kind === "neighbour") {
    info.neighbour && _cbs.onPick && _cbs.onPick(info.neighbour);
    return;
  }
  _cbs.onFocus && _cbs.onFocus(info.name);
}

function buildGraph(game, photos, ids, frontier) {
  const idOf = (name) => (ids ? ids[name] : null) ?? null;
  _byId = new Map();
  const nodes = [];
  const seen = new Set();
  const push = (name, kind, extra) => {
    const id = idOf(name);
    if (id == null) return null;
    if (seen.has(id)) return id;
    seen.add(id);
    nodes.push({ id, name, image: (photos && photos[name]) || undefined });
    _byId.set(id, { name, kind, ...(extra || {}) });
    return id;
  };

  (game.nodes || []).forEach((n) => {
    const kind = n.name === game.start ? "start" : n.name === game.goal ? "goal" : "hop";
    push(n.name, kind);
  });

  const edges = webEdges(game)
    .map((e) => ({ from: idOf(e.from), to: idOf(e.to) }))
    .filter((e) => e.from != null && e.to != null);

  const goalInWeb = (game.nodes || []).some((n) => n.name === game.goal);
  if (!goalInWeb) push(game.goal, "goalTarget");

  const over = game.completed === true || game.gaveUp === true;
  if (
    !over &&
    frontier &&
    !frontier.loading &&
    !frontier.unavailable &&
    Array.isArray(frontier.neighbours)
  ) {
    const inWeb = new Set((game.nodes || []).map((n) => n.name.toLowerCase()));
    frontier.neighbours
      .filter(
        (n) =>
          !inWeb.has(n.name.toLowerCase()) &&
          n.name.toLowerCase() !== (game.goal || "").toLowerCase(),
      )
      .slice(0, 8)
      .forEach((n) => {
        if (seen.has(n.id)) return;
        seen.add(n.id);
        nodes.push({ id: n.id, name: n.name, image: n.image || undefined });
        _byId.set(n.id, { name: n.name, kind: "neighbour", neighbour: n });
        if (game.focus) edges.push({ from: idOf(game.focus), to: n.id });
      });
  }

  return { seed: game.start, seedId: idOf(game.start), nodes, edges, truncated: false };
}

let _lastLayout = null;

function boardFan() {
  const neighbours = [];
  _byId.forEach((info, id) => {
    if (info.kind === "neighbour") neighbours.push({ id, name: info.name });
  });
  return { loading: false, neighbours };
}

function applyLayout(game, par) {
  const layout = computeGameLayout(game, { par, frontier: boardFan() });
  _lastLayout = layout;
  if (!State.nodesDS) return layout;

  const idByName = new Map();
  _byId.forEach((info, id) => idByName.set(info.name, id));

  const updates = [];
  const place = (name, pos) => {
    const id = idByName.get(name);
    if (id == null || !pos) return;
    updates.push({
      id,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      fixed: true,
      physics: false,
      size: FIXED_NODE_RADIUS,
    });
  };

  layout.positions.forEach((pos, name) => place(name, pos));
  layout.frontier.forEach((pos, name) => place(name, pos));
  if (!layout.positions.has(game.goal)) place(game.goal, layout.goal);

  try {
    if (updates.length) State.nodesDS.update(updates);
    if (State.network && typeof State.network.moveNode === "function") {
      updates.forEach((u) => {
        try {
          State.network.moveNode(u.id, u.x, u.y);
        } catch {}
      });
    }
  } catch {}
  return layout;
}

function tintRoles(game) {
  if (!State.nodesDS) return;
  const RING = 3;
  const signal = tok("--signal", "#5EE6C5");
  const pulse = tok("--pulse", "#B98AFF");
  const amber = tok("--amber", "#FFD27A");
  const paper = tok("--paper", "#EDEFF4");
  const mist = tok("--mist", "#8A94A6");
  const panel = tok("--panel", "#141A28");
  const updates = [];
  _byId.forEach((info, id) => {
    if (info.kind === "goal" || info.kind === "goalTarget") {
      updates.push({ id, color: { border: pulse, background: panel }, borderWidth: RING });
    } else if (info.kind === "hop") {
      updates.push({ id, color: { border: amber, background: panel }, borderWidth: RING });
    } else if (info.kind === "neighbour") {
      updates.push({
        id,
        color: { border: mist, background: panel },
        borderWidth: RING,
        opacity: 0.75,
      });
    } else {
      updates.push({ id, color: { border: signal, background: panel }, borderWidth: RING });
    }
    if (game.focus && info.name === game.focus && info.kind !== "goalTarget") {
      updates.push({
        id,
        color: { border: paper, background: panel },
        borderWidth: RING,
        opacity: 1,
      });
    }
  });
  try {
    if (updates.length) State.nodesDS.update(updates);
  } catch {}
}

function ringHook(ctx) {
  if (!State.network || !_lastGame) return;
  const draw = (name, color) => {
    let id = null;
    _byId.forEach((info, nid) => {
      if (info.name === name) id = nid;
    });
    if (id == null) return;
    let pos;
    try {
      pos = State.network.getPositions([id])[id];
    } catch {
      return;
    }
    if (!pos) return;
    ctx.save();
    for (let k = 0; k < 2; k++) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 30 + k * 11, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(color, 0.4 - k * 0.16);
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 6]);
      ctx.stroke();
    }
    ctx.restore();
  };
  if (!(_lastGame.nodes || []).some((n) => n.name === _lastGame.goal))
    draw(_lastGame.goal, tok("--pulse", "#B98AFF"));
  drawAim(ctx);
}

function drawAim(ctx) {
  if (!_lastLayout || !_lastGame) return;
  const goalName = _lastGame.goal,
    focus = _lastGame.focus;
  if (!goalName || !focus) return;
  if (_lastLayout.positions.has(goalName)) return;
  const from = _lastLayout.positions.get(focus);
  const to = _lastLayout.goal;
  if (!from || !to) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = rgba(tok("--pulse", "#B98AFF"), 0.22);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([2, 10]);
  ctx.stroke();
  ctx.restore();
}

function ensureRingHook() {
  if (State.network && _ringNet !== State.network) {
    try {
      State.network.on("beforeDrawing", ringHook);
      applyGameEngineOptions();
      _ringNet = State.network;
    } catch {}
  }
}

let _lastSig = "";
let _wasOver = false;
export function renderBoard(game, photos, frontier, ids, callbacks, opts = {}) {
  _cbs = callbacks || {};
  if (!isGameModeActive()) return;
  if (!game) {
    _lastGame = null;
    _lastSig = "";
    _lastLayout = null;
    return;
  }
  _lastGame = game;
  const graph = buildGraph(game, photos, ids, frontier);
  if (!graph.nodes.length) {
    _lastSig = "";
    return;
  }
  const sig = graph.nodes
    .map((n) => n.id)
    .sort((a, b) => a - b)
    .join(",");
  if (sig === _lastSig && State.nodesDS && State.nodesDS.length > 0) {
    applyLayout(game, opts.par ?? null);
    tintRoles(game);
    return;
  }
  const over = game.completed === true || game.gaveUp === true;
  const justFinished = over && !_wasOver;
  _wasOver = over;
  const firstFrame = !_lastSig;

  _lastSig = sig;
  try {
    replaceGraph(graph);
  } catch {
    return;
  }
  applyLayout(game, opts.par ?? null);
  tintRoles(game);
  ensureRingHook();
  if (justFinished || firstFrame || outOfView()) fitBoard();
}

const VIEW_MARGIN = 40;
function outOfView() {
  if (!State.network || !_lastLayout) return false;
  try {
    const c = State.network.canvas?.frame?.canvas;
    if (!c) return false;
    const tl = State.network.DOMtoCanvas({ x: 0, y: 0 });
    const br = State.network.DOMtoCanvas({ x: c.clientWidth, y: c.clientHeight });
    const b = layoutBounds(_lastLayout);
    return (
      b.minX < tl.x + VIEW_MARGIN ||
      b.maxX > br.x - VIEW_MARGIN ||
      b.minY < tl.y + VIEW_MARGIN ||
      b.maxY > br.y - VIEW_MARGIN
    );
  } catch {
    return false;
  }
}

export function zoomBoard(factor) {
  if (!State.network) return;
  try {
    State.network.moveTo({
      scale: State.network.getScale() * factor,
      animation: visAnimation(MOTION.camera),
    });
  } catch {}
}
export function fitBoard() {
  if (State.network) {
    try {
      State.network.fit({ animation: visAnimation(MOTION.camera) });
    } catch {}
  }
}
