import { State, COLOR, resetGraphState, MOTION, visAnimation } from "../state/state.js";
import { els } from "../dom/dom.js";
import { forceCloseSearchModal, hideArtistSidebar } from "../ui/index.js";
import { runHeroGraphTransition } from "../dom/transition.js";
import { stopCanvasDecorator } from "../dom/canvas-decorator.js";
import { clearCanvasState } from "../ui/canvas-states.js";
import { resetHoverState, invalidateColorCache } from "./highlight.js";
import { attachNetworkEvents } from "./events.js";
import { isGameModeActive } from "./game-mode.js";
import {
  updateEdgeRenderMode,
  runFlyoutAnimation,
  pokeFastRenderMode,
  resetFastRenderMode,
} from "./physics.js";
import {
  nodeVisual,
  edgeVisual,
  networkOptions,
  hexToRgba,
  LARGE_GRAPH_NODE_THRESHOLD,
  FAST_RENDER_EDGE_THRESHOLD,
} from "./visuals.js";
import { ensureTooltipCollisionGuard } from "./tooltips.js";
import {
  beginLayout,
  buildLayoutRequest,
  classifyGraph,
  isCurrentLayout,
  markEntrancePending,
  markLayoutSettled,
  LEAF_R,
} from "./layout.js";
import { cachedLayout, fetchLayout } from "../api/analytics-client.js";
import { setEdgeCache, clearEdgeCache, drawEdges, suppressNativeEdgeColor } from "./edge-render.js";
import { setContourData, clearContourData, drawContours } from "./bubble-contours.js";

function _layoutNodeItems(nameById, savedPositions = {}) {
  const { edgeClass } = classifyGraph();
  /**
   * Узлу без сохранённой позиции координату придумает vis. Она ничем не хуже
   * любой другой для первого кадра, но решением раскладки не является, и
   * закреплять её в следующем запросе нельзя — до ответа сервера такой узел
   * помечен как не доехавший.
   */
  const unplaced = [];
  const nodeItems = State.graphNodes.map((n) => {
    const v = nodeVisual(n);
    if (n.isSeed) return { ...v, x: 0, y: 0, fixed: { x: true, y: true } };
    const sp = savedPositions && savedPositions[n.id];
    if (sp) return { ...v, x: sp.x, y: sp.y, fixed: { x: true, y: true } };
    unplaced.push(n);
    return v;
  });
  markEntrancePending(unplaced);
  const edgeItems = State.graphEdges.map((e) => suppressNativeEdgeColor(edgeVisual(e, nameById)));
  setEdgeCache(edgeClass);
  return { nodeItems, edgeItems };
}

function _applyLayout(answer) {
  if (!answer) return;
  setContourData(answer.contours);

  const targets = answer.positions;
  if (!State.network || !targets || !targets.size) return;
  markLayoutSettled(targets);
  const updates = [];
  for (const [id, t] of targets) {
    if (id === State.currentSeedId) continue;
    if (State.nodesDS && !State.nodesDS.get(id)) continue;
    State.network.moveNode(id, t.x, t.y);
    updates.push({ id, x: t.x, y: t.y, fixed: { x: true, y: true } });
  }
  if (updates.length && State.nodesDS) State.nodesDS.update(updates);

  if (!isGameModeActive()) State.network.fit({ animation: visAnimation(MOTION.flight) });
}

function _positionFromLayout(savedPositions) {
  const request = buildLayoutRequest(savedPositions);
  const { generation, signal } = beginLayout();
  const ready = cachedLayout(request);
  if (ready) {
    _applyLayout(ready);
    return;
  }
  fetchLayout(request, { signal }).then(
    (answer) => {
      if (isCurrentLayout(generation)) _applyLayout(answer);
    },
    () => {},
  );
}

