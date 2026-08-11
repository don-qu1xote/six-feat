import { State } from "../state/state.js";
import { FIXED_NODE_RADIUS } from "./visuals.js";

export const NODE_GAP = 34;
export const MIN_SEP = 2 * FIXED_NODE_RADIUS + NODE_GAP;
export const NODE_W = MIN_SEP;

export const LEAF_R = 150;
const PATH_NODE_GAP = 200;
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export const SOLVER_ITERS = 8;
const SOLVER_EPS = 0.01;

export const CLUSTER_GAP = 2 * NODE_GAP;

export function resolveCollisions(targets, pinnedIds, extraPinned, sectorOf) {
  const ids = [...targets.keys()];
  const px = [],
    py = [],
    pin = [];
  for (const id of ids) {
    const p = targets.get(id);
    px.push(p.x);
    py.push(p.y);
    pin.push(pinnedIds.has(id) ? 1 : 0);
  }
  const emitCount = ids.length;
  if (extraPinned) {
    for (const [id, p] of extraPinned) {
      ids.push(id);
      px.push(p.x);
      py.push(p.y);
      pin.push(1);
    }
  }

  const N = px.length;
  if (N < 2) return;

  const sectors = sectorOf ? ids.map((id) => sectorOf.get(id) || null) : null;
  const disjoint = (a, b) => {
    if (!a || !b) return false;
    for (const s of a) if (b.has(s)) return false;
    return true;
  };
  const MAX_SEP = sectorOf ? MIN_SEP + CLUSTER_GAP : MIN_SEP;

  const MIN2 = MIN_SEP * MIN_SEP;
  const inv = 1 / MAX_SEP;

  const iters = sectorOf ? SOLVER_ITERS * 3 : SOLVER_ITERS;
  for (let iter = 0; iter < iters; iter++) {
    const grid = new Map();
    for (let i = 0; i < N; i++) {
      const key = Math.floor(px[i] * inv) + ":" + Math.floor(py[i] * inv);
      let cell = grid.get(key);
      if (!cell) grid.set(key, (cell = []));
      cell.push(i);
    }

    let moved = false;
    for (let i = 0; i < N; i++) {
      const cx = Math.floor(px[i] * inv),
        cy = Math.floor(py[i] * inv);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const cell = grid.get(gx + ":" + gy);
          if (!cell) continue;
          for (const j of cell) {
            if (j <= i) continue;
            if (pin[i] && pin[j]) continue;
            const sep =
              sectors && disjoint(sectors[i], sectors[j]) ? MIN_SEP + CLUSTER_GAP : MIN_SEP;
            const sep2 = sep === MIN_SEP ? MIN2 : sep * sep;
            let dx = px[j] - px[i],
              dy = py[j] - py[i];
            const d2 = dx * dx + dy * dy;
            if (d2 >= sep2) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-9) {
              const a = i * 12.9898 + j * 78.233;
              dx = Math.cos(a);
              dy = Math.sin(a);
              d = 1;
            } else {
              dx /= d;
              dy /= d;
            }
            const pen = sep - d + SOLVER_EPS;
            moved = true;
            if (pin[i]) {
              px[j] += dx * pen;
              py[j] += dy * pen;
            } else if (pin[j]) {
              px[i] -= dx * pen;
              py[i] -= dy * pen;
            } else {
              const h = pen * 0.5;
              px[i] -= dx * h;
              py[i] -= dy * h;
              px[j] += dx * h;
              py[j] += dy * h;
            }
          }
        }
      }
    }
    if (!moved) break;
  }

  for (let i = 0; i < emitCount; i++) {
    if (!pin[i]) targets.set(ids[i], { x: px[i], y: py[i] });
  }
}

