// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/render.js — vis.Network lifecycle: init / refresh / destroy,
//                         plus the Genius-page link and the canvas↔graph
//                         scene transitions (initGraphOnCanvas).
//
// Node/edge visual-object construction lives in visuals.js; tooltip HTML and
// the viewport-collision guard live in tooltips.js. This file is only the
// "wire it all up into a live vis.Network" part: initNetwork/refreshNetwork/
// resetCanvasToEmpty/clearGraphForPathSearch.
// ════════════════════════════════════════════════════════════════════════════
import { State, COLOR, resetGraphState, MOTION, visAnimation } from "../state/state.js";
import { els } from "../dom/dom.js";
import { forceCloseSearchModal, hideArtistSidebar } from "../ui/index.js";
import { runHeroGraphTransition } from "../dom/transition.js";
import { stopCanvasDecorator } from "../dom/canvas-decorator.js";
import { clearCanvasState } from "../ui/canvas-states.js";
import { resetHoverState, invalidateColorCache } from "./highlight.js";
import { attachNetworkEvents } from "./events.js";
import { updateEdgeRenderMode, runFlyoutAnimation } from "./physics.js";
import { nodeVisual, edgeVisual, networkOptions, hexToRgba, LARGE_GRAPH_NODE_THRESHOLD } from "./visuals.js";
import { ensureTooltipCollisionGuard } from "./tooltips.js";
import { placeExpandedNodes, LEAF_R } from "./layout.js";

// [SF-WEB-51] Один общий движок детерминированной раскладки для инициала И
// re-search: и initNetwork, и refreshNetwork прогоняют граф через
// placeExpandedNodes (collision-solved targets) и фиксируют ноды ровно там,
// вместо того чтобы полагаться на физику. Возвращает массив нод-объектов с
// впечатанными x/y/fixed — вызывающий строит из них DataSet (init) или
// clear()+add() (refresh). Полюса/сид приколоты (fixed:true) солвером и
// здесь; листья без target (не должно случаться, но на всякий) остаются
// нефиксированными, чтобы не «замерзать» в (0,0).
function _layoutNodeItems(nameById, savedPositions = {}) {
  const { targets } = placeExpandedNodes(savedPositions);
  const nodeItems = State.graphNodes.map(n => {
    const v = nodeVisual(n);
    const t = n.isSeed ? { x: 0, y: 0 } : targets.get(n.id);
    return t ? { ...v, x: t.x, y: t.y, fixed: { x: true, y: true } } : v;
  });
  const edgeItems = State.graphEdges.map(e => edgeVisual(e, nameById));
  return { nodeItems, edgeItems };
}

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-45] RING-GUIDES — a light, draw-only echo of the dandelion-ring
// layout math in layout.js (SF-WEB-29). LEAF_R is the exact radius that
// math places the first ring of a hub's exclusive leaves at; drawing a
// faint circle at that same radius around every hub (seed + expanded
// nodes), read live off State.network each frame via getPosition(), can
// never drift out of sync with the real placement — and, being draw-only,
// never feeds back into it (the dynamic layout mechanism itself is
// untouched). Skipped above LARGE_GRAPH_NODE_THRESHOLD: cheap per hub, but
// no reason to spend it on graphs that are already trading fidelity for
// interaction speed elsewhere (see networkOptions/FAST_RENDER_EDGE_THRESHOLD
// below).
// ════════════════════════════════════════════════════════════════════════════
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
    // [fix] vis.js's Network.getPosition() THROWS (ReferenceError, not just
    // undefined/null) for a node id its internal registry doesn't know —
    // State.expandedNodes/currentSeedId can briefly hold an id from just
    // before a refresh/collapse/clear finishes propagating (this runs on
    // every beforeDrawing frame, so it can land mid-transition). Checking
    // nodesDS.get() first avoids the throw for the common case (id already
    // gone from the DataSet); the try/catch covers the rarer window where
    // the DataSet has it but vis.js's own body.nodes hasn't caught up yet.
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

// ════════════════════════════════════════════════════════════════════════════
// NETWORK LIFECYCLE — init / refresh / destroy
// ════════════════════════════════════════════════════════════════════════════