function _drawRingGuides(ctx) {
  if (!State.network || !State.graphNodes.length) return;
  if (State.graphNodes.length > LARGE_GRAPH_NODE_THRESHOLD) return;
  const hubIds = new Set(State.expandedNodes);
  if (State.currentSeedId != null) hubIds.add(State.currentSeedId);
  if (!hubIds.size) return;
  ctx.save();
  ctx.strokeStyle = hexToRgba(COLOR.signal, 0.12);
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 7]);
  for (const id of hubIds) {
    if (!State.nodesDS || !State.nodesDS.get(id)) continue;
    let pos;
    try {
      pos = State.network.getPosition(id);
    } catch {
      continue;
    }
    if (!pos) continue;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, LEAF_R, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function initNetwork(seedId, nameById) {
  resetFastRenderMode();
  State.currentSeedId = seedId;

  const { nodeItems, edgeItems } = _layoutNodeItems(nameById);

  State.nodesDS = new vis.DataSet(nodeItems);
  State.edgesDS = new vis.DataSet(edgeItems);

  State.network = new vis.Network(
    els.network,
    { nodes: State.nodesDS, edges: State.edgesDS },
    networkOptions(),
  );

  if (seedId != null) {
    State.network.moveNode(seedId, 0, 0);
  }

  State.network.on("beforeDrawing", drawContours);
  State.network.on("beforeDrawing", _drawRingGuides);
  State.network.on("beforeDrawing", drawEdges);

  updateEdgeRenderMode();
  _attachZoomThrottle();
  attachNetworkEvents(nameById);
  ensureTooltipCollisionGuard();

  State.network.setOptions({ physics: { enabled: false } });
  _positionFromLayout({});
  if (!isGameModeActive()) State.network.fit({ animation: visAnimation(MOTION.flight) });

  clearTimeout(State.physicsTimer);
  State.physicsTimer = null;
}

export function initPathNetwork(nameById, targets, fromPos) {
  const nodeItems = State.graphNodes.map((n) => {
    const v = nodeVisual(n);
    const f = fromPos.get(n.id) || { x: 0, y: 0 };
    return { ...v, x: f.x, y: f.y, fixed: false };
  });
  const edgeItems = State.graphEdges.map((e) => edgeVisual(e, nameById));

  State.nodesDS = new vis.DataSet(nodeItems);
  State.edgesDS = new vis.DataSet(edgeItems);

  const opts = networkOptions();
  opts.physics = { enabled: false };

  State.network = new vis.Network(
    els.network,
    { nodes: State.nodesDS, edges: State.edgesDS },
    opts,
  );

  State.network.on("beforeDrawing", drawContours);
  State.network.on("beforeDrawing", _drawRingGuides);
  State.network.on("beforeDrawing", drawEdges);

  updateEdgeRenderMode();
  _attachZoomThrottle();
  attachNetworkEvents(nameById);
  ensureTooltipCollisionGuard();

  const pathIds = [...targets.keys()];
  runFlyoutAnimation({
    ids: pathIds,
    fromPos,
    targets,
    durationMs: MOTION.flight,
    onDone: () => {
      if (!State.network) return;
      State.network.fit({
        nodes: pathIds,
        animation: visAnimation(MOTION.camera),
      });
      const fixAll = State.graphNodes.map((n) => ({ id: n.id, fixed: { x: true, y: true } }));
      if (State.nodesDS) State.nodesDS.update(fixAll);
    },
  });
}

let _zoomThrottleTimer = null;
export function _attachZoomThrottle() {
  if (!State.network) return;
  State.network.on("zoom", () => pokeFastRenderMode());
  State.network.on("zoom", () => {
    if (State.graphEdges.length < 120) return;
    if (_zoomThrottleTimer) clearTimeout(_zoomThrottleTimer);
    _zoomThrottleTimer = setTimeout(() => {
      _zoomThrottleTimer = null;
      if (State.network) State.network.redraw();
    }, 60);
  });
  State.network.on("zoom", () => {
    if (!State.network) return;
    const scale = State.network.getScale();
    const bigGraph = State.graphEdges.length > FAST_RENDER_EDGE_THRESHOLD;
    if (bigGraph && scale < 0.5) {
      State.network.setOptions({ interaction: { hover: false } });
    } else if (bigGraph && scale >= 0.5) {
      State.network.setOptions({ interaction: { hover: true } });
    }
  });
}

export function refreshNetwork(seedId, nameById, savedPositions) {
  resetFastRenderMode();
  resetHoverState();

  if (seedId != null) State.currentSeedId = seedId;

  const { nodeItems, edgeItems } = _layoutNodeItems(nameById, savedPositions);

  State.nodesDS.clear();
  State.edgesDS.clear();
  State.nodesDS.add(nodeItems);
  State.edgesDS.add(edgeItems);

  if (State.currentSeedId != null) {
    State.network.moveNode(State.currentSeedId, 0, 0);
  }
  for (const item of nodeItems) {
    if (item.x != null && item.y != null && item.id !== State.currentSeedId) {
      State.network.moveNode(item.id, item.x, item.y);
    }
  }

  State.network.setOptions({ physics: { enabled: false } });
  _positionFromLayout(savedPositions);
  if (!isGameModeActive()) State.network.fit({ animation: visAnimation(MOTION.flight) });
  clearTimeout(State.physicsTimer);
  State.physicsTimer = null;
}

export function openGeniusPage(nodeId) {
  const node = State.graphNodes.find((n) => n.id === nodeId);
  if (!node) return;
  const url =
    node.geniusUrl ||
    `https://genius.com/artists/${encodeURIComponent(node.name.replace(/\s+/g, "-").toLowerCase())}`;
  window.open(url, "_blank", "noopener");
}

export function initGraphOnCanvas() {
  runHeroGraphTransition(() => {
    forceCloseSearchModal();
    els.status.hidden = false;
  }, "toGraph");
  stopCanvasDecorator();
  clearCanvasState(els.canvasState);
}

function _resetGraphState({
  keepRendered = false,
  clearCache = false,
  invalidateColors = false,
} = {}) {
  resetFastRenderMode();
  clearEdgeCache();
  clearContourData();
  resetGraphState({ resetHasRendered: !keepRendered });
  if (clearCache) {
    State._graphCache.clear();
  }
  resetHoverState();
  hideArtistSidebar();
  if (invalidateColors) invalidateColorCache();
}

export function resetCanvasToEmpty() {
  _resetGraphState({ keepRendered: true, clearCache: true, invalidateColors: true });
}

export function clearGraphForPathSearch() {
  _resetGraphState({ keepRendered: true, invalidateColors: true });
}