export function classifyGraph() {
  const empty = { edgeClass: new Map(), sectorMembers: new Map() };
  const seedId = State.currentSeedId;
  if (seedId == null) return empty;

  const expanded = [...State.expandedNodes];
  const expandedSet = new Set(expanded);
  const poles = expanded.filter((id) => id !== seedId);
  const poleSet = new Set(poles);

  const leafOwners = new Map();
  for (const e of State.graphEdges) {
    const a = e.from,
      b = e.to;
    const aIsOwner = (expandedSet.has(a) && a !== seedId) || a === seedId;
    const bIsOwner = (expandedSet.has(b) && b !== seedId) || b === seedId;

    if (aIsOwner && !expandedSet.has(b) && b !== seedId) {
      if (!leafOwners.has(b)) leafOwners.set(b, new Set());
      leafOwners.get(b).add(a);
    }
    if (bIsOwner && !expandedSet.has(a) && a !== seedId) {
      if (!leafOwners.has(a)) leafOwners.set(a, new Set());
      leafOwners.get(a).add(b);
    }
  }

  const exclusive = new Map(poles.map((id) => [id, []]));
  const sharedLeaves = [];
  const handledLeaves = new Set();

  for (const [leaf, owners] of leafOwners) {
    if (owners.size === 1) {
      const [owner] = owners;
      if (owner === seedId) continue;
      if (exclusive.has(owner)) {
        exclusive.get(owner).push(leaf);
        handledLeaves.add(leaf);
      }
    } else {
      sharedLeaves.push({ leaf, owners });
      handledLeaves.add(leaf);
    }
  }

  const seedLeaves = [];
  for (const n of State.graphNodes) {
    if (expandedSet.has(n.id) || n.id === seedId || handledLeaves.has(n.id)) continue;
    seedLeaves.push(n.id);
  }

  const poleParent = new Map();
  const graphNodeById = new Map(State.graphNodes.map((n) => [n.id, n]));
  for (const id of poles) {
    const gn = graphNodeById.get(id);
    let parent = gn && gn._expandParent != null ? gn._expandParent : seedId;
    if (parent !== seedId && !poleSet.has(parent)) parent = seedId;
    if (parent === id) parent = seedId;
    poleParent.set(id, parent);
  }
  for (const id of poles) {
    let cur = id,
      steps = 0;
    const seen = new Set();
    while (poleParent.get(cur) !== seedId) {
      if (seen.has(cur) || steps++ > poles.length) {
        poleParent.set(id, seedId);
        break;
      }
      seen.add(cur);
      cur = poleParent.get(cur);
    }
  }

  const eulerZones = new Map();
  for (const { leaf, owners } of sharedLeaves) {
    const key = [...owners].map(String).sort().join("_");
    if (!eulerZones.has(key)) eulerZones.set(key, { owners: [...owners], leaves: [] });
    eulerZones.get(key).leaves.push(leaf);
  }

  const sectorMembers = new Map(poles.map((id) => [id, new Set([id, ...exclusive.get(id)])]));
  sectorMembers.set(seedId, new Set([seedId, ...seedLeaves]));
  for (const { owners, leaves: zoneLeaves } of eulerZones.values()) {
    for (const owner of owners) {
      const members = sectorMembers.get(owner);
      if (!members) continue;
      for (const leaf of zoneLeaves) members.add(leaf);
    }
  }

  function rootSectorOf(poleId) {
    let cur = poleId,
      guard = 0;
    while (poleParent.get(cur) !== seedId) {
      cur = poleParent.get(cur);
      if (++guard > poles.length + 1) return seedId;
    }
    return cur;
  }
  function sectorOf(id) {
    if (id === seedId) return seedId;
    if (poleSet.has(id)) return rootSectorOf(id);
    const owners = leafOwners.get(id);
    if (!owners || owners.size !== 1) return seedId;
    const [owner] = owners;
    return owner === seedId ? seedId : rootSectorOf(owner);
  }

  const edgeClass = new Map();
  for (const e of State.graphEdges) {
    const a = e.from,
      b = e.to;
    const isTreeEdge = poleParent.get(a) === b || poleParent.get(b) === a;
    const ownersA = leafOwners.get(a),
      ownersB = leafOwners.get(b);
    const isExclusiveEdge =
      (ownersA && ownersA.size === 1 && [...ownersA][0] === b) ||
      (ownersB && ownersB.size === 1 && [...ownersB][0] === a);
    const kind = isTreeEdge || isExclusiveEdge ? "intra" : "cross";
    let hub = null;
    if (kind === "cross") {
      const sa = sectorOf(a),
        sb = sectorOf(b);
      hub = sa === sb && sa !== seedId ? sa : null;
    }
    const key = e.id ?? `${Math.min(a, b)}_${Math.max(a, b)}`;
    edgeClass.set(key, { from: a, to: b, kind, hub });
  }

  return { edgeClass, sectorMembers };
}