export function initNetwork(seedId, nameById) {
  // [SF-WEB-29 follow-up] currentSeedId must be set BEFORE placeExpandedNodes
  // runs below (it reads State.currentSeedId) — normally set later by
  // setSeed() in graph.js::finalizeGraphState, too late for this call.
  State.currentSeedId = seedId;

  // [SF-WEB-51] Сид и его прямые соседи получают детерминированную
  // collision-решённую раскладку через общий движок (_layoutNodeItems →
  // placeExpandedNodes) — тот же путь, что и re-search (refreshNetwork) и
  // expand (mergeNetwork). Физика больше не основной решатель: раньше сид и
  // соседи держались только на свободном barnesHut, чьи springLength/
  // gravitationalConstant никогда не подгонялись под LEAF_R/LEAF_GAP, отсюда
  // и разъезжающиеся кольца. Точную, не пересекающуюся геометрию фиксируем
  // сразу (fixed:true) — оставить физику поверх готовой раскладки значило бы
  // растащить её обратно к barnesHut-равновесию.
  const { nodeItems, edgeItems } = _layoutNodeItems(nameById);

  State.nodesDS = new vis.DataSet(nodeItems);
  State.edgesDS = new vis.DataSet(edgeItems);

  State.network = new vis.Network(
    els.network,
    { nodes: State.nodesDS, edges: State.edgesDS },
    networkOptions()
  );

  // Seed сразу в (0,0) и зафиксирован — nodeVisual уже выставил x/y/fixed,
  // но moveNode гарантирует позицию до первого тика физики.
  if (seedId != null) {
    State.network.moveNode(seedId, 0, 0);
  }

  // [SF-WEB-45] One listener for the network's lifetime — refreshNetwork()
  // reuses this same State.network instance (only its DataSets get
  // cleared/rebuilt), so ring-guides stay wired through expand/search
  // without needing to reattach.
  State.network.on("beforeDrawing", _drawRingGuides);

  updateEdgeRenderMode();
  _attachZoomThrottle();
  attachNetworkEvents(nameById);
  ensureTooltipCollisionGuard();

  // Все ноды выше уже зафиксированы на финальных позициях — стабилизации
  // ждать не от чего, сразу отключаем физику и подгоняем камеру.
  State.network.setOptions({ physics: { enabled: false } });
  // [SF-WEB-47] Was its own literal (400) and never checked
  // prefers-reduced-motion — visAnimation(MOTION.flight) covers both.
  State.network.fit({ animation: visAnimation(MOTION.flight) });
  clearTimeout(State.physicsTimer);
  State.physicsTimer = null;
}

// ════════════════════════════════════════════════════════════════════════════
// SF-WEB-17: initPathNetwork — first render for a six-degrees path result on
// the freshly-cleared canvas (see clearGraphForPathSearch/mergePathData).
// Unlike initNetwork(), the path's node positions are already fully known
// ahead of time (placePathNodes in layout.js — a straight, evenly-spaced,
// centered row) — there is nothing for vis.js's physics simulation to
// resolve, so it stays off from the start instead of running a barnesHut
// stabilization pass that would only nudge nodes off their deliberate
// layout. Nodes fly from a shared center point to their target positions via
// the same runFlyoutAnimation() expand/path already share (SF-WEB-09), then
// the camera fits the whole path and positions are frozen.
// ════════════════════════════════════════════════════════════════════════════
export function initPathNetwork(nameById, targets, fromPos) {
  const nodeItems = State.graphNodes.map(n => {
    const v = nodeVisual(n);
    const f = fromPos.get(n.id) || { x: 0, y: 0 };
    return { ...v, x: f.x, y: f.y, fixed: false };
  });
  const edgeItems = State.graphEdges.map(e => edgeVisual(e, nameById));

  State.nodesDS = new vis.DataSet(nodeItems);
  State.edgesDS = new vis.DataSet(edgeItems);

  const opts = networkOptions();
  opts.physics = { enabled: false };

  State.network = new vis.Network(
    els.network,
    { nodes: State.nodesDS, edges: State.edgesDS },
    opts
  );

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
      // [SF-WEB-47] Was its own literal (500) and never checked
      // prefers-reduced-motion — visAnimation(MOTION.camera) covers both.
      State.network.fit({
        nodes: pathIds,
        animation: visAnimation(MOTION.camera)
      });
      const fixAll = State.graphNodes.map(n => ({ id: n.id, fixed: { x: true, y: true } }));
      if (State.nodesDS) State.nodesDS.update(fixAll);
    }
  });
}

