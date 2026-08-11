import {
  State,
  PHYSICS_SETTLE_MS,
  MOTION,
  prefersReducedMotion,
  visAnimation,
  scaledDuration,
} from "../state/state.js";
import { els } from "../dom/dom.js";
import { resetHoverState } from "./highlight.js";
import { nodeVisual, edgeVisual, LARGE_GRAPH_NODE_THRESHOLD, _imageFieldsFor } from "./visuals.js";
import {
  beginLayout,
  buildLayoutRequest,
  classifyGraph,
  entranceFrom,
  isCurrentLayout,
  markEntrancePending,
  markLayoutSettled,
} from "./layout.js";
import { cachedLayout, fetchLayout } from "../api/analytics-client.js";
import { setEdgeCache, suppressNativeEdgeColor } from "./edge-render.js";
import { highlightPath, highlightNeighborhood } from "./highlight.js";
import { setContourData } from "./bubble-contours.js";

const LARGE_GRAPH_SETTLE_MS = 500;

const ENTRANCE_START_SCALE = 0.55;
const ENTRANCE_START_OPACITY = 0.35;

const ENTRANCE_STAGGER_MS = 18;
const ENTRANCE_STAGGER_MAX_MS = 220;
export function scheduleFreeze(ms) {
  clearTimeout(State.physicsTimer);
  State.physicsTimer = setTimeout(() => {
    State.physicsTimer = null;
    if (State.network) State.network.setOptions({ physics: { enabled: false } });
  }, ms);
}

export function updateEdgeRenderMode() {
  if (!State.network) return;
  State.network.setOptions({
    edges: { smooth: { enabled: true, type: "continuous", roundness: 0.45 } },
  });
}

const FAST_MODE_EXIT_DELAY = 220;
let _fastRenderActive = false;
let _fastRenderExitTimer = null;

export function pokeFastRenderMode() {
  if (!State.network || !State.nodesDS) return;
  if (State.graphNodes.length <= LARGE_GRAPH_NODE_THRESHOLD) return;
  if (!_fastRenderActive) {
    _fastRenderActive = true;
    State.nodesDS.update(State.graphNodes.map((n) => ({ id: n.id, shape: "dot" })));
  }
  if (_fastRenderExitTimer) clearTimeout(_fastRenderExitTimer);
  _fastRenderExitTimer = setTimeout(() => {
    _fastRenderExitTimer = null;
    _fastRenderActive = false;
    if (State.nodesDS) {
      State.nodesDS.update(State.graphNodes.map((n) => ({ id: n.id, ..._imageFieldsFor(n) })));
    }
  }, FAST_MODE_EXIT_DELAY);
}

export function resetFastRenderMode() {
  if (_fastRenderExitTimer) clearTimeout(_fastRenderExitTimer);
  _fastRenderExitTimer = null;
  _fastRenderActive = false;
}

export function nudgePhysics(ms, _noFit) {
  if (!State.network) return;
  const requested = ms || PHYSICS_SETTLE_MS;
  const settleMs =
    State.graphNodes.length > LARGE_GRAPH_NODE_THRESHOLD
      ? Math.min(requested, LARGE_GRAPH_SETTLE_MS)
      : requested;
  updateEdgeRenderMode();
  State.network.setOptions({
    physics: { enabled: true, stabilization: { enabled: false } },
  });
  scheduleFreeze(settleMs);
}

export function _fitToExpandedCluster() {
  if (!State.network || State.expandedNodes.size === 0) return;
  const expanded = [...State.expandedNodes];
  const lastExpanded = expanded[expanded.length - 1];
  const conn = State.network.getConnectedNodes(lastExpanded);
  const nodeIds = [lastExpanded, ...conn].slice(0, 40);
  try {
    State.network.fit({
      nodes: nodeIds,
      animation: visAnimation(MOTION.xxslow),
    });
  } catch {}
}

