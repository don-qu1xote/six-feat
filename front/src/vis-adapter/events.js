// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/events.js — attachNetworkEvents: click / double-click / hover /
//                         drag handlers wired onto the vis.Network instance,
//                         plus setFocus/clearFocus (thin wrappers around the
//                         highlight module used by ui/index.js's node-search etc.)
// ════════════════════════════════════════════════════════════════════════════
import { State, PHYSICS_EXPAND_MS } from "../state/state.js";
import { els } from "../dom/dom.js";
import { showArtistSidebar, showEdgeSidebar, hideArtistSidebar, showToast } from "../ui/index.js";
import { searchArtist } from "../api/api.js";
import {
  highlightNeighborhood, highlightEdgePair, restoreDefaultColors, clearHoverHighlight,
  cancelPendingHover, clearSelectedNode, clearSelectedEdge
} from "./highlight.js";
import { nudgePhysics } from "./physics.js";
import { isCompareModeActive, handleCompareModeNodeClick, exitCompareMode } from "./compare-mode.js";

// Порог числа рёбер, при котором на hover перестаём подсвечивать рёбра
// (см. hoverEdge ниже) — держится в синхроне с тем же порогом в render.js.
const FAST_RENDER_EDGE_THRESHOLD = 150;

// [SF-WEB-28] Whether anything is currently pinned/selected — a node
// (State.focusedNodeId, set by setFocus) OR an edge (State.selectedEdgeId,
// set by selectEdge). Ambient hover elsewhere on the canvas is suppressed
// in either case, so a node selection and an edge selection behave
// identically w.r.t. hover: previously only focusedNodeId gated the four
// hoverNode/hoverEdge/blurNode/blurEdge guards below, so hovering other
// nodes/edges kept disturbing the view while an edge (but not a node) was
// selected.
// [SF-WEB-47] Compare mode's own first/second markers are the same kind of
// persistent, deliberately-placed color as a selection — ambient hover
// should stay out of their way for the same reason.
function isSelectionActive() {
  return State.focusedNodeId != null || State.selectedEdgeId != null || isCompareModeActive();
}

