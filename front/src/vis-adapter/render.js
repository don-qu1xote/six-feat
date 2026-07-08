// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/render.js — vis.Network lifecycle: init / refresh / destroy,
//                         plus the Genius-page link and the canvas↔graph
//                         scene transitions (initGraphOnCanvas).
//
// Node/edge visual-object construction lives in visuals.js; tooltip HTML and
// the viewport-collision guard live in tooltips.js. This file is only the
// "wire it all up into a live vis.Network" part: initNetwork/refreshNetwork/
// destroyNetwork/clearGraphForPathSearch.
// ════════════════════════════════════════════════════════════════════════════
import { State, PHYSICS_SETTLE_MS, resetGraphState } from "../state/state.js";
import { els } from "../dom/dom.js";
import { forceCloseSearchModal, hideArtistSidebar } from "../ui/index.js";
import { runHeroGraphTransition } from "../dom/transition.js";
import { stopCanvasDecorator } from "../dom/canvas-decorator.js";
import { resetHoverState, invalidateColorCache } from "./highlight.js";
import { attachNetworkEvents } from "./events.js";
import { scheduleFreeze, nudgePhysics, updateEdgeRenderMode } from "./physics.js";
import { nodeVisual, edgeVisual, networkOptions } from "./visuals.js";
import { ensureTooltipCollisionGuard } from "./tooltips.js";

// ════════════════════════════════════════════════════════════════════════════
// NETWORK LIFECYCLE — init / refresh / destroy
// ════════════════════════════════════════════════════════════════════════════

export function initNetwork(seedId, nameById) {
  const nodeItems = State.graphNodes.map(n => nodeVisual(n));
  const edgeItems = State.graphEdges.map(e => edgeVisual(e, nameById));

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

  updateEdgeRenderMode();
  _attachZoomThrottle();
  attachNetworkEvents(nameById);
  ensureTooltipCollisionGuard();

  State.network.once("stabilizationIterationsDone", () => {
    if (!State.network) return;
    State.network.setOptions({ physics: { enabled: false } });
    // После стабилизации восстанавливаем seed в (0,0) — stabilization могла сдвинуть.
    if (seedId != null) State.network.moveNode(seedId, 0, 0);
    State.network.fit({ animation: { duration: 400, easingFunction: "easeInOutQuad" } });
    clearTimeout(State.physicsTimer);
    State.physicsTimer = null;
  });

  scheduleFreeze(PHYSICS_SETTLE_MS);
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

export function refreshNetwork(nameById, savedPositions) {
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

  const nodeItems = State.graphNodes.map(n => nodeVisual(n));
  const edgeItems = State.graphEdges.map(e => edgeVisual(e, nameById));

  State.nodesDS.clear();
  State.edgesDS.clear();
  State.nodesDS.add(nodeItems);
  State.edgesDS.add(edgeItems);

  for (const n of State.graphNodes) {
    const p = savedPositions[n.id];
    if (p && !n._isNew) State.network.moveNode(n.id, p.x, p.y);
  }

  // Seed всегда в (0,0).
  if (State.currentSeedId != null) {
    State.network.moveNode(State.currentSeedId, 0, 0);
  }

  // Восстанавливаем fixed для expanded нод (они могли стать !fixed после nodeVisual rebuild).
  // Батчим в один update() вместо отдельного вызова на каждую ноду —
  // при большом числе expanded-нод цикл отдельных update() дорог.
  const expandedFixUpdates = [];
  State.expandedNodes.forEach(nodeId => {
    if (nodeId === State.currentSeedId) return;
    const pos = State.network.getPosition(nodeId);
    if (pos) expandedFixUpdates.push({ id: nodeId, fixed: { x: true, y: true } });
  });
  if (expandedFixUpdates.length) State.nodesDS.update(expandedFixUpdates);

  nudgePhysics(PHYSICS_SETTLE_MS);
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
}

// Общий сброс graph-state, используемый и destroyNetwork(), и
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

export function destroyNetwork() {
  _resetGraphState({ clearCache: true });
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
