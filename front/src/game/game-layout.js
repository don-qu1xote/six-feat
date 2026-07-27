import { MIN_SEP, resolveCollisions } from "../vis-adapter/layout.js";

export const COL_STEP = Math.round(MIN_SEP * 2.4);
export const LANE_STEP = Math.round(MIN_SEP * 1.5);
export const START_X = 0;

const MIN_CORRIDOR = 2;

function depthsOf(game) {
  const byName = new Map((game.nodes || []).map((n) => [n.name, n]));
  const depth = new Map();
  const resolve = (name, guard = 0) => {
    if (depth.has(name)) return depth.get(name);
    const node = byName.get(name);
    if (!node || node.parent == null || guard > 512) {
      depth.set(name, 0);
      return 0;
    }
    const d = resolve(node.parent, guard + 1) + 1;
    depth.set(name, d);
    return d;
  };
  (game.nodes || []).forEach((n) => resolve(n.name));
  return depth;
}

function lanesOf(game) {
  const lane = new Map();
  const childCount = new Map();
  const used = new Set([0]);
  const nextLane = () => {
    for (let k = 1; k < 4096; k++) {
      if (!used.has(k)) {
        used.add(k);
        return k;
      }
      if (!used.has(-k)) {
        used.add(-k);
        return -k;
      }
    }
    return 0;
  };

  (game.nodes || []).forEach((n) => {
    if (n.parent == null) {
      lane.set(n.name, 0);
      return;
    }
    const seen = childCount.get(n.parent) || 0;
    childCount.set(n.parent, seen + 1);
    lane.set(n.name, seen === 0 ? (lane.get(n.parent) ?? 0) : nextLane());
  });

  return lane;
}

export function computeGameLayout(game, { par = null, frontier = null } = {}) {
  const empty = {
    positions: new Map(),
    frontier: new Map(),
    poles: { startX: START_X, goalX: START_X + MIN_CORRIDOR * COL_STEP },
    goal: { x: START_X + MIN_CORRIDOR * COL_STEP, y: 0 },
    depth: new Map(),
    lane: new Map(),
  };
  if (!game || !Array.isArray(game.nodes) || !game.nodes.length) return empty;

  const depth = depthsOf(game);
  const lane = lanesOf(game);

  const positions = new Map();
  game.nodes.forEach((n) => {
    positions.set(n.name, {
      x: START_X + (depth.get(n.name) ?? 0) * COL_STEP,
      y: (lane.get(n.name) ?? 0) * LANE_STEP,
    });
  });

  let maxDepth = 0;
  depth.forEach((d) => {
    if (d > maxDepth) maxDepth = d;
  });
  const goalReached = positions.has(game.goal);
  const span = Math.max(MIN_CORRIDOR, par || 0, goalReached ? maxDepth : maxDepth + 2);
  const goalX = START_X + span * COL_STEP;

  const goal = goalReached ? positions.get(game.goal) : { x: goalX, y: 0 };

  const fan = placeFrontier(game, frontier, positions);

  if (fan.size) {
    const pinned = new Map(positions);
    if (!positions.has(game.goal)) pinned.set(game.goal, goal);
    resolveCollisions(fan, new Set(), pinned);
  }

  return {
    positions,
    frontier: fan,
    poles: { startX: START_X, goalX },
    goal,
    depth,
    lane,
  };
}

const FAN_SPREAD = 0.6;
const FAN_RING_CAPACITY = 4;
function placeFrontier(game, frontier, positions) {
  const out = new Map();
  const list =
    frontier && !frontier.loading && !frontier.unavailable && Array.isArray(frontier.neighbours)
      ? frontier.neighbours
      : [];
  if (!list.length) return out;

  const focus = game.focus;
  const focusPos = positions.get(focus);
  if (!focusPos) return out;

  const ringCount = Math.max(1, Math.ceil(list.length / FAN_RING_CAPACITY));
  const perRing = Math.ceil(list.length / ringCount);
  const rings = [];
  for (let i = 0; i < list.length; i += perRing) rings.push(list.slice(i, i + perRing));

  let prevR = 0;
  rings.forEach((ring, ringIndex) => {
    const n = ring.length;
    const denom = ringIndex % 2 ? n : n - 1;
    const step = n > 1 ? (2 * FAN_SPREAD) / denom : 0;
    const needed = step > 0 ? MIN_SEP / (2 * Math.sin(step / 2)) : 0;
    const r = Math.max(COL_STEP * 0.9, needed, prevR + MIN_SEP);
    prevR = r;
    const mid = (n - 1) / 2;
    ring.forEach((cand, i) => {
      const angle = (i - mid) * step;
      out.set(cand.name, {
        x: focusPos.x + r * Math.cos(angle),
        y: focusPos.y + r * Math.sin(angle),
      });
    });
  });
  return out;
}

export function layoutBounds(layout) {
  let minX = layout.poles.startX,
    maxX = layout.poles.goalX;
  let minY = 0,
    maxY = 0;
  const eat = (pos) => {
    if (pos.x < minX) minX = pos.x;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.y > maxY) maxY = pos.y;
  };
  layout.positions.forEach(eat);
  layout.frontier.forEach(eat);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}
