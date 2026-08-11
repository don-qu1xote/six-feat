import { State, COLOR, PATH_HIGHLIGHT_LEVELS, DIM_LEVELS } from "../state/state.js";
import { roleStyle, placeholderFor } from "../state/helpers.js";
import {
  edgeWidthForWeight,
  seedShadow,
  nodeShadowFor,
  _imageFieldsFor,
  lightenHexColor,
  hexToRgba,
} from "./visuals.js";

let _defaultNodeColors = null;
let _defaultEdgeColors = null;
let _nodeById = null;
let _edgeById = null;
let _edgeIdsByNode = null;
export function invalidateColorCache() {
  _defaultNodeColors = null;
  _defaultEdgeColors = null;
  _nodeById = null;
  _edgeById = null;
  _edgeIdsByNode = null;
}

export function buildDefaultColorCache() {
  _defaultNodeColors = new Map();
  _defaultEdgeColors = new Map();
  _nodeById = new Map();
  _edgeById = new Map();
  _edgeIdsByNode = new Map();
  for (const n of State.graphNodes) {
    _nodeById.set(n.id, n);
    _edgeIdsByNode.set(n.id, []);
    _defaultNodeColors.set(n.id, {
      border: n._dimBorder || "rgba(143,166,201,0.25)",
      shadow: nodeShadowFor(n),
    });
  }
  for (const e of State.graphEdges) {
    _edgeById.set(e.id, e);
    _defaultEdgeColors.set(e.id, roleStyle(e.dominantRole).color);
    if (_edgeIdsByNode.has(e.from)) _edgeIdsByNode.get(e.from).push(e.id);
    if (_edgeIdsByNode.has(e.to)) _edgeIdsByNode.get(e.to).push(e.id);
  }
}

function _getNode(id) {
  if (!_nodeById) buildDefaultColorCache();
  return _nodeById.get(id);
}
function _getEdge(id) {
  if (!_edgeById) buildDefaultColorCache();
  return _edgeById.get(id);
}
function _getEdgeIdsForNode(nodeId) {
  if (!_edgeIdsByNode) buildDefaultColorCache();
  return _edgeIdsByNode.get(nodeId) || [];
}

let _hoverNodeRafId = null;
let _hoverNodeFrameScheduled = false;
let _hoverEdgeRafId = null;

let _hoveredNodeId = null;

let _pendingHoverNodeId = null;

export function resetHoverState() {
  _hoveredNodeId = null;
  _pendingHoverNodeId = null;
  _hoveredEdgeIds.clear();
  _pendingHoverEdgeIds.clear();
  if (_hoverNodeRafId) {
    cancelAnimationFrame(_hoverNodeRafId);
    _hoverNodeRafId = null;
  }
  _hoverNodeFrameScheduled = false;
  if (_hoverEdgeRafId) {
    cancelAnimationFrame(_hoverEdgeRafId);
    _hoverEdgeRafId = null;
  }
  _selectedNodeEdgeIds.clear();
}

export function cancelPendingHover() {
  if (_hoverNodeRafId) {
    cancelAnimationFrame(_hoverNodeRafId);
    _hoverNodeRafId = null;
  }
  _hoverNodeFrameScheduled = false;
  if (_hoverEdgeRafId) {
    cancelAnimationFrame(_hoverEdgeRafId);
    _hoverEdgeRafId = null;
  }
  _pendingHoverNodeId = _hoveredNodeId;
}

function _hoverNodeUpdateFor(graphNode) {
  const accentColor = graphNode._accent || COLOR.pulse;
  const isSeedNode = graphNode.isSeed;
  return {
    id: graphNode.id,
    ..._imageFieldsFor(graphNode),
    color: { border: accentColor, background: COLOR.panel },
    borderWidth: 3,
    shadow: {
      enabled: true,
      color: isSeedNode ? "rgba(94,230,197,0.65)" : `${accentColor}90`,
      size: isSeedNode ? 26 : 20,
      x: 0,
      y: 0,
    },
  };
}

