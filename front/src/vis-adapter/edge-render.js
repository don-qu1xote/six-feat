import { State, COLOR } from "../state/state.js";
import { roleStyle } from "../state/helpers.js";
import { resolveEdgeDominantRole, lightenHexColor, edgeWidthForWeight } from "./visuals.js";
import { getHoveredEdgeIds, getSelectedNodeEdgeIds } from "./highlight.js";

const CROSS_BOW_FRACTION = 0.28;
const INTRA_BOW = 0.12;

const BASE_OPACITY = 0.38;
const HOVER_OPACITY = 0.85;
const SELECT_OPACITY = 1.0;
const PATH_OPACITY = 0.95;

const INVISIBLE_EDGE_COLOR = "rgba(0,0,0,0)";
export function suppressNativeEdgeColor(edgeItem) {
  const invisible = { color: INVISIBLE_EDGE_COLOR, opacity: 0 };
  return {
    ...edgeItem,
    title: undefined,
    color: {
      ...edgeItem.color,
      color: INVISIBLE_EDGE_COLOR,
      opacity: 0,
      hover: invisible,
      highlight: invisible,
    },
  };
}

let _cache = new Map();

export function setEdgeCache(edgeClass) {
  const next = new Map();
  if (edgeClass && edgeClass.size) {
    const byId = new Map(State.graphEdges.map((e) => [e.id, e]));
    for (const [edgeId, meta] of edgeClass) {
      const ge = byId.get(edgeId);
      const role = ge ? resolveEdgeDominantRole(ge) : "primary";
      const color = roleStyle(role).color;
      const weight = ge && Number(ge.weight) > 0 ? Number(ge.weight) : 1;
      next.set(edgeId, {
        from: meta.from,
        to: meta.to,
        kind: meta.kind,
        hub: meta.hub,
        color,
        width: edgeWidthForWeight(weight),
      });
    }
  }
  _cache = next;
  State.suppressedEdgeIds = new Set(next.keys());
}

export function clearEdgeCache() {
  _cache = new Map();
  State.suppressedEdgeIds = new Set();
}

export function _edgeCacheSize() {
  return _cache.size;
}

function _distToSegment(pt, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(pt.x - a.x, pt.y - a.y);
  let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}

function _distToCurve(pt, p0, control, p1, samples = 16) {
  let minD = Infinity;
  let prev = p0;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples,
      mt = 1 - t;
    const cur = control
      ? {
          x: mt * mt * p0.x + 2 * mt * t * control.x + t * t * p1.x,
          y: mt * mt * p0.y + 2 * mt * t * control.y + t * t * p1.y,
        }
      : { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
    const d = _distToSegment(pt, prev, cur);
    if (d < minD) minD = d;
    prev = cur;
  }
  return minD;
}

export function nearestEdgeAt(pt, maxDist) {
  if (!_cache.size || !State.network) return null;
  const positions = State.network.getPositions();
  let bestId = null,
    bestDist = Infinity;
  for (const [edgeId, meta] of _cache) {
    const from = positions[meta.from],
      to = positions[meta.to];
    if (!from || !to) continue;
    const control = _curvePoint(meta, from, to, positions);
    const d = _distToCurve(pt, from, control, to);
    if (d < bestDist) {
      bestDist = d;
      bestId = edgeId;
    }
  }
  return bestDist <= maxDist ? bestId : null;
}

function _pathEdgeKeySet(path) {
  const set = new Set();
  if (!Array.isArray(path)) return set;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i],
      b = path[i + 1];
    set.add(`${Math.min(a, b)}_${Math.max(a, b)}`);
  }
  return set;
}

function _curvePoint(meta, from, to, positions) {
  if (meta.kind === "intra") {
    const mx = (from.x + to.x) / 2,
      my = (from.y + to.y) / 2;
    const dx = to.x - from.x,
      dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len,
      ny = dx / len;
    const bow = len * INTRA_BOW * (meta.from < meta.to ? 1 : -1);
    return { x: mx + nx * bow, y: my + ny * bow };
  }
  const hubPos = meta.hub == null ? { x: 0, y: 0 } : positions[meta.hub] || { x: 0, y: 0 };
  const mx = (from.x + to.x) / 2,
    my = (from.y + to.y) / 2;
  const chordLen = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const toHubX = hubPos.x - mx,
    toHubY = hubPos.y - my;
  const hubDist = Math.hypot(toHubX, toHubY);
  const bow = chordLen * CROSS_BOW_FRACTION;
  const ux = hubDist > 1e-6 ? toHubX / hubDist : 0;
  const uy = hubDist > 1e-6 ? toHubY / hubDist : 0;
  return { x: mx + ux * bow, y: my + uy * bow };
}

export function drawEdges(ctx) {
  if (!_cache.size || !State.network) return;
  const positions = State.network.getPositions();
  const hoveredIds = getHoveredEdgeIds();
  const selectedId = State.selectedEdgeId;
  const selectedNodeEdgeIds = getSelectedNodeEdgeIds();
  const onPathSet = _pathEdgeKeySet(State.pathHighlight);

  const groups = new Map();
  for (const [edgeId, meta] of _cache) {
    const from = positions[meta.from];
    const to = positions[meta.to];
    if (!from || !to) continue;
    const isSelected = edgeId === selectedId || selectedNodeEdgeIds.has(edgeId);
    const isHovered = hoveredIds.has(edgeId);
    const onPath = onPathSet.has(edgeId);

    let opacity = BASE_OPACITY,
      color = meta.color,
      width = meta.width;
    if (isSelected) {
      opacity = SELECT_OPACITY;
      color = COLOR.neon;
      width = meta.width + 2;
    } else if (isHovered) {
      opacity = HOVER_OPACITY;
      color = lightenHexColor(meta.color, 0.35);
      width = meta.width + 1.4;
    } else if (onPath) {
      opacity = PATH_OPACITY;
      color = COLOR.neon;
      width = meta.width + 2;
    }

    const control = _curvePoint(meta, from, to, positions);

    const key = `${color}|${opacity}|${width}`;
    let group = groups.get(key);
    if (!group) {
      group = { color, opacity, width, segments: [] };
      groups.set(key, group);
    }
    group.segments.push({ from, to, control });
  }

  for (const group of groups.values()) {
    ctx.globalAlpha = group.opacity;
    ctx.strokeStyle = group.color;
    ctx.lineWidth = group.width;
    ctx.beginPath();
    for (const { from, to, control } of group.segments) {
      ctx.moveTo(from.x, from.y);
      if (control) ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
      else ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