export function attachNetworkEvents(nameById) {
  const net = State.network;

  net.on("click", function(params) {
    // [SF-WEB-47] Compare mode fully takes over click semantics while
    // active — a node click picks first/second instead of going through
    // selectObject; ctrl+click seed switch and the double-click-vs-click
    // debounce below are both out of scope while picking, same as this
    // handler already ignores most of itself during a drag. Anything else
    // clicked (an edge, or empty canvas) isn't a valid pick target — [fix]
    // that used to just silently do nothing, reported as "stuck" in the
    // mode with no visible way out short of Esc/the toggle; exiting here
    // instead gives every click a defined outcome.
    if (isCompareModeActive()) {
      if (params.nodes?.length) handleCompareModeNodeClick(params.nodes[0]);
      else exitCompareMode();
      return;
    }

    const ctrlKey = params.event && (params.event.ctrlKey || params.event.metaKey);

    // [SF-WEB-28] Edge click is otherwise identical to a node click (both
    // go through selectObject below) — the only asymmetry that remains is
    // debounce, and that's deliberate: it exists solely to disambiguate a
    // node click from the first half of a double-click (expand), a
    // distinction that doesn't exist for edges (no edge double-click).
    if (params.edges?.length > 0 && !params.nodes?.length) {
      selectObject("edge", params.edges[0], nameById);
      return;
    }

    if (!params.nodes?.length) { clearFocus(); return; }

    const nodeId = params.nodes[0];
    // Баг/фича: ctrl(cmd)+клик теперь заменяет seed кликнутой нодой вместо
    // открытия Genius — "Open on Genius" уже есть отдельной кнопкой в
    // сайдбаре артиста, так что этот шорткат был избыточен с тем же
    // жестом, а смена seed'а такого быстрого пути раньше не имела вообще.
    if (ctrlKey) {
      const gn = State.graphNodes.find(n => n.id === nodeId);
      if (gn && !gn.isSeed) {
        clearTimeout(State._clickTimer);
        State._clickTimer    = null;
        State._lastClickNode = null;
        showToast(`Switching seed to ${gn.name}…`, 1800, true);
        searchArtist(gn.name, false, true);
      }
      return;
    }

    clearTimeout(State._clickTimer);
    State._lastClickNode = nodeId;
    State._clickTimer = setTimeout(() => {
      State._clickTimer    = null;
      State._lastClickNode = null;
      selectObject("node", nodeId);
    }, 260);
  });

  net.on("doubleClick", function(params) {
    clearTimeout(State._clickTimer);
    State._clickTimer    = null;
    State._lastClickNode = null;
    if (!params.nodes?.length) return;
    const gn = State.graphNodes.find(n => n.id === params.nodes[0]);
    if (gn) {
      showToast(`Expanding ${gn.name}…`, 1800, true);
      State._clickedNodeId = gn.id;
      searchArtist(gn.name, true, true);
    }
  });

  net.on("hoverNode", function(params) {
    els.network.style.cursor = "pointer";
    if (!isSelectionActive() && !State._isDragging) highlightNeighborhood(params.node);
  });
  net.on("hoverEdge", function(params) {
    els.network.style.cursor = "pointer";
    // ТЗ (производительность, согласовано): на очень больших графах
    // (>FAST_RENDER_EDGE_THRESHOLD рёбер) не подсвечиваем рёбра при
    // hover — hoverConnectedEdges шлёт по hoverEdge на КАЖДОЕ ребро
    // наведённой ноды, и на графах с тысячами рёбер это ощутимая
    // дополнительная нагрузка на каждое движение мыши. Подсветка самой
    // ноды (see hoverNode выше) остаётся — отключается только подсветка
    // рёбер, визуально на маленьких/средних графах ничего не меняется.
    if (State.graphEdges.length > FAST_RENDER_EDGE_THRESHOLD) return;
    if (!isSelectionActive() && !State._isDragging) highlightEdgePair(params.edge);
  });
  net.on("blurNode",  function(params) {
    els.network.style.cursor = "default";
    // БАГ (положение подсвеченной ноды не совпадает с курсором, стабильно
    // воспроизводится в плотных областях графа): blurNode/hoverNode для
    // ОДНОГО перехода A→B приходят синхронно и в правильном порядке
    // (blur(A), затем hover(B)), но в плотном кластере курсор за один кадр
    // может пересечь несколько нод — тогда несколько пар blur/hover
    // приходят одна за другой, каждая синхронно, ДО того как rAF первой
    // hover-подсветки успевает выполниться. clearHoverHighlight() раньше
    // не знала, ДЛЯ какой ноды пришёл blur — она просто откатывала то, что
    // сейчас лежит в _hoveredNodeId. Если к моменту обработки такого
    // (устаревшего) blur свежий hover для ДРУГОЙ ноды уже успел
    // применить свою подсветку (rAF выполнился и переставил
    // _hoveredNodeId), устаревший blur всё равно откатывал ЕЁ — снимал
    // подсветку с ноды, которую курсор реально сейчас наводит, оставляя
    // графически подсвеченной ту, что была под курсором раньше (визуально
    // "не там, где курсор"). Фикс: передаём params.node дальше и откатываем
    // только если он всё ещё совпадает с _hoveredNodeId — иначе это
    // устаревший blur для уже вытесненной ноды, трогать нечего.
    if (!isSelectionActive() && !State._isDragging) clearHoverHighlight(params.node);
  });
  net.on("blurEdge",  function() {
    els.network.style.cursor = "default";
    if (!isSelectionActive() && !State._isDragging) clearHoverHighlight();
  });

  // Баг "при быстрой тряске граф всё ещё подвисает": hoverConnectedEdges
  // держит hover/blur включёнными для всех рёбер узла всё время перетаскивания
  // — при быстром "трясении" мышью это десятки hoverEdge/blurEdge событий в
  // секунду. Но dragStart/dragEnd в vis.js стреляют на ЛЮБОЕ нажатие мыши на
  // канвасе (включая обычный клик по ноде и панорамирование пустого места),
  // а не только на настоящий drag ноды — если глушить hover по факту самого
  // dragStart, обычный клик по ноде мог оставлять её ни подсвеченной, ни
  // сброшенной (blur не успевал долететь до снятия флага). Поэтому включаем
  // подавление только когда drag реально тащит узел (params.nodes.length>0),
  // и физику морозим тоже только в этом случае — панорамирование вида саму
  // физику не трогает и не должно её выключать.
  net.on("dragStart", function(params) {
    if (!params.nodes?.length) return;
    State._isDragging = true;
    cancelPendingHover();
    if (State.network) State.network.setOptions({ physics: { enabled: false } });
  });
  net.on("dragEnd", function(params) {
    if (!State._isDragging) return;
    State._isDragging = false;
    // Однонодовый drag (не панорамирование вида) — мягко досчитываем физику,
    // чтобы граф осел вокруг новой позиции узла.
    if (params.nodes?.length) nudgePhysics(PHYSICS_EXPAND_MS);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SELECTION — selectObject(kind, id): the one entry point for "select this
// node" / "select this edge" (SF-WEB-28). Both go through the same shape:
// apply the persistent marker (selectNode/selectEdge, in highlight.js —
// which also enforce "exactly one of node/edge selected" by clearing the
// other), then show the matching companion-panel context (SF-WEB-12).
// showArtistSidebar() itself calls selectNode(); showEdgeSidebar() itself
// calls selectEdge() — so node-search (ui/modals.js::_nsSelect) and the
// a11y node list (ui/graph-a11y-list.js), which call showArtistSidebar
// directly without going through the canvas click handler at all, get the
// exact same persistent marker + mutual exclusion for free.
// ════════════════════════════════════════════════════════════════════════════

export function selectObject(kind, id, nameById) {
  if (kind === "node") {
    setFocus(id);
    showArtistSidebar(id);
  } else if (kind === "edge") {
    showEdgeSidebar(id, nameById || {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FOCUS — set/clear the "pinned" highlighted node (distinct from hover)
// ════════════════════════════════════════════════════════════════════════════

export function setFocus(nodeId) {
  State.focusedNodeId = nodeId;
  highlightNeighborhood(nodeId);
}

// Clears whichever of {selected node, selected edge} is currently active —
// same outcome regardless of which one it was (SF-WEB-28 requirement 4:
// background click / Escape / clearFocus drop any selection identically).
// clearSelectedNode()/clearSelectedEdge() are each no-ops when their own
// field is already null, so calling both unconditionally is safe and
// doesn't depend on hideArtistSidebar's internals happening to also clear
// the edge marker.
export function clearFocus() {
  State.focusedNodeId = null;
  hideArtistSidebar();
  restoreDefaultColors();
  clearSelectedNode();
  clearSelectedEdge();
}
