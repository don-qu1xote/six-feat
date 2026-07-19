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
import { nudgePhysics, pokeFastRenderMode } from "./physics.js";
import { isCompareModeActive, handleCompareModeNodeClick, exitCompareMode } from "./compare-mode.js";
import { nearestEdgeAt } from "./edge-render.js";
import { isEdgeHoverSuppressedByZoom } from "./visuals.js";
import { buildEdgeTooltip } from "./tooltips.js";

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

// [SF-WEB-73] Экранный (не мировой) допуск клика/hover по ребру —
// постоянный визуальный "коридор" вокруг НАРИСОВАННОЙ кривой независимо от
// зума, см. _edgeHitToleranceWorld ниже.
const EDGE_HIT_TOLERANCE_PX = 10;

function _edgeHitToleranceWorld() {
  const scale = State.network?.getScale ? State.network.getScale() : 1;
  return EDGE_HIT_TOLERANCE_PX / (scale > 1e-6 ? scale : 1);
}

// [SF-WEB-73] "подсветка не совпадает с тултипом" — обнаружено вживую на
// плотном хабе: нативный hoverEdge vis.js и его же встроенный (title-based)
// тултип стабильно указывали на РАЗНЫЕ рёбра при наведении на одну и ту же
// точку — оба используют СВОЮ внутреннюю геометрию (edges.smooth
// "continuous"), не согласованную ни друг с другом, ни с тем, что реально
// нарисовано (edge-render.js — дуга к хабу для кросс-рёбер). Кликаем/
// наводимся по ТОЙ ЖЕ дуге, что нарисована — params.pointer.canvas
// (стандартное поле vis.js click-события) уже в мировых координатах.
// params.edges остаётся запасным вариантом — в модульных тестах
// State.network — плоский стаб без getPositions/getScale/pointer, там
// пусто в кэше edge-render.js и nearestEdgeAt детерминированно вернёт
// null, откатываясь на params.edges.
function _clickedEdgeId(params) {
  const pt = params.pointer?.canvas;
  if (pt && State.network?.getPositions) {
    const hit = nearestEdgeAt(pt, _edgeHitToleranceWorld());
    if (hit != null) return hit;
  }
  return params.edges?.[0] ?? null;
}

// [SF-WEB-73] Тот же curve-aware хит-тест, но для непрерывного hover —
// заменяет нативные hoverEdge/blurEdge целиком (и цветовую подсветку, И
// тултип — vis.js's built-in title-tooltip для рёбер отключён на уровне
// DataSet, см. suppressNativeEdgeColor). Возвращает undefined СПЕЦИАЛЬНО,
// если под курсором нода — сигнал вызывающей стороне полностью отступить
// и отдать курсор/подсветку нативным hoverNode/blurNode, а не пытаться
// самим погасить/перекрыть то, что они уже показывают.
export function _hoveredEdgeIdAt(domPointer) {
  if (!State.network?.getNodeAt || !State.network?.DOMtoCanvas) return null;
  if (State.network.getNodeAt(domPointer) != null) return undefined;
  const worldPt = State.network.DOMtoCanvas(domPointer);
  return nearestEdgeAt(worldPt, _edgeHitToleranceWorld());
}

// Последний известный hover-id — чтобы не дёргать highlightEdgePair/
// clearHoverHighlight/тултип на каждый мышемув, а только когда целевое
// ребро реально сменилось (тот же принцип, что hoverNode/blurNode у
// vis.js — событие, а не поток).
let _customHoveredEdgeId = null;
let _customTooltipEl = null;

function _hideEdgeTooltip() {
  if (_customTooltipEl) {
    _customTooltipEl.remove();
    _customTooltipEl = null;
  }
}

// [SF-WEB-73] Собственный `.vis-tooltip`-элемент (та же CSS-разметка/класс,
// что и у нативного тултипа vis.js, см. graph-overlay.css) — не заимствует
// DOM-узел vis.js, просто визуально идентичен. Вставляется В els.network,
// так что УЖЕ существующий MutationObserver (tooltips.js::
// ensureTooltipCollisionGuard) подхватывает его для того же
// viewport-collision сдвига, что и нативные тултипы — отдельная копия этой
// логики не нужна.
function _showEdgeTooltip(edgeId, domPointer) {
  _hideEdgeTooltip();
  if (!els.network) return;
  const graphEdge = State.graphEdges.find(e => e.id === edgeId);
  if (!graphEdge) return;
  const wrapper = document.createElement("div");
  wrapper.className = "vis-tooltip";
  wrapper.style.left = `${domPointer.x + 12}px`;
  wrapper.style.top  = `${domPointer.y + 12}px`;
  wrapper.appendChild(buildEdgeTooltip(graphEdge, _currentNameById));
  els.network.appendChild(wrapper);
  _customTooltipEl = wrapper;
}