function _scheduleHoverNodeFrame() {
  if (_hoverNodeFrameScheduled) return;
  _hoverNodeFrameScheduled = true;
  _hoverNodeRafId = requestAnimationFrame(() => {
    _hoverNodeFrameScheduled = false;
    _hoverNodeRafId = null;
    _flushHoverNode();
  });
}

function _applyHoverNode(nodeId) {
  if (!State.nodesDS) return;
  _pendingHoverNodeId = nodeId;
  _scheduleHoverNodeFrame();
}

function _flushHoverNode() {
  if (!State.nodesDS) return;
  const oldId = _hoveredNodeId;
  const newId = _pendingHoverNodeId;
  if (oldId === newId) return;
  const nodeUpdates = [];
  const edgeUpdates = [];

  if (oldId != null) {
    const revertUpd = _defaultNodeUpdate(oldId);
    if (revertUpd) nodeUpdates.push(revertUpd);
    for (const edgeId of _hoveredEdgeIds) {
      if (edgeId === State.selectedEdgeId) continue;
      const eu = _defaultEdgeUpdate(edgeId);
      if (eu) edgeUpdates.push(eu);
    }
    _hoveredEdgeIds.clear();
  }

  let paintedId = null;
  if (newId != null && newId !== State.selectedNodeId) {
    const graphNode = _getNode(newId);
    if (graphNode) {
      nodeUpdates.push(_hoverNodeUpdateFor(graphNode));
      paintedId = newId;
      edgeUpdates.push(..._hoverNodeEdgeUpdates(newId));
    }
  }

  if (nodeUpdates.length) {
    try {
      State.nodesDS.update(nodeUpdates);
    } catch (err) {
      console.warn("hover node flush failed", err);
      paintedId = null;
    }
  }
  if (edgeUpdates.length && State.edgesDS) {
    try {
      State.edgesDS.update(edgeUpdates);
    } catch (err) {
      console.warn("hover node edges flush failed", err);
    }
  }

  _hoveredNodeId = paintedId;
}

function _clearHoveredNode() {
  if (_hoveredNodeId == null || !State.nodesDS) return;
  const upd = _defaultNodeUpdate(_hoveredNodeId);
  if (upd) {
    try {
      State.nodesDS.update(upd);
    } catch (err) {
      console.warn("hover node clear failed", err);
    }
  }
  _hoveredNodeId = null;
}

let _hoveredEdgeIds = new Set();
let _pendingHoverEdgeIds = new Set();

export function getHoveredEdgeIds() {
  return _hoveredEdgeIds;
}

export function getSelectedNodeEdgeIds() {
  return _selectedNodeEdgeIds;
}

const HOVER_EDGE_WIDTH_DELTA = 2;

const SELECTED_EDGE_WIDTH_DELTA = 3;

function _isSuppressedEdge(edgeId) {
  return !!(State.suppressedEdgeIds && State.suppressedEdgeIds.has(edgeId));
}

function _hoverEdgeUpdate(edgeId) {
  if (edgeId === State.selectedEdgeId) return null;
  if (_selectedNodeEdgeIds.has(edgeId)) return null;
  const ed = State.edgesDS.get(edgeId);
  if (!ed) return null;
  const edgeColor = ed._brightColor || ed._color || COLOR.pulse;
  const graphEdge = _getEdge(edgeId);
  const weight = graphEdge && Number(graphEdge.weight) > 0 ? Number(graphEdge.weight) : 1;
  const suppressed = _isSuppressedEdge(edgeId);
  return {
    id: edgeId,
    color: suppressed ? { color: "rgba(0,0,0,0)", opacity: 0 } : { color: edgeColor, opacity: 1 },
    width: edgeWidthForWeight(weight) + HOVER_EDGE_WIDTH_DELTA,
  };
}