// Запрос к раскладке — структура графа, а не данные о нём. Ни имён, ни
// картинок, ни ролей: сервер считает геометрию и про артистов знать не
// должен.
export function buildLayoutRequest(savedPositions) {
  const seedId = State.currentSeedId;
  if (seedId == null) return null;

  const saved = savedPositions || {};
  const expandParent = {};
  const pinned = {};
  for (const n of State.graphNodes) {
    if (n._expandParent != null && n.id !== seedId) expandParent[n.id] = n._expandParent;
    if (n.id === seedId) continue;
    const sp = saved[n.id];
    if (!sp || !isFinite(sp.x) || !isFinite(sp.y)) continue;
    // Полюс закрепляется только после того, как хоть раз встал на место.
    // До этого его текущая позиция — не решение раскладки, а то, где он
    // висел листом; держаться за неё значило бы запомнить случайность.
    if (State.expandedNodes.has(n.id) && !n._poleSettled) continue;
    pinned[n.id] = { x: sp.x, y: sp.y };
  }

  return {
    seed_id: seedId,
    nodes: State.graphNodes.map((n) => n.id),
    edges: State.graphEdges.map((e) => [e.from, e.to]),
    expanded: [...State.expandedNodes],
    expand_parent: expandParent,
    pinned,
    // Радиус и зазор задаёт клиент: сервер не должен знать, каким кружком
    // рисуется узел, — иначе смена оформления станет релизом бэкенда.
    node_radius: FIXED_NODE_RADIUS,
    node_gap: NODE_GAP,
  };
}

// Позиции сервера — единственный источник координат, и «полюс осел» теперь
// значит «сервер вернул для него позицию».
export function markPolesSettled(targets) {
  if (!targets) return;
  for (const n of State.graphNodes) {
    if (State.expandedNodes.has(n.id) && targets.has(n.id)) n._poleSettled = true;
  }
}

// fromPos — откуда узел вылетает. Это не раскладка, а начало анимации, и
// считается из того, что клиент и так держит: где узел был до слияния.
export function entranceFrom(savedPositions, ids) {
  const saved = savedPositions || {};
  const fromPos = new Map();
  for (const id of ids) {
    const sp = saved[id];
    fromPos.set(id, sp ? { x: sp.x, y: sp.y } : { x: 0, y: 0 });
  }
  return fromPos;
}

const MIN_PATH_GAP = Math.max(140, MIN_SEP);

export function placePathNodes(path, canvasSize = {}) {
  const targets = new Map(),
    fromPos = new Map();
  if (!path || path.length < 2) return { targets, fromPos };

  const n = path.length;
  const width = canvasSize.width > 0 ? canvasSize.width : 1100;
  const usable = Math.max(width * 0.8, MIN_PATH_GAP);
  const step = clamp(usable / (n - 1), MIN_PATH_GAP, PATH_NODE_GAP);
  const totalWidth = step * (n - 1);
  const startX = -totalWidth / 2;

  for (let i = 0; i < n; i++) {
    const nodeId = path[i];
    targets.set(nodeId, { x: startX + step * i, y: 0 });
    fromPos.set(nodeId, { x: 0, y: 0 });
  }

  return { targets, fromPos };
}
