import { State, COLOR } from "../state/state.js";
import { placeholderFor, proxiedImageUrl, roleStyle } from "../state/helpers.js";
import { buildNodeTooltip, buildEdgeTooltip } from "./tooltips.js";

export function hexToRgba(hex, alpha) {
  hex = hex.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function seedShadow() {
  return { enabled: true, color: hexToRgba(COLOR.signal, 0.55), size: 26, x: 0, y: 0 };
}

export function nodeShadowFor(nodeData) {
  if (nodeData.isSeed) return seedShadow();
  const isExpired = nodeData.isExpired || nodeData.dataExpired || false;
  if (isExpired) return { enabled: false };
  const isExpanded = State.expandedNodes.has(nodeData.id);
  const domRole = nodeData._dominantRole || "primary";
  const accent = roleStyle(domRole).color;
  return isExpanded
    ? { enabled: true, color: `${accent}30`, size: 12, x: 0, y: 0 }
    : { enabled: true, color: `${accent}22`, size: 6, x: 0, y: 0 };
}

export function lightenHexColor(hex, factor = 0.4) {
  hex = hex.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const newR = Math.min(255, Math.round(r + (255 - r) * factor));
  const newG = Math.min(255, Math.round(g + (255 - g) * factor));
  const newB = Math.min(255, Math.round(b + (255 - b) * factor));
  return (
    "#" + [newR, newG, newB].map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join("")
  );
}

export const FIXED_NODE_RADIUS = 22;

export const EXPIRED_NODE_RADIUS = 18;

export const HUB_RADIUS = 36;

export function computeNodeSizes() {
  if (!State.graphNodes.length) return;

  const weightMap = new Map();
  for (const e of State.graphEdges) {
    const w = e.collaboration_count ?? (e.weight || 1);
    weightMap.set(e.from, (weightMap.get(e.from) || 0) + w);
    weightMap.set(e.to, (weightMap.get(e.to) || 0) + w);
  }

  for (const n of State.graphNodes) {
    const w = n._backendWeight || weightMap.get(n.id) || 1;
    n.totalWeight = w;
    n.computedRadius = FIXED_NODE_RADIUS;
  }
}

export function _imageFieldsFor(graphNode) {
  if (!graphNode) return {};
  const image = graphNode.imageUrl
    ? proxiedImageUrl(graphNode.imageUrl)
    : placeholderFor(graphNode.name, graphNode.isSeed);
  return {
    shape: "circularImage",
    image,
    brokenImage: placeholderFor(graphNode.name, graphNode.isSeed),
  };
}

export function nodeVisual(nodeData) {
  const { id, name, imageUrl, isSeed, computedRadius } = nodeData;

  const isExpanded = State.expandedNodes.has(id);
  const isExpired = nodeData.isExpired || nodeData.dataExpired || false;

  const domRole = nodeData._dominantRole || (isSeed ? "featured" : "primary");
  const rs = roleStyle(domRole);
  // [SF-API-20] Аватарка идёт через image-proxy, а не напрямую с CDN Genius.
  // Раньше её качали дважды: холст — с CDN, а photo-color.js — ещё раз через
  // прокси, ради пикселей для среднего цвета. Теперь загрузка одна, и цвет
  // считается на сервере ровно там, где эти байты уже есть.
  const image = imageUrl ? proxiedImageUrl(imageUrl) : placeholderFor(name, isSeed);

  let radius;
  if (isSeed || isExpanded) {
    radius = HUB_RADIUS;
  } else if (isExpired) {
    radius = EXPIRED_NODE_RADIUS;
  } else {
    radius = computedRadius || FIXED_NODE_RADIUS;
  }

  let accent, dimBorder;

  if (isSeed) {
    accent = COLOR.signal;
    dimBorder = "rgba(94,230,197,0.45)";
  } else if (isExpired) {
    accent = COLOR.warn;
    dimBorder = `${COLOR.warn}40`;
  } else {
    accent = rs.color;
    dimBorder = `${rs.color}40`;
  }

  const borderCol = isExpanded ? accent : dimBorder;

  let borderWidth, borderWidthSelected;
  if (isSeed || isExpanded) {
    borderWidth = 5;
    borderWidthSelected = 7;
  } else {
    borderWidth = 2;
    borderWidthSelected = 3;
  }

  const opacity = isExpired ? 0.6 : 1.0;

  const shadow = nodeShadowFor(nodeData);

  const mass = isSeed ? 1 : isExpanded ? 8 : 1;

  return {
    id,
    _accent: accent,
    _dimBorder: dimBorder,
    shape: "circularImage",
    image,
    brokenImage: placeholderFor(name, isSeed),
    size: radius,
    borderWidth,
    borderWidthSelected,
    ...(isExpired ? { shapeProperties: { borderDashes: [4, 3] } } : {}),
    color: {
      border: borderCol,
      background: COLOR.panel,
      highlight: { border: COLOR.paper, background: COLOR.panel },
      hover: { border: accent, background: COLOR.panel },
    },
    title: buildNodeTooltip({ ...nodeData, computedRadius: radius }),
    shadow,
    opacity,
    fixed: isSeed || (isExpanded && !nodeData._isNew) ? { x: true, y: true } : false,
    mass,
    x: isSeed ? 0 : undefined,
    y: isSeed ? 0 : undefined,
  };
}

export function edgeWidthForWeight(weight) {
  const w = Number(weight) > 0 ? Number(weight) : 1;
  return Math.min(1 + Math.sqrt(w) * 1.15, 6);
}

export function edgeVisual(e, nameById) {
  const weight = Number(e.weight) > 0 ? Number(e.weight) : 1;
  const role = e.dominantRole || "primary";
  const rs = roleStyle(role);
  const dashes = edgeDashPattern(e.edgeStyle);
  const brightColor = lightenHexColor(rs.color, 0.35);

  const width = edgeWidthForWeight(weight);

  return {
    id: e.id,
    from: e.from,
    to: e.to,
    width,
    dashes,
    title: buildEdgeTooltip(e, nameById),
    color: {
      color: rs.color,
      opacity: 0.4,
      inherit: false,
      hover: { color: brightColor, opacity: 0.9 },
      highlight: { color: brightColor, opacity: 1.0 },
    },
    _role: role,
    _color: rs.color,
    _brightColor: brightColor,
  };
}

// [SF-WEB-77] Здесь был resolveEdgeDominantRole — он собирал роли из сырых
// collaborations, подмешивал серверные dominant_role/role_priority и выбирал
// сильнейшую. То есть заново выводил ровно то, что сервер уже вычислил и
// прислал (graph_handler.cpp: EdgeAgg::dominant_role). Роль ребра теперь
// читается из состояния ребра, куда её кладёт buildEdgeState.

// Серверная строка стиля (EdgeStyleForRole: featured -> solid, producer ->
// dashed, остальные -> dotted) в пунктир vis-network. Единственное место,
// где строка превращается в оформление.
const EDGE_DASH = {
  solid: false,
  dashed: [8, 6],
  dotted: [2, 6],
};

export function edgeDashPattern(edgeStyle) {
  const pattern = EDGE_DASH[edgeStyle];
  return pattern === undefined ? false : pattern;
}

export const LARGE_GRAPH_NODE_THRESHOLD = 150;

export const FAST_RENDER_EDGE_THRESHOLD = 150;

export function isEdgeHoverSuppressedByZoom() {
  const net = State.network;
  if (!net || typeof net.getScale !== "function") return false;
  if (State.graphEdges.length <= FAST_RENDER_EDGE_THRESHOLD) return false;
  return net.getScale() < 0.5;
}

export function networkOptions() {
  const physics = {
    enabled: false,
    solver: "barnesHut",
    barnesHut: {
      gravitationalConstant: -6000,
      centralGravity: 0.05,
      springLength: 170,
      springConstant: 0.04,
      damping: 0.88,
      avoidOverlap: 1.0,
    },
    stabilization: { enabled: false },
    timestep: 0.35,
    adaptiveTimestep: true,
    maxVelocity: 60,
    minVelocity: 0.8,
  };

  return {
    autoResize: true,
    layout: { improvedLayout: false },
    nodes: { shapeProperties: { interpolation: true, useBorderWithImage: true }, chosen: false },
    edges: {
      color: { inherit: false },
      hoverWidth: 1.4,
      selectionWidth: 2,
      chosen: false,
      smooth: { enabled: true, type: "continuous", roundness: 0.45 },
    },
    interaction: {
      hover: true,
      dragNodes: true,
      dragView: true,
      zoomView: true,
      tooltipDelay: 120,
      hoverConnectedEdges: true,
      hideEdgesOnDrag: false,
      hideEdgesOnZoom: false,
      navigationButtons: false,
      keyboard: { enabled: true, bindToWindow: false },
      multiselect: false,
    },
    physics,
  };
}
