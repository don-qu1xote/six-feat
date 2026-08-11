import { State, PHYSICS_EXPAND_MS } from "../state/state.js";
import { els } from "../dom/dom.js";
import { showArtistSidebar, showEdgeSidebar, hideArtistSidebar, showToast } from "../ui/index.js";
import { searchArtist } from "../api/api.js";
import {
  highlightNeighborhood,
  highlightEdgePair,
  restoreDefaultColors,
  clearHoverHighlight,
  cancelPendingHover,
  clearSelectedNode,
  clearSelectedEdge,
} from "./highlight.js";
import { nudgePhysics, pokeFastRenderMode } from "./physics.js";
import {
  isCompareModeActive,
  handleCompareModeNodeClick,
  exitCompareMode,
} from "./compare-mode.js";
import { isGameModeActive, handleGameModeNodeClick } from "./game-mode.js";
import { nearestEdgeAt } from "./edge-render.js";
import { isEdgeHoverSuppressedByZoom } from "./visuals.js";
import { buildEdgeTooltip } from "./tooltips.js";

function isSelectionActive() {
  return State.focusedNodeId != null || State.selectedEdgeId != null || isCompareModeActive();
}

const EDGE_HIT_TOLERANCE_PX = 10;

function _edgeHitToleranceWorld() {
  const scale = State.network?.getScale ? State.network.getScale() : 1;
  return EDGE_HIT_TOLERANCE_PX / (scale > 1e-6 ? scale : 1);
}

function _clickedEdgeId(params) {
  const pt = params.pointer?.canvas;
  if (pt && State.network?.getPositions) {
    const hit = nearestEdgeAt(pt, _edgeHitToleranceWorld());
    if (hit != null) return hit;
  }
  return params.edges?.[0] ?? null;
}

export function _hoveredEdgeIdAt(domPointer) {
  if (!State.network?.getNodeAt || !State.network?.DOMtoCanvas) return null;
  if (State.network.getNodeAt(domPointer) != null) return undefined;
  const worldPt = State.network.DOMtoCanvas(domPointer);
  return nearestEdgeAt(worldPt, _edgeHitToleranceWorld());
}

let _customHoveredEdgeId = null;
let _customTooltipEl = null;

function _hideEdgeTooltip() {
  if (_customTooltipEl) {
    _customTooltipEl.remove();
    _customTooltipEl = null;
  }
}

function _showEdgeTooltip(edgeId, domPointer) {
  _hideEdgeTooltip();
  if (!els.network) return;
  const graphEdge = State.graphEdges.find((e) => e.id === edgeId);
  if (!graphEdge) return;
  const wrapper = document.createElement("div");
  wrapper.className = "vis-tooltip";
  wrapper.style.left = `${domPointer.x + 12}px`;
  wrapper.style.top = `${domPointer.y + 12}px`;
  wrapper.appendChild(buildEdgeTooltip(graphEdge, _currentNameById));
  els.network.appendChild(wrapper);
  _customTooltipEl = wrapper;
}