function _flushHoverEdgeFrame() {
  _hoverEdgeFrameScheduled = false;
  const domPointer = _pendingHoverDomPointer;
  if (!domPointer || isSelectionActive() || State._isDragging || !els.network) return;
  // [SF-WEB-74] На сильном zoom-out большого графа render.js сам выключает
  // нативный interaction.hover (см. _attachZoomThrottle) — это глушит
  // hoverNode/blurNode бесплатно, но с SF-WEB-73 hoverEdge больше НЕ ходит
  // через нативный vis.js-путь (свой DOM mousemove-хит-тест), так что этот
  // же порог нужно проверять здесь явно — иначе рёбра подсвечивались бы
  // даже там, где ноды уже перестали.
  if (isEdgeHoverSuppressedByZoom()) {
    if (_customHoveredEdgeId != null) clearHoverHighlight();
    _customHoveredEdgeId = null;
    els.network.style.cursor = "default";
    _hideEdgeTooltip();
    return;
  }
  const hit = _hoveredEdgeIdAt(domPointer);
  // Нода под курсором — ничего не трогаем (см. _hoveredEdgeIdAt), только
  // сбрасываем собственный трекинг, чтобы уход с ноды на пустой канвас или
  // на другое ребро не считался "ничего не изменилось".
  if (hit === undefined) { _customHoveredEdgeId = null; _hideEdgeTooltip(); return; }
  if (hit === _customHoveredEdgeId) return;
  // [SF-WEB-73] БАГ (найден живьём — hoveredEdgeIds копился, а не
  // переключался): highlightEdgePair ДОБАВЛЯЕТ id в набор подсвеченных
  // рёбер (_hoveredEdgeIds.add), не заменяет — раньше это работало только
  // потому что нативный vis.js ВСЕГДА стрелял blurEdge (→
  // clearHoverHighlight()) перед следующим hoverEdge при смене ребра. Наш
  // собственный переход не гарантирует этого сам по себе — снимаем
  // предыдущее ребро явно, прежде чем красить новое.
  if (_customHoveredEdgeId != null) clearHoverHighlight();
  _customHoveredEdgeId = hit;
  els.network.style.cursor = hit != null ? "pointer" : "default";
  if (hit != null) {
    highlightEdgePair(hit);
    _showEdgeTooltip(hit, domPointer);
  } else {
    clearHoverHighlight();
    _hideEdgeTooltip();
  }
}

// [SF-WEB-73] БАГ (регрессия, найденная в прошлой версии этого же фикса,
// SF-WEB-68/69): первая версия запускала ПОЛНЫЙ хит-тест (nearestEdgeAt —
// перебор всех закэшированных рёбер + сэмплинг кривой на каждое) синхронно
// на КАЖДОЕ сырое mousemove-событие — на плотном графе это ощутимая
// нагрузка на каждое мелкое дрожание мыши, а mousemove может сыпаться чаще,
// чем раз в кадр. Тот же rAF-дебаунс паттерн, что highlight.js уже
// использует для hoverNode — "last write wins": сырой обработчик только
// запоминает последнюю позицию указателя, реальный (дорогой) хит-тест
// выполняется НЕ чаще раза за rAF-тик.
let _pendingHoverDomPointer = null;
let _hoverEdgeFrameScheduled = false;