function _hoverNodeEdgeUpdates(nodeId) {
  const upd = [];
  for (const edgeId of _getEdgeIdsForNode(nodeId)) {
    const u = _hoverEdgeUpdate(edgeId);
    if (!u) continue;
    _hoveredEdgeIds.add(edgeId);
    upd.push(u);
  }
  return upd;
}

function _applyHoverEdge(edgeId) {
  if (!State.edgesDS || !State.network) return;

  _pendingHoverEdgeIds.add(edgeId);
  if (_hoverEdgeRafId != null) return;
  _hoverEdgeRafId = requestAnimationFrame(() => {
    _hoverEdgeRafId = null;
    if (!State.edgesDS) return;

    const ids = [..._pendingHoverEdgeIds];
    _pendingHoverEdgeIds.clear();

    const upd = [];
    for (const edgeId of ids) {
      const u = _hoverEdgeUpdate(edgeId);
      if (!u) continue;
      _hoveredEdgeIds.add(edgeId);
      upd.push(u);
    }
    if (upd.length) {
      try {
        State.edgesDS.update(upd);
      } catch (err) {
        console.warn("hover edge update failed", err);
      }
    }
  });
}

function _defaultEdgeUpdate(edgeId) {
  if (!State.edgesDS) return null;
  if (!_defaultEdgeColors) buildDefaultColorCache();
  const ed = State.edgesDS.get(edgeId);
  if (!ed) return null;
  const color = _defaultEdgeColors.get(edgeId) || ed._color || COLOR.pulse;
  const graphEdge = _getEdge(edgeId);
  const weight = graphEdge ? (Number(graphEdge.weight) > 0 ? Number(graphEdge.weight) : 1) : 1;
  if (_isSuppressedEdge(edgeId)) {
    return {
      id: edgeId,
      color: { color: "rgba(0,0,0,0)", opacity: 0 },
      width: edgeWidthForWeight(weight),
    };
  }
  return { id: edgeId, color: { color, opacity: 0.45 }, width: edgeWidthForWeight(weight) };
}

function _clearHoveredEdge() {
  if (_hoveredEdgeIds.size === 0 || !State.edgesDS) return;

  const upd = [];
  for (const edgeId of _hoveredEdgeIds) {
    if (edgeId === State.selectedEdgeId) continue;
    const u = _defaultEdgeUpdate(edgeId);
    if (u) upd.push(u);
  }
  if (upd.length) {
    try {
      State.edgesDS.update(upd);
    } catch (err) {
      console.warn("hover edge clear failed", err);
    }
  }
  _hoveredEdgeIds.clear();
}

function _selectedEdgeUpdate(edgeId) {
  if (!State.edgesDS) return null;
  const ed = State.edgesDS.get(edgeId);
  if (!ed) return null;
  const graphEdge = _getEdge(edgeId);
  const weight = graphEdge && Number(graphEdge.weight) > 0 ? Number(graphEdge.weight) : 1;
  const suppressed = _isSuppressedEdge(edgeId);
  return {
    id: edgeId,
    color: suppressed ? { color: "rgba(0,0,0,0)", opacity: 0 } : { color: COLOR.neon, opacity: 1 },
    width: edgeWidthForWeight(weight) + SELECTED_EDGE_WIDTH_DELTA,
  };
}

export function selectEdge(edgeId) {
  clearSelectedNode();

  if (State.selectedEdgeId != null && State.selectedEdgeId !== edgeId) {
    const prevUpd = _defaultEdgeUpdate(State.selectedEdgeId);
    State.selectedEdgeId = null;
    if (prevUpd && State.edgesDS) {
      try {
        State.edgesDS.update(prevUpd);
      } catch (err) {
        console.warn("selected edge revert failed", err);
      }
    }
  }

  State.selectedEdgeId = edgeId;
  const upd = _selectedEdgeUpdate(edgeId);
  if (upd && State.edgesDS) {
    try {
      State.edgesDS.update(upd);
    } catch (err) {
      console.warn("select edge update failed", err);
    }
  }
}