// Порог числа рёбер для переключения в "fast render" режим.
const FAST_RENDER_EDGE_THRESHOLD = 150;

let _zoomThrottleTimer = null;
export function _attachZoomThrottle() {
  if (!State.network) return;
  State.network.on("zoom", () => {
    if (State.graphEdges.length < 120) return;
    // При быстром зуме: дебаунсим redraw чтобы не перерисовывать каждый тик.
    if (_zoomThrottleTimer) clearTimeout(_zoomThrottleTimer);
    _zoomThrottleTimer = setTimeout(() => {
      _zoomThrottleTimer = null;
      if (State.network) State.network.redraw();
    }, 60);
  });
  // При очень большом графе: отключаем hover-эффекты на рёбрах (дорогой hit-test).
  State.network.on("zoom", () => {
    if (!State.network) return;
    const scale = State.network.getScale();
    const bigGraph = State.graphEdges.length > FAST_RENDER_EDGE_THRESHOLD;
    // При zoom-out на большом графе — выключаем hover полностью.
    if (bigGraph && scale < 0.5) {
      State.network.setOptions({ interaction: { hover: false } });
    } else if (bigGraph && scale >= 0.5) {
      State.network.setOptions({ interaction: { hover: true } });
    }
  });
}

// [SF-WEB-51] refreshNetwork — re-search: НОВЫЙ граф заменяет уже
// нарисованный (тот же State.network, только DataSets пересобираются). Раньше
// это был единственный physics-only путь: ноды клались по savedPositions
// (позициям СТАРОГО графа — бессмысленным для нового артиста) + nudgePhysics
// как раскладка, без детерминированных targets и без гарантии неперекрытия.
// Теперь идёт через тот же движок, что initNetwork/mergeNetwork
// (_layoutNodeItems → placeExpandedNodes → collision-solver): детерминированная
// не пересекающаяся раскладка, зафиксированная сразу, никакой физики.
// seedId принимается явно (как в initNetwork) и ставится ДО placeExpandedNodes
// — тот читает State.currentSeedId, а setSeed() в finalizeGraphState вызывается
// позже, после этой функции.
export function refreshNetwork(seedId, nameById, savedPositions) {
  // См. комментарий у resetHoverState()/destroyNetwork(): nodesDS/edgesDS
  // здесь очищаются и пересобираются с нуля (новый поиск поверх уже
  // нарисованного графа) — если в момент вызова висел незавершённый
  // hover (мышь ещё не успела уйти с ноды/ребра СТАРОГО графа),
  // _hoveredNodeId/_hoveredEdgeIds оставались указывать на id из старого,
  // уже уничтоженного DataSet. Следующий blur вызывал nodesDS.update()/
  // edgesDS.update() с несуществующим id — vis-data трактует update() по
  // отсутствующему id как upsert и создаёт "недоделанную" ноду/ребро без
  // shape/size/label — на первом же физическом тике/перерисовке vis.js
  // падал в глубине рендерера (edge-base.ts, "reading 'call' of
  // undefined"). Раньше это не проявлялось из-за гонки в старой
  // hover-логике (см. её фикс выше) — теперь ховер стабильно долетает до
  // конца, и без явного сброса здесь стабильно ловил этот краш.
  resetHoverState();

  if (seedId != null) State.currentSeedId = seedId;

  // savedPositions passed through so any node that DOES carry over from the
  // previous graph animates from its old spot; brand-new nodes (the usual
  // case for a different artist) get the fresh deterministic dandelion.
  const { nodeItems, edgeItems } = _layoutNodeItems(nameById, savedPositions);

  State.nodesDS.clear();
  State.edgesDS.clear();
  State.nodesDS.add(nodeItems);
  State.edgesDS.add(edgeItems);

  // Ноды уже несут x/y/fixed из _layoutNodeItems, но add() на УЖЕ
  // существующем network не всегда телепортирует внутренние body.nodes на
  // новые data-координаты — moveNode гарантирует позицию до первого redraw
  // (physics off, так что это дёшево: просто запись координаты, без
  // симуляции). Seed всегда в (0,0), остальные — на свои collision-решённые
  // targets.
  if (State.currentSeedId != null) {
    State.network.moveNode(State.currentSeedId, 0, 0);
  }
  for (const item of nodeItems) {
    if (item.x != null && item.y != null && item.id !== State.currentSeedId) {
      State.network.moveNode(item.id, item.x, item.y);
    }
  }

  // Физика демотирована: детерминированная раскладка финальна и не
  // пересекается — никакого nudgePhysics/стабилизации как решателя. Просто
  // держим её выключенной и подгоняем камеру (как initNetwork).
  State.network.setOptions({ physics: { enabled: false } });
  State.network.fit({ animation: visAnimation(MOTION.flight) });
  clearTimeout(State.physicsTimer);
  State.physicsTimer = null;
}

