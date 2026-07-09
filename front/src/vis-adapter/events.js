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
  cancelPendingHover
} from "./highlight.js";
import { nudgePhysics } from "./physics.js";

// Порог числа рёбер, при котором на hover перестаём подсвечивать рёбра
// (см. hoverEdge ниже) — держится в синхроне с тем же порогом в render.js.
const FAST_RENDER_EDGE_THRESHOLD = 150;

export function attachNetworkEvents(nameById) {
  const net = State.network;

  net.on("click", function(params) {
    const ctrlKey = params.event && (params.event.ctrlKey || params.event.metaKey);

    if (params.edges?.length > 0 && !params.nodes?.length) {
      showEdgeSidebar(params.edges[0], nameById);
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
      setFocus(nodeId);
      showArtistSidebar(nodeId);
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
    if (!State.focusedNodeId && !State._isDragging) highlightNeighborhood(params.node);
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
    if (!State.focusedNodeId && !State._isDragging) highlightEdgePair(params.edge);
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
    if (!State.focusedNodeId && !State._isDragging) clearHoverHighlight(params.node);
  });
  net.on("blurEdge",  function() {
    els.network.style.cursor = "default";
    if (!State.focusedNodeId && !State._isDragging) clearHoverHighlight();
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
// FOCUS — set/clear the "pinned" highlighted node (distinct from hover)
// ════════════════════════════════════════════════════════════════════════════

export function setFocus(nodeId) {
  State.focusedNodeId = nodeId;
  highlightNeighborhood(nodeId);
}

export function clearFocus() {
  State.focusedNodeId = null;
  hideArtistSidebar();
  restoreDefaultColors();
}