export function clearSelectedEdge() {
  if (State.selectedEdgeId == null) return;
  const prevUpd = _defaultEdgeUpdate(State.selectedEdgeId);
  State.selectedEdgeId = null;
  if (prevUpd && State.edgesDS) {
    try {
      State.edgesDS.update(prevUpd);
    } catch (err) {
      console.warn("clear selected edge failed", err);
    }
  }
}

const SELECTED_NODE_BORDER_WIDTH = 4;
const SELECTED_NODE_SHADOW_COLOR = "rgba(255,45,120,0.55)";
const SELECTED_NODE_SHADOW_SIZE = 18;

let _selectedNodeEdgeIds = new Set();

function _selectedNodeUpdate(nodeId) {
  if (!State.nodesDS) return null;
  const graphNode = _getNode(nodeId);
  if (!graphNode) return null;
  return {
    id: nodeId,
    ..._imageFieldsFor(graphNode),
    color: { border: COLOR.neon, background: COLOR.panel },
    borderWidth: SELECTED_NODE_BORDER_WIDTH,
    shadow: {
      enabled: true,
      color: SELECTED_NODE_SHADOW_COLOR,
      size: SELECTED_NODE_SHADOW_SIZE,
      x: 0,
      y: 0,
    },
  };
}

function _selectedNodeEdgeUpdate(edgeId) {
  if (!State.edgesDS) return null;
  if (edgeId === State.selectedEdgeId) return null;
  const ed = State.edgesDS.get(edgeId);
  if (!ed) return null;
  const graphEdge = _getEdge(edgeId);
  const weight = graphEdge && Number(graphEdge.weight) > 0 ? Number(graphEdge.weight) : 1;
  if (_isSuppressedEdge(edgeId)) {
    return {
      id: edgeId,
      color: { color: "rgba(0,0,0,0)", opacity: 0 },
      width: edgeWidthForWeight(weight) + SELECTED_EDGE_WIDTH_DELTA,
    };
  }
  return {
    id: edgeId,
    color: { color: COLOR.neon, opacity: 1 },
    width: edgeWidthForWeight(weight) + SELECTED_EDGE_WIDTH_DELTA,
  };
}

function _defaultNodeUpdate(nodeId) {
  if (!State.nodesDS) return null;
  const graphNode = _getNode(nodeId);
  if (!graphNode) return null;
  const isExpanded = State.expandedNodes.has(graphNode.id);
  const borderWidth = graphNode.isSeed || isExpanded ? 5 : 2;
  const shadow = nodeShadowFor(graphNode);
  const border = graphNode._dimBorder || "rgba(143,166,201,0.25)";
  return {
    id: nodeId,
    ..._imageFieldsFor(graphNode),
    color: { border, background: COLOR.panel },
    borderWidth,
    shadow,
  };
}

function _applySelectedNode(nodeId) {
  const nodeUpd = _selectedNodeUpdate(nodeId);
  if (nodeUpd && State.nodesDS) {
    try {
      State.nodesDS.update(nodeUpd);
    } catch (err) {
      console.warn("select node update failed", err);
    }
  }

  if (!State.edgesDS) return;
  const edgeUpd = [];
  for (const edgeId of _getEdgeIdsForNode(nodeId)) {
    const u = _selectedNodeEdgeUpdate(edgeId);
    if (!u) continue;
    _selectedNodeEdgeIds.add(edgeId);
    edgeUpd.push(u);
  }
  if (edgeUpd.length) {
    try {
      State.edgesDS.update(edgeUpd);
    } catch (err) {
      console.warn("select node edges update failed", err);
    }
  }
}