export function mergeNetwork(nameById, savedPositions, options = {}) {
  resetHoverState();

  if (State._expandAnimId != null) {
    cancelAnimationFrame(State._expandAnimId);
    State._expandAnimId = null;
  }
  clearTimeout(State.physicsTimer);
  State.physicsTimer = null;
  if (State.network) State.network.setOptions({ physics: { enabled: false } });

  const dsNodeIds = new Set(State.nodesDS.getIds());
  const dsEdgeIds = new Set(State.edgesDS.getIds());

  const freshNodes = State.graphNodes.filter((n) => n._isNew && !dsNodeIds.has(n.id));

  const isPathMode = !!(options.pathTargets && options.pathFromPos);
  const { edgeClass, sectorMembers } = isPathMode
    ? { edgeClass: null, sectorMembers: null }
    : classifyGraph();

  const newEdgeItems = State.graphEdges
    .filter((e) => !dsEdgeIds.has(e.id))
    .map((e) => {
      const v = edgeVisual(e, nameById);
      return edgeClass ? suppressNativeEdgeColor(v) : v;
    });
  if (edgeClass) {
    setEdgeCache(edgeClass);
    const catchUpUpdates = [];
    for (const e of State.graphEdges) {
      if (!dsEdgeIds.has(e.id)) continue;
      if (!edgeClass.has(e.id)) continue;
      catchUpUpdates.push(suppressNativeEdgeColor({ id: e.id }));
    }
    if (catchUpUpdates.length && State.edgesDS) State.edgesDS.update(catchUpUpdates);
  }
  if (sectorMembers) setContourData(sectorMembers);

  const seedId = State.currentSeedId;
  if (seedId != null) {
    State.nodesDS.update({ id: seedId, x: 0, y: 0, fixed: { x: true, y: true } });
  }

  const fromPos = isPathMode
    ? options.pathFromPos
    : entranceFrom(
        savedPositions,
        State.graphNodes.map((n) => n.id),
      );

  const entranceTargets = new Map();
  const newNodeItems = freshNodes.map((n) => {
    const v = nodeVisual(n);
    const f = fromPos.get(n.id) || { x: 0, y: 0 };
    entranceTargets.set(n.id, { size: v.size, opacity: v.opacity });
    return {
      ...v,
      x: f.x,
      y: f.y,
      size: v.size * ENTRANCE_START_SCALE,
      opacity: ENTRANCE_START_OPACITY,
    };
  });

  markEntrancePending(freshNodes);
  if (newNodeItems.length) State.nodesDS.add(newNodeItems);
  if (newEdgeItems.length) State.edgesDS.add(newEdgeItems);

  const existingUpdates = State.graphNodes
    .filter((n) => !n._isNew && dsNodeIds.has(n.id))
    .map((n) => {
      const v = nodeVisual(n);
      return {
        id: n.id,
        size: v.size,
        /**
         * Прошлый вылет мог оборваться на полпути — новое слияние отменяет
         * анимацию, а с ней и доводку размера с прозрачностью. Узел так и
         * остаётся уменьшенным и полупрозрачным, поэтому оба поля возвращаются
         * здесь, а не только размер.
         */
        opacity: v.opacity,
        color: v.color,
        borderWidth: v.borderWidth,
        shadow: v.shadow,
        mass: v.mass,
        title: v.title,
        fixed: v.fixed,
      };
    });
  if (existingUpdates.length) State.nodesDS.update(existingUpdates);

  if (State.pathHighlight) highlightPath(State.pathHighlight, { dim: false });

  if (State.focusedNodeId != null) highlightNeighborhood(State.focusedNodeId);

  for (const n of freshNodes) n._isNew = false;

  const flyTo = (targets) => _flyToLayout({ targets, fromPos, entranceTargets, freshNodes });

  const request = isPathMode ? null : buildLayoutRequest(savedPositions);
  const { generation, signal } = beginLayout();

  if (isPathMode) {
    flyTo(options.pathTargets);
    return;
  }

  const ready = cachedLayout(request);
  if (ready) {
    flyTo(ready);
    return;
  }
  fetchLayout(request, { signal }).then(
    (targets) => {
      if (isCurrentLayout(generation)) flyTo(targets);
    },
    () => {
      if (isCurrentLayout(generation)) flyTo(null);
    },
  );
}

function _degradeWithoutLayout(entranceTargets) {
  if (entranceTargets && entranceTargets.size && State.nodesDS) {
    State.nodesDS.update(
      [...entranceTargets].map(([id, v]) => ({ id, size: v.size, opacity: v.opacity })),
    );
  }
  if (!State.network) return;
  const unfix = State.graphNodes
    .filter((n) => n.id !== State.currentSeedId)
    .map((n) => ({ id: n.id, fixed: false }));
  if (unfix.length && State.nodesDS) State.nodesDS.update(unfix);
  nudgePhysics(PHYSICS_SETTLE_MS);
}

function _flyToLayout({ targets, fromPos, entranceTargets, freshNodes }) {
  if (!targets || !targets.size) {
    _degradeWithoutLayout(entranceTargets);
    return;
  }
  const net = State.network;
  if (!net) return;

  runFlyoutAnimation({
    ids: [...targets.keys()],
    fromPos,
    targets,
    durationMs: scaledDuration(MOTION.flight),
    entranceTargets,
    onDone: () => {
      markLayoutSettled(targets);
      net.setOptions({ physics: { enabled: false } });
      updateEdgeRenderMode();
      const fixAll = State.graphNodes.map((n) => ({ id: n.id, fixed: { x: true, y: true } }));
      if (State.nodesDS) State.nodesDS.update(fixAll);

      try {
        const focusIds =
          State.lastExpandedId != null
            ? [State.lastExpandedId, ...freshNodes.map((n) => n.id)]
            : [...targets.keys()];
        let minX = Infinity,
          maxX = -Infinity,
          minY = Infinity,
          maxY = -Infinity;
        for (const id of focusIds) {
          const t = targets.get(id);
          if (!t) continue;
          if (t.x < minX) minX = t.x;
          if (t.x > maxX) maxX = t.x;
          if (t.y < minY) minY = t.y;
          if (t.y > maxY) maxY = t.y;
        }
        if (!isFinite(minX)) throw new Error("no focus target");

        const cx = (minX + maxX) / 2,
          cy = (minY + maxY) / 2;
        const w = Math.max(1, maxX - minX),
          h = Math.max(1, maxY - minY);
        const pad = 140;
        const cw = (els.network && els.network.clientWidth) || 1100;
        const ch = (els.network && els.network.clientHeight) || 720;
        const sc = Math.min(cw / (w + pad * 2), ch / (h + pad * 2));
        net.moveTo({
          position: { x: cx, y: cy },
          scale: Math.max(0.14, Math.min(sc, 1.25)),
          animation: visAnimation(MOTION.xxslow),
        });
      } catch {}
    },
  });
}