// ════════════════════════════════════════════════════════════════════════════
// GENIUS PAGE
// ════════════════════════════════════════════════════════════════════════════

export function openGeniusPage(nodeId) {
  const node = State.graphNodes.find(n => n.id === nodeId);
  if (!node) return;
  const url = node.geniusUrl ||
    `https://genius.com/artists/${encodeURIComponent(node.name.replace(/\s+/g, "-").toLowerCase())}`;
  window.open(url, "_blank", "noopener");
}

// ════════════════════════════════════════════════════════════════════════════
// ТЗ-D8 — initGraphOnCanvas (was showGraphView)
// ────────────────────────────────────────────────────────────────────────────
// Раньше это переключало видимость двух "страниц" (.hero ↔ .graph-view) через
// FLIP/View Transitions морфинг. Теперь канвас уже на сцене с самого начала —
// единственное, что нужно сделать при первом успешном поиске: закрыть
// search-modal (тем же morph-переходом — search-wrap всё ещё "улетает" в
// rail-иконку) и погасить decorator-анимацию, раз граф теперь занимает canvas.
// ════════════════════════════════════════════════════════════════════════════
export function initGraphOnCanvas() {
  runHeroGraphTransition(() => {
    forceCloseSearchModal();
    els.status.hidden = false;
  }, "toGraph");
  stopCanvasDecorator();
  // [SF-WEB-19] A graph now occupies the canvas — same moment the decorator
  // above stops, same reasoning: nothing left to onboard.
  clearCanvasState(els.canvasState);
}

// Общий сброс graph-state, используемый и resetCanvasToEmpty(), и
// clearGraphForPathSearch() — порядок операций сохранён таким же, каким он
// был в обеих функциях по отдельности (важно для vis.js: resetGraphState()
// должен отработать до resetHoverState()/hideArtistSidebar()).
function _resetGraphState({ keepRendered = false, clearCache = false, invalidateColors = false } = {}) {
  resetGraphState({ resetHasRendered: !keepRendered });
  if (clearCache) {
    // ТЗ-5: clear the graph cache when the user resets the canvas.
    State._graphCache.clear();
  }
  resetHoverState();
  hideArtistSidebar();
  if (invalidateColors) invalidateColorCache();
}

// [SF-WEB-19] clearCanvas()'s own reset — clears the graph cache too (ТЗ-5:
// "Clear graph" is a full user-initiated reset), but keeps hasRendered
// true: clearCanvas() no longer morphs back to the hero/landing modal
// (body.view-home) — it stays on the graph page with an empty canvas and
// its own onboarding prompt instead, same reasoning as
// clearGraphForPathSearch() below, just also clearing the cache.
export function resetCanvasToEmpty() {
  _resetGraphState({ keepRendered: true, clearCache: true, invalidateColors: true });
}

// ─────────────────────────────────────────────────────────────────────────
// clearGraphForPathSearch — wipes canvas/graph data before drawing a
// six-degrees path result, WITHOUT the side-effects destroyNetwork() has
// that only make sense for a full "reset to hero" (re-triggering the
// hero↔graph morph transition, forcing hasRendered back to false). Path
// search stays inside the already-open graph view — it just needs a blank
// canvas to draw the fresh path onto, instead of the path merging into
// whatever was on screen before (which made results hard to read and left
// stale nodes/edges from earlier exploration on the canvas).
// ─────────────────────────────────────────────────────────────────────────
export function clearGraphForPathSearch() {
  // hasRendered остаётся true — граф-канвас уже на сцене, просто пуст.
  _resetGraphState({ keepRendered: true, invalidateColors: true });
}