function _revertSelectedNode() {
  if (State.selectedNodeId == null) return;

  const prevUpd = _defaultNodeUpdate(State.selectedNodeId);
  State.selectedNodeId = null;
  if (prevUpd && State.nodesDS) {
    try {
      State.nodesDS.update(prevUpd);
    } catch (err) {
      console.warn("selected node revert failed", err);
    }
  }

  if (_selectedNodeEdgeIds.size > 0 && State.edgesDS) {
    const edgeUpd = [];
    for (const edgeId of _selectedNodeEdgeIds) {
      const u = _defaultEdgeUpdate(edgeId);
      if (u) edgeUpd.push(u);
    }
    if (edgeUpd.length) {
      try {
        State.edgesDS.update(edgeUpd);
      } catch (err) {
        console.warn("selected node edges revert failed", err);
      }
    }
  }
  _selectedNodeEdgeIds.clear();
}

export function selectNode(nodeId) {
  clearSelectedEdge();

  if (State.selectedNodeId != null && State.selectedNodeId !== nodeId) {
    _revertSelectedNode();
  }

  State.selectedNodeId = nodeId;
  _applySelectedNode(nodeId);
}

export function clearSelectedNode() {
  _revertSelectedNode();
}

const COMPARE_ENDPOINT_BORDER_WIDTH = 5;
const COMPARE_ENDPOINT_SHADOW_SIZE = 22;
const COMPARE_ENDPOINT_COLOR = { first: () => COLOR.amber, second: () => COLOR.signal };

let _compareEndpointNodeIds = new Set();

function _compareEndpointUpdate(nodeId, role) {
  if (!State.nodesDS) return null;
  const graphNode = _getNode(nodeId);
  if (!graphNode) return null;
  const accent = COMPARE_ENDPOINT_COLOR[role]();
  return {
    id: nodeId,
    ..._imageFieldsFor(graphNode),
    color: { border: accent, background: COLOR.panel },
    borderWidth: COMPARE_ENDPOINT_BORDER_WIDTH,
    shadow: {
      enabled: true,
      color: hexToRgba(accent, 0.6),
      size: COMPARE_ENDPOINT_SHADOW_SIZE,
      x: 0,
      y: 0,
    },
  };
}

export function markCompareEndpoint(nodeId, role) {
  const upd = _compareEndpointUpdate(nodeId, role);
  if (!upd) return;
  try {
    State.nodesDS.update(upd);
  } catch (err) {
    console.warn("compare endpoint mark failed", err);
  }
  _compareEndpointNodeIds.add(nodeId);
}

export function clearCompareEndpoints() {
  if (!_compareEndpointNodeIds.size || !State.nodesDS) {
    _compareEndpointNodeIds.clear();
    return;
  }
  const updates = [];
  for (const id of _compareEndpointNodeIds) {
    const u = _defaultNodeUpdate(id);
    if (u) updates.push(u);
  }
  _compareEndpointNodeIds.clear();
  if (updates.length) {
    try {
      State.nodesDS.update(updates);
    } catch (err) {
      console.warn("compare endpoint clear failed", err);
    }
  }
}

export function clearHoverHighlight(blurredNodeId) {
  if (_hoverEdgeRafId) {
    cancelAnimationFrame(_hoverEdgeRafId);
    _hoverEdgeRafId = null;
  }
  _pendingHoverEdgeIds.clear();

  if (blurredNodeId !== undefined) {
    if (blurredNodeId !== _pendingHoverNodeId) return;
    if (_pendingHoverNodeId == null) return;
    _pendingHoverNodeId = null;
    _scheduleHoverNodeFrame();
    return;
  }

  if (_hoveredEdgeIds.size > 0) _clearHoveredEdge();
  if (_pendingHoverNodeId != null) {
    _pendingHoverNodeId = null;
    _scheduleHoverNodeFrame();
  }
}