function _flushHoverEdgeFrame() {
  _hoverEdgeFrameScheduled = false;
  const domPointer = _pendingHoverDomPointer;
  if (!domPointer || isSelectionActive() || State._isDragging || !els.network) return;
  if (isGameModeActive()) return;
  if (isEdgeHoverSuppressedByZoom()) {
    if (_customHoveredEdgeId != null) clearHoverHighlight();
    _customHoveredEdgeId = null;
    els.network.style.cursor = "default";
    _hideEdgeTooltip();
    return;
  }
  const hit = _hoveredEdgeIdAt(domPointer);
  if (hit === undefined) {
    _customHoveredEdgeId = null;
    _hideEdgeTooltip();
    return;
  }
  if (hit === _customHoveredEdgeId) return;
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

let _domHoverWired = false;
let _currentNameById = {};

export function attachNetworkEvents(nameById) {
  const net = State.network;
  _currentNameById = nameById || {};

  net.on("click", function (params) {
    if (isGameModeActive()) {
      handleGameModeNodeClick(params);
      return;
    }
    if (isCompareModeActive()) {
      if (params.nodes?.length) handleCompareModeNodeClick(params.nodes[0]);
      else exitCompareMode();
      return;
    }

    const ctrlKey = params.event && (params.event.ctrlKey || params.event.metaKey);

    if (!params.nodes?.length) {
      const edgeId = _clickedEdgeId(params);
      if (edgeId != null) {
        selectObject("edge", edgeId, nameById);
        return;
      }
    }

    if (!params.nodes?.length) {
      clearFocus();
      return;
    }

    const nodeId = params.nodes[0];
    if (ctrlKey) {
      const gn = State.graphNodes.find((n) => n.id === nodeId);
      if (gn && !gn.isSeed) {
        clearTimeout(State._clickTimer);
        State._clickTimer = null;
        State._lastClickNode = null;
        showToast(`Switching seed to ${gn.name}…`, 1800, true);
        searchArtist(gn.name, false, true);
      }
      return;
    }

    clearTimeout(State._clickTimer);
    State._lastClickNode = nodeId;
    State._clickTimer = setTimeout(() => {
      State._clickTimer = null;
      State._lastClickNode = null;
      selectObject("node", nodeId);
    }, 260);
  });

  net.on("doubleClick", function (params) {
    clearTimeout(State._clickTimer);
    State._clickTimer = null;
    State._lastClickNode = null;
    if (isCompareModeActive()) {
      exitCompareMode();
      return;
    }
    if (!params.nodes?.length) return;
    const gn = State.graphNodes.find((n) => n.id === params.nodes[0]);
    if (gn) {
      showToast(`Expanding ${gn.name}…`, 1800, true);
      State._clickedNodeId = gn.id;
      searchArtist(gn.name, true, true);
    }
  });

  net.on("hoverNode", function (params) {
    els.network.style.cursor = "pointer";
    if (isGameModeActive()) return;
    if (!isSelectionActive() && !State._isDragging) highlightNeighborhood(params.node);
  });
  net.on("blurNode", function (params) {
    els.network.style.cursor = "default";
    if (isGameModeActive()) return;
    if (!isSelectionActive() && !State._isDragging) clearHoverHighlight(params.node);
  });

  if (els.network && !_domHoverWired) {
    _domHoverWired = true;
    els.network.addEventListener("mousemove", _handleCanvasMouseMove);
    els.network.addEventListener("mouseleave", _handleCanvasMouseLeave);
  }

  net.on("dragStart", function (params) {
    pokeFastRenderMode();
    if (!params.nodes?.length) return;
    State._isDragging = true;
    cancelPendingHover();
    if (State.network) State.network.setOptions({ physics: { enabled: false } });
  });
  net.on("dragging", function () {
    pokeFastRenderMode();
  });
  net.on("dragEnd", function (params) {
    pokeFastRenderMode();
    if (!State._isDragging) return;
    State._isDragging = false;
    if (params.nodes?.length) nudgePhysics(PHYSICS_EXPAND_MS);
  });
}

export function selectObject(kind, id, nameById) {
  _customHoveredEdgeId = null;
  _hideEdgeTooltip();
  if (kind === "node") {
    setFocus(id);
    showArtistSidebar(id);
  } else if (kind === "edge") {
    showEdgeSidebar(id, nameById || {});
  }
}

export function setFocus(nodeId) {
  State.focusedNodeId = nodeId;
  highlightNeighborhood(nodeId);
}

export function clearFocus() {
  State.focusedNodeId = null;
  hideArtistSidebar();
  restoreDefaultColors();
  clearSelectedNode();
  clearSelectedEdge();
  _customHoveredEdgeId = null;
  _hideEdgeTooltip();
}