function _cubicBezierEase(p1x, p1y, p2x, p2y) {
  const bezier = (t, a1, a2) =>
    (1 - 3 * a2 + 3 * a1) * t * t * t + (3 * a2 - 6 * a1) * t * t + 3 * a1 * t;
  const bezierSlope = (t, a1, a2) =>
    3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1;
  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = bezier(t, p1x, p2x) - x;
      const slope = bezierSlope(t, p1x, p2x);
      if (Math.abs(slope) < 1e-6) break;
      t -= dx / slope;
    }
    return bezier(t, p1y, p2y);
  };
}
const _easeOutFlyout = _cubicBezierEase(0.4, 0.0, 0.2, 1.0);

function _fastMoveNode(net, body, id, x, y) {
  const nb = body && body[id];
  if (nb) {
    nb.x = x;
    nb.y = y;
    return true;
  }
  if (net) net.moveNode(id, x, y);
  return false;
}

let _bodyShapeChecked = false;
let _bodyShapeValid = true;

export function runFlyoutAnimation({ ids, fromPos, targets, durationMs, entranceTargets, onDone }) {
  const net = State.network;

  if (prefersReducedMotion() || !ids.length) {
    for (const id of ids) {
      const t = targets.get(id);
      if (t && net) net.moveNode(id, t.x, t.y);
    }
    if (entranceTargets && entranceTargets.size && State.nodesDS) {
      State.nodesDS.update(
        [...entranceTargets].map(([id, v]) => ({ id, size: v.size, opacity: v.opacity })),
      );
    }
    State._expandAnimId = null;
    if (onDone) onDone();
    return null;
  }

  let body = net && net.body && net.body.nodes;

  if (!_bodyShapeChecked && ids.length) {
    _bodyShapeChecked = true;
    const knownId = ids[0];
    const nb = body && body[knownId];
    _bodyShapeValid = !!body && !!nb && typeof nb.x === "number" && typeof nb.y === "number";
    if (!_bodyShapeValid) {
      console.warn(
        "[vis-adapter] private net.body.nodes shape changed — falling back to public moveNode",
      );
    }
  }
  if (!_bodyShapeValid) body = null;

  const M = ids.length;
  const sx = new Float32Array(M),
    sy = new Float32Array(M);
  const tx = new Float32Array(M),
    ty = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const f = fromPos.get(ids[i]) || { x: 0, y: 0 };
    const t = targets.get(ids[i]) || { x: 0, y: 0 };
    sx[i] = f.x;
    sy[i] = f.y;
    tx[i] = t.x;
    ty[i] = t.y;
  }

  let t0 = null;
  let entranceDone = !entranceTargets || !entranceTargets.size;

  let entranceDelays = null;
  if (!entranceDone) {
    entranceDelays = new Map();
    let i = 0;
    for (const id of entranceTargets.keys()) {
      entranceDelays.set(id, Math.min(i * ENTRANCE_STAGGER_MS, ENTRANCE_STAGGER_MAX_MS));
      i++;
    }
  }

  function step(ts) {
    if (!State.network) {
      State._expandAnimId = null;
      return;
    }
    if (t0 === null) t0 = ts;
    const elapsed = ts - t0;
    const pct = _easeOutFlyout(Math.min(elapsed / durationMs, 1));

    let usedFastPath = false;
    for (let i = 0; i < M; i++) {
      const moved = _fastMoveNode(
        net,
        body,
        ids[i],
        sx[i] + (tx[i] - sx[i]) * pct,
        sy[i] + (ty[i] - sy[i]) * pct,
      );
      usedFastPath = usedFastPath || moved;
    }
    if (usedFastPath) net.redraw();

    if (!entranceDone) {
      const updates = [];
      let allDone = true;
      for (const [id, v] of entranceTargets) {
        const delay = entranceDelays.get(id) || 0;
        const ePct = Math.min(Math.max(elapsed - delay, 0) / MOTION.med, 1);
        if (ePct < 1) allDone = false;
        updates.push({
          id,
          size: v.size * (ENTRANCE_START_SCALE + (1 - ENTRANCE_START_SCALE) * ePct),
          opacity: ENTRANCE_START_OPACITY + (v.opacity - ENTRANCE_START_OPACITY) * ePct,
        });
      }
      if (updates.length && State.nodesDS) State.nodesDS.update(updates);
      if (allDone) entranceDone = true;
    }

    if (pct < 1) {
      State._expandAnimId = requestAnimationFrame(step);
      return;
    }

    State._expandAnimId = null;
    if (onDone) onDone();
  }

  State._expandAnimId = requestAnimationFrame(step);
  return State._expandAnimId;
}
