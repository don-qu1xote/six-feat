import { State } from "../state/state.js";
import { FIXED_NODE_RADIUS } from "./visuals.js";

export const NODE_GAP = 34;
export const MIN_SEP = 2 * FIXED_NODE_RADIUS + NODE_GAP;
export const NODE_W = MIN_SEP;

export const LEAF_R = 150;
const LEAF_GAP = 58;
const CLUSTER_GAP_FLOOR = MIN_SEP * 2;
const SHARED_GAP_STEP = MIN_SEP * 0.6;
const SHARED_GAP_MAX = MIN_SEP * 4;
const PATH_NODE_GAP = 200;
function _easeOut3(t) {
  return 1 - Math.pow(1 - t, 3);
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function _normAngle(a) {
  let x = a;
  while (x <= -Math.PI) x += 2 * Math.PI;
  while (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

const GOLDEN_ANGLE = 2.399963229728653;
function _fallbackAngle(seed) {
  return _normAngle(seed * GOLDEN_ANGLE);
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

const RING_CAP_MARGIN = 1.08;

function _ringCap(r) {
  const target = NODE_W * RING_CAP_MARGIN;
  const ratio = target / (2 * r);
  if (ratio >= 1) return 1;
  return Math.max(1, Math.floor(Math.PI / Math.asin(ratio)));
}

function _adaptiveRingGap(n) {
  const gap = LEAF_GAP * (1 + Math.log2(1 + Math.max(0, n) / 12) * 0.15);
  return Math.max(NODE_W, gap);
}

function _dandelionR(n) {
  if (n <= 0) return LEAF_R * 0.5;
  const gap = _adaptiveRingGap(n);
  let rem = n,
    k = 0;
  while (rem > 0) {
    rem -= _ringCap(LEAF_R + k * gap);
    k++;
    if (k > 60) break;
  }
  return LEAF_R + (k - 1) * gap + NODE_W * 0.5;
}

function _placeZoneLeafRings(leaves, cx, cy, targets, fromPos, getFrom) {
  if (!leaves.length) return;
  if (leaves.length === 1) {
    targets.set(leaves[0], { x: cx, y: cy });
    fromPos.set(leaves[0], getFrom(leaves[0]));
    return;
  }
  const gap = _adaptiveRingGap(leaves.length);
  const r0 = Math.max(NODE_W * 0.55, gap * 0.5);
  let rem = [...leaves],
    k = 0;
  while (rem.length) {
    const r = r0 + k * gap;
    const cap = _ringCap(r);
    const batch = rem.splice(0, cap);
    const rotate = k * GOLDEN_ANGLE;
    batch.forEach((leaf, i) => {
      const ang = rotate + (2 * Math.PI * i) / batch.length;
      targets.set(leaf, { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
      fromPos.set(leaf, getFrom(leaf));
    });
    k++;
  }
}

export function placeExpandedNodes(savedPositions) {
  const targets = new Map(),
    fromPos = new Map();
  const seedId = State.currentSeedId;
  if (seedId == null) return { targets, fromPos };

  const expanded = [...State.expandedNodes];
  const expandedSet = new Set(expanded);

  const getFrom = (id) => {
    const sp = savedPositions[id];
    return sp ? { x: sp.x, y: sp.y } : { x: 0, y: 0 };
  };

  const poles = expanded.filter((id) => id !== seedId);

  const leafOwners = new Map();
  for (const e of State.graphEdges) {
    const a = e.from,
      b = e.to;
    const aIsPole = expandedSet.has(a) && a !== seedId;
    const bIsPole = expandedSet.has(b) && b !== seedId;
    const aIsOwner = aIsPole || a === seedId;
    const bIsOwner = bIsPole || b === seedId;

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

  const sharedCountCache = new Map();
  for (const { owners } of sharedLeaves) {
    const os = [...owners].sort((a, b) => a - b);
    for (let i = 0; i < os.length; i++)
      for (let j = i + 1; j < os.length; j++) {
        const k = os[i] + "_" + os[j];
        sharedCountCache.set(k, (sharedCountCache.get(k) || 0) + 1);
      }
  }
  function sharedCountBetween(a, b) {
    return sharedCountCache.get(Math.min(a, b) + "_" + Math.max(a, b)) || 0;
  }

  function clusterGap(sharedCount) {
    const sharedExtra = Math.min(
      Math.sqrt(Math.max(0, sharedCount)) * SHARED_GAP_STEP,
      SHARED_GAP_MAX,
    );
    return CLUSTER_GAP_FLOOR + sharedExtra;
  }

  const seedLeaves = [];
  for (const n of State.graphNodes) {
    if (expandedSet.has(n.id) || n.id === seedId || handledLeaves.has(n.id)) continue;
    seedLeaves.push(n.id);
  }
  const dRSeed = _dandelionR(seedLeaves.length);

  const poleParent = new Map();
  const poleSet = new Set(poles);
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

  const rootPoleIds = poles.filter((id) => poleParent.get(id) === seedId);

  const poleNeighbors = new Map();
  {
    const isHub = (id) => id === seedId || poleSet.has(id);
    for (const e of State.graphEdges) {
      const a = e.from,
        b = e.to;
      if (a === b || !isHub(a) || !isHub(b)) continue;
      if (!poleNeighbors.has(a)) poleNeighbors.set(a, new Set());
      if (!poleNeighbors.has(b)) poleNeighbors.set(b, new Set());
      poleNeighbors.get(a).add(b);
      poleNeighbors.get(b).add(a);
    }
  }

  const poleDR = new Map(poles.map((id) => [id, _dandelionR(exclusive.get(id).length)]));
  const poleChildren = new Map();
  for (const id of poles) {
    const p = poleParent.get(id);
    if (p !== seedId) {
      if (!poleChildren.has(p)) poleChildren.set(p, []);
      poleChildren.get(p).push(id);
    }
  }

  const maxSiblingShared = new Map();
  for (const group of [rootPoleIds, ...poleChildren.values()]) {
    for (const id of group) {
      let m = 0;
      for (const other of group) {
        if (other !== id) m = Math.max(m, sharedCountBetween(id, other));
      }
      maxSiblingShared.set(id, m);
    }
  }

  const P = new Map();
  P.set(seedId, { x: 0, y: 0, dR: dRSeed });

  const ANGULAR_GAP = 0.02;

  function _footprintHalf(dR, gap, r) {
    if (r < 1e-6) return Math.PI;
    return Math.min(Math.PI - 1e-3, Math.asin(clamp((dR + gap / 2) / r, -1, 1)) + ANGULAR_GAP);
  }
  function _angularSep(a, b) {
    return Math.abs(_normAngle(a - b));
  }

  function _overlapAmount(angle, half, placed) {
    let worst = 0;
    for (const s of placed) {
      const need = half + s.half;
      const have = _angularSep(angle, s.angle);
      if (need - have > worst) worst = need - have;
    }
    return worst;
  }

  function _ownerVector(id) {
    const neighbors = poleNeighbors.get(id);
    if (!neighbors) return null;
    let sx = 0,
      sy = 0,
      n = 0;
    for (const nb of neighbors) {
      const p = P.get(nb);
      if (!p) continue;
      sx += p.x;
      sy += p.y;
      n++;
    }
    if (!n) return null;
    const mag = Math.hypot(sx, sy);
    return mag >= 1e-6 ? Math.atan2(sy, sx) : null;
  }

  function _idealDistFromHub(hubId, dR, gap) {
    const hubR = hubId === seedId ? dRSeed : poleDR.get(hubId);
    return hubR + gap + dR;
  }

  function _circleIntersections(p1, r1, p2, r2) {
    const dx = p2.x - p1.x,
      dy = p2.y - p1.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6 || d > r1 + r2 || d < Math.abs(r1 - r2)) return [];
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const hSq = r1 * r1 - a * a;
    const h = hSq > 0 ? Math.sqrt(hSq) : 0;
    const mx = p1.x + (a * dx) / d,
      my = p1.y + (a * dy) / d;
    if (h < 1e-6) return [{ x: mx, y: my }];
    const ox = (-dy / d) * h,
      oy = (dx / d) * h;
    return [
      { x: mx + ox, y: my + oy },
      { x: mx - ox, y: my - oy },
    ];
  }

  function _trilaterationPoint(id, dR, gap) {
    const neighbors = poleNeighbors.get(id);
    if (!neighbors) return null;
    const placed = [];
    for (const nb of neighbors) {
      const p = P.get(nb);
      if (!p) continue;
      placed.push({ id: nb, pos: p, R: _idealDistFromHub(nb, dR, gap) });
    }
    if (placed.length < 2) return null;

    const treeParent = poleParent.get(id);
    placed.sort((a, b) => (a.id === treeParent ? -1 : 0) - (b.id === treeParent ? -1 : 0));

    const fallbackAngle = _fallbackAngle(id);
    const outwardAngle = (hub) => {
      const d = Math.hypot(hub.pos.x, hub.pos.y);
      return d > 1e-6 ? Math.atan2(hub.pos.y, hub.pos.x) : fallbackAngle;
    };

    const h1 = placed[0],
      h2 = placed[1];

    let wx = 0,
      wy = 0;
    for (const hub of placed) {
      const a = outwardAngle(hub);
      const w = 1 / Math.max(hub.R, 1e-6);
      wx += Math.cos(a) * w;
      wy += Math.sin(a) * w;
    }
    const wMag = Math.hypot(wx, wy);
    const blendAngle = wMag >= 1e-6 ? Math.atan2(wy, wx) : fallbackAngle;

    const points = _circleIntersections(h1.pos, h1.R, h2.pos, h2.R);
    if (points.length) {
      const refX = h1.pos.x + h1.R * Math.cos(blendAngle);
      const refY = h1.pos.y + h1.R * Math.sin(blendAngle);
      let best = points[0],
        bestDist = Math.hypot(points[0].x - refX, points[0].y - refY);
      for (let i = 1; i < points.length; i++) {
        const d = Math.hypot(points[i].x - refX, points[i].y - refY);
        if (d < bestDist) {
          best = points[i];
          bestDist = d;
        }
      }
      return best;
    }

    const anchor = Math.hypot(h1.pos.x, h1.pos.y) > 1e-6 ? h1 : h2;
    const anchorAngle = outwardAngle(anchor);
    const pureX = anchor.pos.x + anchor.R * Math.cos(anchorAngle);
    const pureY = anchor.pos.y + anchor.R * Math.sin(anchorAngle);
    const blendX = anchor.pos.x + anchor.R * Math.cos(blendAngle);
    const blendY = anchor.pos.y + anchor.R * Math.sin(blendAngle);

    const dx = blendX - pureX,
      dy = blendY - pureY;
    const lateral = Math.hypot(dx, dy);
    const MAX_LATERAL = MIN_SEP * 6;
    if (lateral <= MAX_LATERAL || lateral < 1e-6) {
      return { x: blendX, y: blendY };
    }
    const scale = MAX_LATERAL / lateral;
    return { x: pureX + dx * scale, y: pureY + dy * scale };
  }

  function placeChildren(parentId, childIds, parentR) {
    if (!childIds.length) return;
    const sorted = [...childIds].sort((a, b) => a - b);
    const pinned = [],
      fresh = [];
    for (const id of sorted) {
      const alreadySettled = graphNodeById.get(id)?._poleSettled && savedPositions[id];
      (alreadySettled ? pinned : fresh).push(id);
    }

    const placedThisRound = [];
    const placedR = new Map();

    for (const id of pinned) {
      const { x, y } = savedPositions[id];
      const dR = poleDR.get(id);
      const r = Math.max(Math.hypot(x, y), 1e-6);
      P.set(id, { x, y, dR });
      targets.set(id, { x, y });
      fromPos.set(id, getFrom(id));
      const sharedCount = Math.max(sharedCountBetween(id, parentId), maxSiblingShared.get(id) || 0);
      const gap = clusterGap(sharedCount);
      placedThisRound.push({ angle: Math.atan2(y, x), half: _footprintHalf(dR, gap, r) });
      placedR.set(id, r);
    }

    for (const id of fresh) {
      const dR = poleDR.get(id);
      const sharedCount = Math.max(sharedCountBetween(id, parentId), maxSiblingShared.get(id) || 0);
      const gap = clusterGap(sharedCount);
      const isRoot = parentId === seedId;

      const triPoint = _trilaterationPoint(id, dR, gap);
      let baseR, attemptAngle;
      if (triPoint) {
        baseR = Math.hypot(triPoint.x, triPoint.y);
        attemptAngle = Math.atan2(triPoint.y, triPoint.x);
      } else {
        baseR = isRoot ? dRSeed + dR + gap : parentR + poleDR.get(parentId) + dR + gap;
        attemptAngle = _ownerVector(id) ?? _fallbackAngle(id);
      }

      let r = baseR;
      let angle = attemptAngle;
      let half = _footprintHalf(dR, gap, r);
      let ok = placedThisRound.every((s) => _angularSep(angle, s.angle) >= half + s.half);

      let bestAngle = angle;
      let bestOverlap = _overlapAmount(angle, half, placedThisRound);

      let tries = 0;
      while (!ok && tries < 24) {
        tries++;
        const k = Math.ceil(tries / 2);
        const sign = tries % 2 === 1 ? 1 : -1;
        angle = _normAngle(attemptAngle + sign * k * (half + ANGULAR_GAP) * 1.3);
        ok = placedThisRound.every((s) => _angularSep(angle, s.angle) >= half + s.half);
        const overlap = _overlapAmount(angle, half, placedThisRound);
        if (overlap < bestOverlap) {
          bestOverlap = overlap;
          bestAngle = angle;
        }
      }
      if (!ok) {
        angle = bestAngle;
        half = _footprintHalf(dR, gap, r);
        ok = placedThisRound.every((s) => _angularSep(angle, s.angle) >= half + s.half);
        const GROW_STEP = Math.max(gap, dR);
        const GROW_CAP = 5;
        for (let grow = 0; grow < GROW_CAP && !ok; grow++) {
          r += GROW_STEP;
          half = _footprintHalf(dR, gap, r);
          ok = placedThisRound.every((s) => _angularSep(angle, s.angle) >= half + s.half);
        }
      }

      const x = Math.cos(angle) * r,
        y = Math.sin(angle) * r;
      P.set(id, { x, y, dR });
      targets.set(id, { x, y });
      fromPos.set(id, getFrom(id));
      placedThisRound.push({ angle, half });
      placedR.set(id, r);
      const gn = graphNodeById.get(id);
      if (gn) gn._poleSettled = true;
    }

    for (const id of sorted) {
      placeChildren(id, poleChildren.get(id) || [], placedR.get(id));
    }
  }

  placeChildren(seedId, rootPoleIds, 0);

  for (const [poleId, leaves] of exclusive) {
    if (!leaves.length) continue;
    const { x: px, y: py } = P.get(poleId);
    const baseAngle = Math.atan2(py, px);
    const gap = _adaptiveRingGap(leaves.length);
    let rem = [...leaves],
      k = 0;
    while (rem.length) {
      const r = LEAF_R + k * gap;
      const cap = _ringCap(r);
      const batch = rem.splice(0, cap);
      batch.forEach((leaf, i) => {
        const ang = baseAngle + (2 * Math.PI * i) / batch.length;
        targets.set(leaf, { x: px + Math.cos(ang) * r, y: py + Math.sin(ang) * r });
        fromPos.set(leaf, getFrom(leaf));
      });
      k++;
    }
  }

  const eulerZones = new Map();
  for (const { leaf, owners } of sharedLeaves) {
    const key = [...owners].map(String).sort().join("_");
    if (!eulerZones.has(key)) eulerZones.set(key, { owners: [...owners], leaves: [] });
    eulerZones.get(key).leaves.push(leaf);
  }

  for (const { owners, leaves } of eulerZones.values()) {
    const valid = owners.filter((o) => P.has(o));
    if (!valid.length) continue;

    const minRFromSeed = dRSeed + clusterGap(leaves.length) * 0.5;

    let cx = 0,
      cy = 0;
    valid.forEach((o) => {
      cx += P.get(o).x;
      cy += P.get(o).y;
    });
    cx /= valid.length;
    cy /= valid.length;

    const rFromSeed = Math.hypot(cx, cy);
    if (rFromSeed < minRFromSeed) {
      const pushAng =
        rFromSeed > 1e-6
          ? Math.atan2(cy, cx)
          : _fallbackAngle(valid.reduce((a, b) => a + b, 0) + 1);
      cx = Math.cos(pushAng) * minRFromSeed;
      cy = Math.sin(pushAng) * minRFromSeed;
    }

    _placeZoneLeafRings(leaves, cx, cy, targets, fromPos, getFrom);
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

  if (seedLeaves.length) {
    const freshSeedLeaves = [];
    for (const id of seedLeaves) {
      if (savedPositions[id]) {
        const { x, y } = savedPositions[id];
        targets.set(id, { x, y });
        fromPos.set(id, { x, y });
      } else {
        freshSeedLeaves.push(id);
      }
    }

    const gap = _adaptiveRingGap(seedLeaves.length);
    let rem = freshSeedLeaves,
      k = 0;
    while (rem.length) {
      const r = LEAF_R + k * gap;
      const cap = _ringCap(r);
      const batch = rem.splice(0, cap);
      batch.forEach((leaf, i) => {
        const ang = (2 * Math.PI * i) / batch.length;
        targets.set(leaf, { x: Math.cos(ang) * r, y: Math.sin(ang) * r });
        fromPos.set(leaf, { x: 0, y: 0 });
      });
      k++;
    }
  }

  const sectorsByNode = new Map();
  for (const [sectorId, members] of sectorMembers) {
    for (const memberId of members) {
      let owners = sectorsByNode.get(memberId);
      if (!owners) sectorsByNode.set(memberId, (owners = new Set()));
      owners.add(sectorId);
    }
  }
  const pinnedIds = new Set(poles);
  resolveCollisions(targets, pinnedIds, new Map([[seedId, { x: 0, y: 0 }]]), sectorsByNode);

  const poleSetForClass = new Set(poles);
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
    if (poleSetForClass.has(id)) return rootSectorOf(id);
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

  return { targets, fromPos, edgeClass, sectorMembers };
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