function _applyDefault() {
  if (!State.nodesDS || !State.edgesDS) return;
  if (_hoverNodeRafId) {
    cancelAnimationFrame(_hoverNodeRafId);
    _hoverNodeRafId = null;
  }
  _hoverNodeFrameScheduled = false;
  if (_hoverEdgeRafId) {
    cancelAnimationFrame(_hoverEdgeRafId);
    _hoverEdgeRafId = null;
  }
  _pendingHoverNodeId = null;
  _pendingHoverEdgeIds.clear();

  let hadHover = false;
  if (_hoveredNodeId != null) {
    _clearHoveredNode();
    hadHover = true;
  }
  if (_hoveredEdgeIds.size > 0) {
    _clearHoveredEdge();
    hadHover = true;
  }
  if (hadHover) return;

  if (!_defaultNodeColors) buildDefaultColorCache();

  const nU = [],
    eU = [];
  _defaultNodeColors.forEach(({ border, shadow }, id) => {
    if (id === State.selectedNodeId) return;
    const graphNode = _getNode(id);
    nU.push({
      id,
      ..._imageFieldsFor(graphNode),
      color: { border, background: COLOR.panel },
      opacity: DIM_LEVELS.off,
      shadow,
    });
  });
  _defaultEdgeColors.forEach((color, id) => {
    if (id === State.selectedEdgeId) return;
    if (_selectedNodeEdgeIds.has(id)) return;
    eU.push(
      _isSuppressedEdge(id)
        ? { id, color: { color: "rgba(0,0,0,0)", opacity: 0 } }
        : { id, color: { color, opacity: 0.45 } },
    );
  });
  if (nU.length) State.nodesDS.update(nU);
  if (eU.length) State.edgesDS.update(eU);
}

export function recolorInPlace(_nameById) {
  if (!State.nodesDS || !State.edgesDS) return;

  const nU = State.graphNodes.map((n) => {
    const isExpanded = State.expandedNodes.has(n.id);
    const accent = n._accent;
    const dimBorder = n._dimBorder || "rgba(143,166,201,0.25)";
    const borderColor = isExpanded ? accent : dimBorder;

    let shadow;
    if (n.isSeed) shadow = seedShadow();
    else if (isExpanded) shadow = { enabled: true, color: `${accent}30`, size: 12, x: 0, y: 0 };
    else shadow = { enabled: false };

    const imageUpdate = n.imageUrl
      ? {}
      : {
          image: placeholderFor(n.name, n.isSeed),
          brokenImage: placeholderFor(n.name, n.isSeed),
        };

    return {
      id: n.id,
      _accent: accent,
      _dimBorder: dimBorder,
      color: {
        border: borderColor,
        background: COLOR.panel,
        hover: { border: accent, background: COLOR.panel },
      },
      shadow,
      ...imageUpdate,
    };
  });

  const eU = State.graphEdges.map((e) => {
    const color = roleStyle(e.dominantRole || "primary").color;
    const brightColor = lightenHexColor(color, 0.35);
    return {
      id: e.id,
      color: _isSuppressedEdge(e.id)
        ? { color: "rgba(0,0,0,0)", opacity: 0 }
        : { color, opacity: 0.4 },
      _color: color,
      _brightColor: brightColor,
    };
  });

  if (nU.length) State.nodesDS.update(nU);
  if (eU.length) State.edgesDS.update(eU);
}

function isNodeExpanded(nodeId) {
  return State.expandedNodes && State.expandedNodes.has(nodeId);
}

function isEdgeInExpandedTree(fromId, toId) {
  if (!State.expandedNodes || State.expandedNodes.size === 0) return false;
  return State.expandedNodes.has(fromId) && State.expandedNodes.has(toId);
}

function getNodeHighlightLevel(nodeId, pathSet) {
  if (pathSet.has(nodeId)) return "onPath";
  if (isNodeExpanded(nodeId)) return "expandedOffPath";
  return "neverTouched";
}