function _handleCanvasMouseMove(evt) {
  if (!els.network) return;
  const rect = els.network.getBoundingClientRect();
  _pendingHoverDomPointer = { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  if (_hoverEdgeFrameScheduled) return;
  _hoverEdgeFrameScheduled = true;
  requestAnimationFrame(_flushHoverEdgeFrame);
}

function _handleCanvasMouseLeave() {
  _pendingHoverDomPointer = null;
  _hideEdgeTooltip();
  if (_customHoveredEdgeId == null) return;
  _customHoveredEdgeId = null;
  if (!isSelectionActive() && !State._isDragging) clearHoverHighlight();
}

// [SF-WEB-73] attachNetworkEvents реально вызывается заново на каждую
// пересборку vis.Network (render.js::initNetwork/initPathNetwork) —
// net.on(...) корректно переподписывается на новый экземпляр каждый раз, но
// els.network (контейнер-div) один и тот же на весь сеанс: без этого флага
// addEventListener копился бы заново на каждый повторный вызов, и один
// mousemove начал бы дёргать _handleCanvasMouseMove N раз вместо одного на
// N-й пересборке графа. nameById меняется при каждой пересборке —
// держим ЕГО в отдельной module-level переменной (обновляется ниже, в
// attachNetworkEvents), а не в замыкании самого обработчика, который
// регистрируется только один раз.
let _domHoverWired = false;
let _currentNameById = {};

export function attachNetworkEvents(nameById) {
  const net = State.network;
  _currentNameById = nameById || {};

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
    // [SF-WEB-73] Edge id comes from _clickedEdgeId (curve-aware hit test),
    // NOT raw params.edges — see its own header comment.
    if (!params.nodes?.length) {
      const edgeId = _clickedEdgeId(params);
      if (edgeId != null) {
        selectObject("edge", edgeId, nameById);
        return;
      }
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
    // [SF-WEB-74] "неинтуитивно" — doubleClick used to ignore Compare mode
    // entirely, so a double-click mid-pick silently expanded the graph
    // underneath an in-progress first/second pick instead of doing anything
    // compare-related. Same rule the single-click handler already applies
    // above (isCompareModeActive() gate at the very top) — an expand isn't a
    // valid pick action, so it resets the mode instead of running through it.
    if (isCompareModeActive()) { exitCompareMode(); return; }
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
  // [SF-WEB-73] hoverEdge/blurEdge REMOVED — те же нативные события, что и
  // params.edges у клика (см. _clickedEdgeId выше), следят за чужой,
  // внутренне НЕСОГЛАСОВАННОЙ с самой собой кривой vis.js (built-in
  // hoverEdge и built-in title-тултип на плотном хабе указывают на РАЗНЫЕ
  // рёбра для одной и той же точки курсора — воспроизведено вживую, см.
  // edge-render.js::nearestEdgeAt). Заменены на _handleCanvasMouseMove/
  // _handleCanvasMouseLeave (mousemove/mouseleave на els.network, ниже) —
  // один и тот же curve-aware хит-тест для подсветки И тултипа.
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

  // [SF-WEB-73] Замена hoverEdge/blurEdge — см. комментарий над блоком
  // hoverNode/blurNode выше. Отсутствие els.network (юнит-тесты — jsdom без
  // #network в фикстуре) тихо пропускает подписку. _domHoverWired не даёт
  // задублировать подписку на каждую пересборку сети (см. её заголовочный
  // комментарий).
  if (els.network && !_domHoverWired) {
    _domHoverWired = true;
    els.network.addEventListener("mousemove", _handleCanvasMouseMove);
    els.network.addEventListener("mouseleave", _handleCanvasMouseLeave);
  }

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
  // [SF-WEB-54] pokeFastRenderMode() здесь — БЕЗУСЛОВНО, до params.nodes.length
  // раннего выхода ниже: панорамирование вида (params.nodes пустой) — это
  // именно тот "скролл" на большом графе, который проседает по FPS (см.
  // physics.js::pokeFastRenderMode) — узловой drag тоже им покрывается
  // заодно, но не он был основной жалобой.
  net.on("dragStart", function(params) {
    pokeFastRenderMode();
    if (!params.nodes?.length) return;
    State._isDragging = true;
    cancelPendingHover();
    if (State.network) State.network.setOptions({ physics: { enabled: false } });
  });
  // Продолжает "поджигать" fast-render на каждый тик реального перетаскивания
  // (и узла, и панорамирования) — сам poke() почти бесплатен после первого
  // вызова (см. его комментарий), это просто продлевает окно до выхода из
  // fast-режима, пока взаимодействие ещё активно.
  net.on("dragging", function() {
    pokeFastRenderMode();
  });
  net.on("dragEnd", function(params) {
    pokeFastRenderMode();
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
  // [SF-WEB-73] A click lands with our own ambient hover tooltip possibly
  // still showing from just before it (a click doesn't itself move the
  // mouse) — the persistent selection look takes over from here.
  _customHoveredEdgeId = null;
  _hideEdgeTooltip();
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
  // [SF-WEB-73] A selection/clear can land while our own custom edge
  // tooltip/hover tracking is mid-hover (e.g. clicking a different node
  // right after hovering an edge) — nothing else guarantees a fresh
  // mousemove arrives afterward to naturally clean it up.
  _customHoveredEdgeId = null;
  _hideEdgeTooltip();
}