function getEdgeHighlightLevel(fromId, toId, pathEdgesSet) {
  const lo = Math.min(fromId, toId);
  const hi = Math.max(fromId, toId);
  const edgeKey = `${lo}_${hi}`;

  if (pathEdgesSet.has(edgeKey)) return "onPath";
  if (isEdgeInExpandedTree(fromId, toId)) return "expandedOffPath";
  return "neverTouched";
}

function _applyPath(path, { dim = true } = {}) {
  if (!State.nodesDS || !State.edgesDS || !path) return;

  const pathSet = new Set(path);
  const pathEdges = new Set();

  for (let i = 0; i < path.length - 1; i++) {
    const lo = Math.min(path[i], path[i + 1]);
    const hi = Math.max(path[i], path[i + 1]);
    pathEdges.add(`${lo}_${hi}`);
  }

  const nodeIds = State.nodesDS.getIds();
  const nU = nodeIds.map((id) => {
    const level = getNodeHighlightLevel(id, pathSet);
    const graphNode = _getNode(id);

    if (!dim && level === "neverTouched") {
      return {
        id,
        ..._imageFieldsFor(graphNode),
        color: {
          border: graphNode?._dimBorder || "rgba(143,166,201,0.25)",
          background: COLOR.panel,
        },
        opacity: DIM_LEVELS.off,
        borderWidth: graphNode?.isSeed ? 5 : 2,
      };
    }

    const config = PATH_HIGHLIGHT_LEVELS[level];
    let borderColor;
    if (level === "onPath") borderColor = COLOR.neon;
    else if (level === "expandedOffPath") borderColor = "rgba(94,230,197,0.6)";
    else borderColor = "rgba(40,48,68,0.08)";

    return {
      id,
      ..._imageFieldsFor(graphNode),
      color: { border: borderColor, background: COLOR.panel },
      opacity: config.opacity,
      borderWidth: config.width,
    };
  });

  const edgeIds = State.edgesDS.getIds();
  const eU = edgeIds.map((id) => {
    const edgeObj = _getEdge(id);

    if (_isSuppressedEdge(id)) {
      return { id, color: { color: "rgba(0,0,0,0)", opacity: 0 }, width: 1 };
    }

    if (!edgeObj) {
      return { id, color: { color: "rgba(40,48,68,0.02)", opacity: 0.02 }, width: 1 };
    }

    const level = getEdgeHighlightLevel(edgeObj.from, edgeObj.to, pathEdges);

    if (!dim && level === "neverTouched") {
      const rs = roleStyle(edgeObj.dominantRole);
      return {
        id,
        color: { color: rs.color, opacity: 0.4 },
        width: edgeWidthForWeight(edgeObj.weight),
      };
    }

    const config = PATH_HIGHLIGHT_LEVELS[level];
    let edgeColor = "rgba(40,48,68,0.02)";
    if (level === "onPath") edgeColor = COLOR.neon;
    else if (level === "expandedOffPath") edgeColor = "rgba(94,230,197,0.5)";

    return {
      id,
      color: { color: edgeColor, opacity: config.edgeOpacity },
      width: config.edgeWidth,
    };
  });

  State.nodesDS.update(nU);
  State.edgesDS.update(eU);
}

export function applyDimState(mode, focusIds = {}) {
  switch (mode) {
    case "hover":
      return _applyHoverNode(focusIds.nodeId);
    case "edge":
      return _applyHoverEdge(focusIds.edgeId);
    case "path":
      return _applyPath(focusIds.path, { dim: focusIds.dim !== false });
    case "default":
    default:
      return _applyDefault();
  }
}

export function highlightNeighborhood(nodeId) {
  return applyDimState("hover", { nodeId });
}
export function highlightEdgePair(edgeId) {
  return applyDimState("edge", { edgeId });
}
export function highlightPath(path, { dim = true } = {}) {
  return applyDimState("path", { path, dim });
}
export function restoreDefaultColors() {
  return applyDimState("default");
}
