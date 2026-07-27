import { describe, it, expect, beforeEach } from "vitest";
import {
  placePathNodes,
  placeExpandedNodes,
  resolveCollisions,
  NODE_W,
  MIN_SEP,
  SOLVER_ITERS,
  CLUSTER_GAP,
  NODE_GAP,
} from "./layout.js";
import { State } from "../state/state.js";

function xs(targets, path) {
  return path.map((id) => targets.get(id).x);
}

describe("placePathNodes", () => {
  it("returns empty maps for a path shorter than 2 nodes", () => {
    expect(placePathNodes([], { width: 1200 })).toEqual({ targets: new Map(), fromPos: new Map() });
    expect(placePathNodes([1], { width: 1200 })).toEqual({
      targets: new Map(),
      fromPos: new Map(),
    });
  });

  it("places every path node, monotonically increasing in x (from → to, left to right)", () => {
    const path = [11, 22, 33, 44, 55];
    const { targets } = placePathNodes(path, { width: 1200 });
    expect(targets.size).toBe(path.length);
    const xValues = xs(targets, path);
    for (let i = 1; i < xValues.length; i++) {
      expect(xValues[i]).toBeGreaterThan(xValues[i - 1]);
    }
  });

  it("spaces nodes uniformly", () => {
    const path = [1, 2, 3, 4, 5, 6];
    const { targets } = placePathNodes(path, { width: 1400 });
    const xValues = xs(targets, path);
    const gaps = xValues.slice(1).map((x, i) => x - xValues[i]);
    const [first, ...rest] = gaps;
    for (const g of rest) expect(g).toBeCloseTo(first, 6);
  });

  it("never lets nodes overlap, even for a long path on a narrow canvas", () => {
    const path = Array.from({ length: 30 }, (_, i) => i + 1);
    const { targets } = placePathNodes(path, { width: 400 });
    const xValues = xs(targets, path);
    for (let i = 1; i < xValues.length; i++) {
      expect(xValues[i] - xValues[i - 1]).toBeGreaterThanOrEqual(140);
    }
  });

  it("does not spread a short path needlessly wide on a huge canvas", () => {
    const path = [1, 2];
    const { targets } = placePathNodes(path, { width: 4000 });
    const xValues = xs(targets, path);
    expect(xValues[1] - xValues[0]).toBeLessThanOrEqual(200);
  });

  it("centers the row on the origin", () => {
    const path = [1, 2, 3, 4];
    const { targets } = placePathNodes(path, { width: 1200 });
    const xValues = xs(targets, path);
    const mid = (xValues[0] + xValues[xValues.length - 1]) / 2;
    expect(mid).toBeCloseTo(0, 6);
  });

  it("every node flies out from the shared center point (0,0)", () => {
    const path = [1, 2, 3];
    const { fromPos } = placePathNodes(path, { width: 1200 });
    for (const id of path) {
      expect(fromPos.get(id)).toEqual({ x: 0, y: 0 });
    }
  });

  it("falls back to a sane default when no canvas width is given", () => {
    const path = [1, 2, 3];
    const { targets } = placePathNodes(path);
    expect(targets.size).toBe(3);
  });
});

function pairwiseDistances(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      out.push(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
    }
  }
  return out;
}

function graphWithPoleLeaves(n) {
  const seedId = 1,
    poleId = 2;
  const leafIds = Array.from({ length: n }, (_, i) => 100 + i);

  State.graphNodes = [
    { id: seedId, isSeed: true },
    { id: poleId, isSeed: false },
    ...leafIds.map((id) => ({ id, isSeed: false })),
  ];
  State.graphEdges = [
    { from: seedId, to: poleId, weight: 1 },
    ...leafIds.map((id) => ({ from: poleId, to: id, weight: 1 })),
  ];
  State.currentSeedId = seedId;
  State.expandedNodes = new Set([poleId]);
  State.network = {};
  State.nodesDS = {};

  return { seedId, poleId, leafIds };
}

describe("placeExpandedNodes — dandelion rings around a single pole", () => {
  beforeEach(() => {
    State.graphNodes = [];
    State.graphEdges = [];
    State.currentSeedId = null;
    State.expandedNodes = new Set();
    State.network = null;
    State.nodesDS = null;
  });

  it("returns empty maps when there is no seed and no graph", () => {
    State.network = {};
    State.nodesDS = {};
    State.currentSeedId = 1;
    State.expandedNodes = new Set();
    const { targets, fromPos } = placeExpandedNodes({});
    expect(targets.size).toBe(0);
    expect(fromPos.size).toBe(0);
  });

  it("places the seed's own direct neighbours in a dandelion, even with nothing expanded", () => {
    const seedId = 1;
    const neighborIds = [10, 11, 12, 13, 14, 15];

    State.graphNodes = [
      { id: seedId, isSeed: true },
      ...neighborIds.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = neighborIds.map((id) => ({ from: seedId, to: id, weight: 1 }));
    State.currentSeedId = seedId;
    State.expandedNodes = new Set();
    State.network = {};
    State.nodesDS = {};

    const { targets } = placeExpandedNodes({});
    expect(targets.size).toBe(neighborIds.length);

    const points = neighborIds.map((id) => targets.get(id));
    expect(points.every(Boolean)).toBe(true);
    for (const d of pairwiseDistances(points)) {
      expect(d).toBeGreaterThanOrEqual(NODE_W - 1e-6);
    }
    for (const p of points) {
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(1);
    }
  });

  it("places every leaf, with no pair closer than NODE_W — no ring overlaps, for a small leaf count", () => {
    const { leafIds } = graphWithPoleLeaves(6);
    const { targets } = placeExpandedNodes({});

    expect(targets.size).toBe(1 + leafIds.length);
    const leafPoints = leafIds.map((id) => targets.get(id));
    expect(leafPoints.every(Boolean)).toBe(true);
    for (const d of pairwiseDistances(leafPoints)) {
      expect(d).toBeGreaterThanOrEqual(NODE_W - 1e-6);
    }
  });

  it("places every leaf with no overlaps for a large leaf count spanning several rings", () => {
    const { leafIds } = graphWithPoleLeaves(40);
    const { targets } = placeExpandedNodes({});

    const leafPoints = leafIds.map((id) => targets.get(id));
    expect(leafPoints.every(Boolean)).toBe(true);
    for (const d of pairwiseDistances(leafPoints)) {
      expect(d).toBeGreaterThanOrEqual(NODE_W - 1e-6);
    }
  });

  it("dandelion radius (max leaf distance from the pole) grows with the leaf count", () => {
    const radiusFor = (n) => {
      const { poleId, leafIds } = graphWithPoleLeaves(n);
      const { targets } = placeExpandedNodes({});
      const pole = targets.get(poleId);
      return Math.max(
        ...leafIds.map((id) => {
          const p = targets.get(id);
          return Math.hypot(p.x - pole.x, p.y - pole.y);
        }),
      );
    };

    const r5 = radiusFor(5);
    State.graphNodes = [];
    State.graphEdges = [];
    const r40 = radiusFor(40);

    expect(r40).toBeGreaterThan(r5);
  });

  it("a pole with zero leaves still gets its own target, with no leaf targets", () => {
    const { poleId } = graphWithPoleLeaves(0);
    const { targets } = placeExpandedNodes({});
    expect(targets.has(poleId)).toBe(true);
    expect(targets.size).toBe(1);
  });
});

describe("placeExpandedNodes — Euler zone for a shared leaf between two poles", () => {
  beforeEach(() => {
    State.graphNodes = [];
    State.graphEdges = [];
    State.currentSeedId = null;
    State.expandedNodes = new Set();
    State.network = {};
    State.nodesDS = {};
  });

  it("puts a single shared leaf between the angular ranges of its two owning poles", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3,
      sharedLeaf = 200;

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      { id: sharedLeaf, isSeed: false },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      { from: poleA, to: sharedLeaf, weight: 1 },
      { from: poleB, to: sharedLeaf, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const { targets } = placeExpandedNodes({});
    const A = targets.get(poleA),
      B = targets.get(poleB),
      L = targets.get(sharedLeaf);
    expect(A).toBeTruthy();
    expect(B).toBeTruthy();
    expect(L).toBeTruthy();

    const thA = Math.atan2(A.y, A.x),
      thB = Math.atan2(B.y, B.x),
      thL = Math.atan2(L.y, L.x);
    const norm = (a) => {
      let x = a;
      while (x <= -Math.PI) x += 2 * Math.PI;
      while (x > Math.PI) x -= 2 * Math.PI;
      return x;
    };
    const dAB = norm(thB - thA);
    const dAL = norm(thL - thA);
    expect(Math.sign(dAL)).toBe(Math.sign(dAB));
    expect(Math.abs(dAL)).toBeLessThan(Math.abs(dAB));
    expect(Math.abs(dAL)).toBeGreaterThan(0);
  });

  it("spreads 3+ shared leaves in a cluster around the zone center, not in a straight line", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3;
    const sharedLeaves = [200, 201, 202];

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      ...sharedLeaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      ...sharedLeaves.map((id) => ({ from: poleA, to: id, weight: 1 })),
      ...sharedLeaves.map((id) => ({ from: poleB, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const savedPositions = {
      [poleA]: { x: 900, y: 0 },
      [poleB]: { x: 0, y: 900 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const leafPoints = sharedLeaves.map((id) => targets.get(id));
    expect(leafPoints.every(Boolean)).toBe(true);

    const [p0, p1, p2] = leafPoints;
    const cross = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
    expect(Math.abs(cross)).toBeGreaterThan(1);

    for (const d of pairwiseDistances(leafPoints)) {
      expect(d).toBeGreaterThan(0);
    }
  });

  it("spills a large shared-leaf zone into multiple concentric rings instead of one giant ring", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3;
    const sharedLeaves = Array.from({ length: 40 }, (_, i) => 200 + i);

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      ...sharedLeaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      ...sharedLeaves.map((id) => ({ from: poleA, to: id, weight: 1 })),
      ...sharedLeaves.map((id) => ({ from: poleB, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const savedPositions = {
      [poleA]: { x: 900, y: 0 },
      [poleB]: { x: 0, y: 900 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const leafPoints = sharedLeaves.map((id) => targets.get(id));
    expect(leafPoints.every(Boolean)).toBe(true);

    for (const d of pairwiseDistances(leafPoints)) {
      expect(d).toBeGreaterThanOrEqual(NODE_W - 4);
    }

    const cx = leafPoints.reduce((s, p) => s + p.x, 0) / leafPoints.length;
    const cy = leafPoints.reduce((s, p) => s + p.y, 0) / leafPoints.length;
    const radii = leafPoints.map((p) => Math.hypot(p.x - cx, p.y - cy));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(NODE_W);
  });

  it("keeps a shared leaf's reach from each owning pole bounded — no runaway divergent arcs — even in the unavoidable exactly-2-poles case", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3,
      sharedLeaf = 200;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      { id: sharedLeaf, isSeed: false },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      { from: poleA, to: sharedLeaf, weight: 1 },
      { from: poleB, to: sharedLeaf, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const { targets } = placeExpandedNodes({});
    const A = targets.get(poleA),
      B = targets.get(poleB),
      L = targets.get(sharedLeaf);
    const seedToPoleReach = Math.max(Math.hypot(A.x, A.y), Math.hypot(B.x, B.y));
    const poleToLeafReach = Math.max(
      Math.hypot(L.x - A.x, L.y - A.y),
      Math.hypot(L.x - B.x, L.y - B.y),
    );

    expect(poleToLeafReach).toBeLessThan(seedToPoleReach * 1.5);
  });

  it("places a shared leaf on the same ray as the literal midpoint of its two owning poles when a third pole breaks exact angular opposition", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3,
      poleC = 4,
      sharedLeaf = 200;
    const cLeaves = [400, 401, 402, 403, 404, 405, 406, 407];
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      { id: poleC, isSeed: false },
      { id: sharedLeaf, isSeed: false },
      ...cLeaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      { from: seedId, to: poleC, weight: 1 },
      { from: poleA, to: sharedLeaf, weight: 1 },
      { from: poleB, to: sharedLeaf, weight: 1 },
      ...cLeaves.map((id) => ({ from: poleC, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB, poleC]);

    const { targets } = placeExpandedNodes({});
    const A = targets.get(poleA),
      B = targets.get(poleB),
      L = targets.get(sharedLeaf);
    const midX = (A.x + B.x) / 2,
      midY = (A.y + B.y) / 2;
    const midDist = Math.hypot(midX, midY);
    expect(midDist).toBeGreaterThan(50);
    const midAngle = Math.atan2(midY, midX);
    const leafAngle = Math.atan2(L.y, L.x);
    const norm = (a) => {
      let x = a;
      while (x <= -Math.PI) x += 2 * Math.PI;
      while (x > Math.PI) x -= 2 * Math.PI;
      return x;
    };
    expect(Math.abs(norm(leafAngle - midAngle))).toBeLessThan(0.05);
  });
});

describe("placeExpandedNodes — nested (2nd-degree) pole placement", () => {
  beforeEach(() => {
    State.graphNodes = [];
    State.graphEdges = [];
    State.currentSeedId = null;
    State.expandedNodes = new Set();
    State.network = {};
    State.nodesDS = {};
  });

  it("anchors a nested pole near its true parent pole, not on the seed's own orbit", () => {
    const seedId = 1,
      poleA = 2,
      nestedPole = 200;

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: nestedPole, isSeed: false, _expandParent: poleA },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: poleA, to: nestedPole, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, nestedPole]);

    const savedPositions = { [poleA]: { x: 900, y: 0 } };
    const { targets } = placeExpandedNodes(savedPositions);
    const A = targets.get(poleA),
      N = targets.get(nestedPole);
    expect(A).toBeTruthy();
    expect(N).toBeTruthy();

    const distFromParent = Math.hypot(N.x - A.x, N.y - A.y);
    const distFromSeed = Math.hypot(N.x, N.y);

    expect(distFromParent).toBeLessThan(400);
    expect(distFromSeed).toBeGreaterThan(A.x - 50);
  });

  it("fans multiple children of the same nested parent apart instead of stacking them", () => {
    const seedId = 1,
      poleA = 2;
    const children = [200, 201, 202];

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      ...children.map((id) => ({ id, isSeed: false, _expandParent: poleA })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      ...children.map((id) => ({ from: poleA, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, ...children]);

    const savedPositions = { [poleA]: { x: 900, y: 0 } };
    const { targets } = placeExpandedNodes(savedPositions);
    const points = children.map((id) => targets.get(id));
    expect(points.every(Boolean)).toBe(true);
    for (const d of pairwiseDistances(points)) {
      expect(d).toBeGreaterThan(1);
    }
  });

  it("keeps a neighboring root pole's leaves clear of another pole's nested subtree", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3,
      nestedUnderA = 200;
    const aLeaves = Array.from({ length: 12 }, (_, i) => 1000 + i);
    const nestedLeaves = Array.from({ length: 20 }, (_, i) => 2000 + i);
    const bLeaves = Array.from({ length: 10 }, (_, i) => 3000 + i);

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      { id: nestedUnderA, isSeed: false, _expandParent: poleA },
      ...aLeaves.map((id) => ({ id, isSeed: false })),
      ...nestedLeaves.map((id) => ({ id, isSeed: false })),
      ...bLeaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      { from: poleA, to: nestedUnderA, weight: 1 },
      ...aLeaves.map((id) => ({ from: poleA, to: id, weight: 1 })),
      ...nestedLeaves.map((id) => ({ from: nestedUnderA, to: id, weight: 1 })),
      ...bLeaves.map((id) => ({ from: poleB, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB, nestedUnderA]);

    const { targets } = placeExpandedNodes({});

    const aSidePoints = [poleA, nestedUnderA, ...aLeaves, ...nestedLeaves].map((id) =>
      targets.get(id),
    );
    const bSidePoints = [poleB, ...bLeaves].map((id) => targets.get(id));
    expect(aSidePoints.every(Boolean)).toBe(true);
    expect(bSidePoints.every(Boolean)).toBe(true);

    let minCrossDist = Infinity;
    for (const a of aSidePoints) {
      for (const b of bSidePoints) {
        minCrossDist = Math.min(minCrossDist, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    expect(minCrossDist).toBeGreaterThan(300);
  });
});

describe("placeExpandedNodes — seed as an Euler-zone owner", () => {
  beforeEach(() => {
    State.graphNodes = [];
    State.graphEdges = [];
    State.currentSeedId = null;
    State.expandedNodes = new Set();
    State.network = {};
    State.nodesDS = {};
  });

  it("puts a leaf shared between the seed and a pole on the seed-pole line, not just in the pole's own ring", () => {
    const seedId = 1,
      poleA = 2,
      sharedLeaf = 100,
      exclusiveLeaf = 101;

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: sharedLeaf, isSeed: false },
      { id: exclusiveLeaf, isSeed: false },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: sharedLeaf, weight: 1 },
      { from: poleA, to: sharedLeaf, weight: 1 },
      { from: poleA, to: exclusiveLeaf, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA]);

    const savedPositions = { [poleA]: { x: 900, y: 0 } };
    const { targets } = placeExpandedNodes(savedPositions);
    const A = targets.get(poleA),
      L = targets.get(sharedLeaf),
      E = targets.get(exclusiveLeaf);
    expect(A).toBeTruthy();
    expect(L).toBeTruthy();
    expect(E).toBeTruthy();

    const t = (L.x * A.x + L.y * A.y) / (A.x * A.x + A.y * A.y);
    const projX = A.x * t,
      projY = A.y * t;
    expect(Math.hypot(L.x - projX, L.y - projY)).toBeLessThan(1);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);

    expect(Math.hypot(E.x - A.x, E.y - A.y)).toBeLessThan(400);
  });

  it("still gives a seed-only leaf (no pole connection at all) its own dandelion slot", () => {
    const seedId = 1,
      poleA = 2,
      seedOnlyLeaf = 300;

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: seedOnlyLeaf, isSeed: false },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: seedOnlyLeaf, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA]);

    const savedPositions = { [poleA]: { x: 900, y: 0 } };
    const { targets } = placeExpandedNodes(savedPositions);
    const L = targets.get(seedOnlyLeaf);
    expect(L).toBeTruthy();
    expect(Math.hypot(L.x, L.y)).toBeGreaterThan(1);
  });
});

function minSepWithSeed(targets) {
  const pts = [{ x: 0, y: 0 }, ...targets.values()];
  let min = Infinity;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  return min;
}

function buildMultiPoleGraph() {
  const seedId = 1;
  const poles = [2, 3, 4];
  const exclusive = {
    2: [200, 201, 202, 203, 204, 205, 206, 207, 208, 209],
    3: [300, 301, 302, 303, 304, 305, 306, 307],
    4: [400, 401, 402, 403, 404, 405],
  };
  const shared23 = [5000, 5001, 5002, 5003, 5004];
  const shared34 = [6000, 6001, 6002];
  const sharedSeed2 = [7000, 7001];

  const nodes = [{ id: seedId, isSeed: true }, ...poles.map((id) => ({ id, isSeed: false }))];
  const edges = poles.map((id) => ({ from: seedId, to: id, weight: 1 }));

  for (const [pole, leaves] of Object.entries(exclusive)) {
    for (const l of leaves) {
      nodes.push({ id: l, isSeed: false });
      edges.push({ from: Number(pole), to: l, weight: 1 });
    }
  }
  for (const l of shared23) {
    nodes.push({ id: l, isSeed: false });
    edges.push({ from: 2, to: l, weight: 1 }, { from: 3, to: l, weight: 1 });
  }
  for (const l of shared34) {
    nodes.push({ id: l, isSeed: false });
    edges.push({ from: 3, to: l, weight: 1 }, { from: 4, to: l, weight: 1 });
  }
  for (const l of sharedSeed2) {
    nodes.push({ id: l, isSeed: false });
    edges.push({ from: seedId, to: l, weight: 1 }, { from: 2, to: l, weight: 1 });
  }

  State.graphNodes = nodes;
  State.graphEdges = edges;
  State.currentSeedId = seedId;
  State.expandedNodes = new Set(poles);
  State.network = {};
  State.nodesDS = {};

  return { seedId, poles, exclusive, shared23, shared34, sharedSeed2 };
}

describe("[SF-WEB-51] placeExpandedNodes — global no-overlap guarantee", () => {
  beforeEach(() => {
    State.graphNodes = [];
    State.graphEdges = [];
    State.currentSeedId = null;
    State.expandedNodes = new Set();
    State.network = {};
    State.nodesDS = {};
  });

  it("multi-pole graph with Euler lenses: EVERY pair of targets (and the seed) is ≥ MIN_SEP — zero overlaps", () => {
    buildMultiPoleGraph();
    const { targets } = placeExpandedNodes({});
    expect(minSepWithSeed(targets)).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });

  it("dandelions of different poles do not intersect (pole↔pole distance ≥ Rp_i + Rp_j)", () => {
    const { poles, exclusive } = buildMultiPoleGraph();
    const { targets } = placeExpandedNodes({});
    const rp = {};
    for (const p of poles) {
      const pole = targets.get(p);
      rp[p] = Math.max(
        ...exclusive[p].map((l) => {
          const t = targets.get(l);
          return Math.hypot(t.x - pole.x, t.y - pole.y);
        }),
      );
    }
    for (let i = 0; i < poles.length; i++)
      for (let j = i + 1; j < poles.length; j++) {
        const A = targets.get(poles[i]),
          B = targets.get(poles[j]);
        const d = Math.hypot(A.x - B.x, A.y - B.y);
        expect(d).toBeGreaterThanOrEqual(rp[poles[i]] + rp[poles[j]] - 1e-6);
      }
  });

  it("Euler-lens leaves do not cross the parent poles' own dandelions (every cross pair ≥ MIN_SEP)", () => {
    const { exclusive, shared23 } = buildMultiPoleGraph();
    const { targets } = placeExpandedNodes({});
    const lensPts = shared23.map((l) => targets.get(l));
    const parentPts = [...exclusive[2], ...exclusive[3]].map((l) => targets.get(l));
    let minCross = Infinity;
    for (const a of lensPts)
      for (const b of parentPts) minCross = Math.min(minCross, Math.hypot(a.x - b.x, a.y - b.y));
    expect(minCross).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });

  it("initial seed-only graph: leaves land in rings ≥ MIN_SEP apart, none piled at the origin", () => {
    const seedId = 1;
    const leaves = Array.from({ length: 24 }, (_, i) => 100 + i);
    State.graphNodes = [
      { id: seedId, isSeed: true },
      ...leaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = leaves.map((id) => ({ from: seedId, to: id, weight: 1 }));
    State.currentSeedId = seedId;
    State.expandedNodes = new Set();
    const { targets } = placeExpandedNodes({});
    expect(targets.size).toBe(leaves.length);
    expect(minSepWithSeed(targets)).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
    for (const l of leaves) expect(Math.hypot(...Object.values(targets.get(l)))).toBeGreaterThan(1);
  });

  it("is deterministic — the same input yields byte-identical targets on a repeat run", () => {
    buildMultiPoleGraph();
    const a = placeExpandedNodes({});
    buildMultiPoleGraph();
    const b = placeExpandedNodes({});
    expect([...a.targets.keys()].sort()).toEqual([...b.targets.keys()].sort());
    for (const id of a.targets.keys()) {
      expect(b.targets.get(id)).toEqual(a.targets.get(id));
    }
  });

  it("large graph (N > LARGE_GRAPH_NODE_THRESHOLD): zero overlaps after the engine, no reliance on physics", () => {
    const seedId = 1;
    const poles = [2, 3, 4, 5, 6, 7];
    const nodes = [{ id: seedId, isSeed: true }, ...poles.map((id) => ({ id, isSeed: false }))];
    const edges = poles.map((id) => ({ from: seedId, to: id, weight: 1 }));
    let leafId = 1000;
    for (const p of poles) {
      for (let i = 0; i < 30; i++) {
        const l = leafId++;
        nodes.push({ id: l, isSeed: false });
        edges.push({ from: p, to: l, weight: 1 });
      }
    }
    State.graphNodes = nodes;
    State.graphEdges = edges;
    State.currentSeedId = seedId;
    State.expandedNodes = new Set(poles);
    State.network = {};
    State.nodesDS = {};

    expect(nodes.length).toBeGreaterThan(150);
    const { targets } = placeExpandedNodes({});
    expect(minSepWithSeed(targets)).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });
});

describe("[SF-WEB-51] resolveCollisions — deterministic grid solver", () => {
  function minPair(targets) {
    const pts = [...targets.values()];
    let m = Infinity;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        m = Math.min(m, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    return m;
  }

  it("monotonically separates an overlapping cluster toward MIN_SEP within the cap", () => {
    const targets = new Map();
    let id = 0;
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 5; c++) targets.set(id++, { x: c * 70, y: r * 70 });
    const before = minPair(targets);
    resolveCollisions(targets, new Set(), null);
    const after = minPair(targets);
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThanOrEqual(MIN_SEP * 0.95);
  });

  it("never moves a pinned point, and pushes an overlapping movable point off it", () => {
    const targets = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 5, y: 0 }],
    ]);
    resolveCollisions(targets, new Set([1]), null);
    expect(targets.get(1)).toEqual({ x: 0, y: 0 });
    expect(Math.hypot(...Object.values(targets.get(2)))).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });

  const dist = (t, a, b) => Math.hypot(t.get(a).x - t.get(b).x, t.get(a).y - t.get(b).y);

  it("зазор между секторами покрывает падинг оболочки с обеих сторон", () => {
    expect(CLUSTER_GAP).toBe(2 * NODE_GAP);
  });

  it("разводит узлы РАЗНЫХ секторов шире, чем просто MIN_SEP", () => {
    const targets = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 10, y: 0 }],
    ]);
    const sectors = new Map([
      [1, new Set(["A"])],
      [2, new Set(["B"])],
    ]);
    resolveCollisions(targets, new Set(), null, sectors);
    expect(dist(targets, 1, 2)).toBeGreaterThanOrEqual(MIN_SEP + CLUSTER_GAP - 1e-6);
  });

  it("НЕ раздвигает узлы одного сектора — оболочка обнимает их обоих", () => {
    const targets = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 10, y: 0 }],
    ]);
    const sectors = new Map([
      [1, new Set(["A"])],
      [2, new Set(["A"])],
    ]);
    resolveCollisions(targets, new Set(), null, sectors);
    const d = dist(targets, 1, 2);
    expect(d).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
    expect(d).toBeLessThan(MIN_SEP + CLUSTER_GAP);
  });

  it("узлы линзы Эйлера (общий сектор) считаются своими для обоих владельцев", () => {
    const targets = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 10, y: 0 }],
      [3, { x: 20, y: 0 }],
    ]);
    const sectors = new Map([
      [1, new Set(["A"])],
      [2, new Set(["A", "B"])],
      [3, new Set(["B"])],
    ]);
    resolveCollisions(targets, new Set(), null, sectors);
    expect(dist(targets, 1, 2)).toBeLessThan(MIN_SEP + CLUSTER_GAP);
    expect(dist(targets, 2, 3)).toBeLessThan(MIN_SEP + CLUSTER_GAP);
    expect(dist(targets, 1, 3)).toBeGreaterThanOrEqual(MIN_SEP + CLUSTER_GAP - 1e-6);
  });

  it("узел без сектора оболочки не имеет и лишнего зазора не требует", () => {
    const targets = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 10, y: 0 }],
    ]);
    const sectors = new Map([[1, new Set(["A"])]]);
    resolveCollisions(targets, new Set(), null, sectors);
    expect(dist(targets, 1, 2)).toBeLessThan(MIN_SEP + CLUSTER_GAP);
  });

  it("приколотый сид тоже участвует своим сектором (extraPinned с ключом)", () => {
    const targets = new Map([[2, { x: 10, y: 0 }]]);
    const sectors = new Map([
      [1, new Set(["SEED"])],
      [2, new Set(["B"])],
    ]);
    resolveCollisions(targets, new Set(), new Map([[1, { x: 0, y: 0 }]]), sectors);
    expect(Math.hypot(targets.get(2).x, targets.get(2).y)).toBeGreaterThanOrEqual(
      MIN_SEP + CLUSTER_GAP - 1e-6,
    );
  });

  it("без карты секторов поведение ровно прежнее", () => {
    const mk = () =>
      new Map([
        [1, { x: 0, y: 0 }],
        [2, { x: 10, y: 0 }],
      ]);
    const a = mk();
    resolveCollisions(a, new Set(), null);
    const b = mk();
    resolveCollisions(b, new Set(), null, undefined);
    expect([...b]).toEqual([...a]);
    expect(dist(a, 1, 2)).toBeLessThan(MIN_SEP + CLUSTER_GAP);
  });

  it("остаётся детерминированным: один вход → один выход", () => {
    const mk = () =>
      new Map([
        [1, { x: 0, y: 0 }],
        [2, { x: 3, y: 4 }],
        [3, { x: 1, y: 1 }],
      ]);
    const sectors = new Map([
      [1, new Set(["A"])],
      [2, new Set(["B"])],
      [3, new Set(["C"])],
    ]);
    const a = mk();
    resolveCollisions(a, new Set(), null, sectors);
    const b = mk();
    resolveCollisions(b, new Set(), null, sectors);
    expect([...b]).toEqual([...a]);
  });

  it("has a hard, finite iteration cap (cannot hang)", () => {
    expect(Number.isInteger(SOLVER_ITERS)).toBe(true);
    expect(SOLVER_ITERS).toBeGreaterThan(0);
    expect(SOLVER_ITERS).toBeLessThanOrEqual(8);
  });

  it("MIN_SEP is the single metric NODE_W now aliases", () => {
    expect(NODE_W).toBe(MIN_SEP);
    expect(MIN_SEP).toBe(78);
  });
});

function sectorsDisjoint(anglesA, anglesB) {
  const pts = [...anglesA.map((a) => [a, "A"]), ...anglesB.map((a) => [a, "B"])].sort(
    (x, y) => x[0] - y[0],
  );
  let changes = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i][1] !== pts[(i + 1) % pts.length][1]) changes++;
  }
  return changes <= 2;
}

function anglesOf(targets, ids) {
  return ids.map((id) => {
    const t = targets.get(id);
    return Math.atan2(t.y, t.x);
  });
}

describe("[SF-WEB-52] sector layout", () => {
  beforeEach(() => {
    State.graphNodes = [];
    State.graphEdges = [];
    State.currentSeedId = null;
    State.expandedNodes = new Set();
    State.network = {};
    State.nodesDS = {};
  });

  it("(а) two poles' whole subtrees lie in non-overlapping angular sectors", () => {
    const seedId = 1;
    const poleTwo = 2,
      nestedThree = 3;
    const twoLeaves = [200, 201, 202, 203];
    const threeLeaves = [300, 301, 302];
    const poleFive = 5;
    const fiveLeaves = [500, 501, 502, 503, 504];

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleTwo, isSeed: false },
      { id: nestedThree, isSeed: false, _expandParent: poleTwo },
      { id: poleFive, isSeed: false },
      ...twoLeaves.map((id) => ({ id, isSeed: false })),
      ...threeLeaves.map((id) => ({ id, isSeed: false })),
      ...fiveLeaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleTwo, weight: 1 },
      { from: seedId, to: poleFive, weight: 1 },
      { from: poleTwo, to: nestedThree, weight: 1 },
      ...twoLeaves.map((id) => ({ from: poleTwo, to: id, weight: 1 })),
      ...threeLeaves.map((id) => ({ from: nestedThree, to: id, weight: 1 })),
      ...fiveLeaves.map((id) => ({ from: poleFive, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleTwo, nestedThree, poleFive]);

    const { targets } = placeExpandedNodes({});
    const subtreeTwo = [poleTwo, nestedThree, ...twoLeaves, ...threeLeaves];
    const subtreeFive = [poleFive, ...fiveLeaves];

    expect(sectorsDisjoint(anglesOf(targets, subtreeTwo), anglesOf(targets, subtreeFive))).toBe(
      true,
    );
  });

  it("(б) root pole angles are id-derived and independent of subtree weight, without overlapping", () => {
    const seedId = 1;
    const roots = { 2: [210, 211], 3: [310, 311, 312, 313], 4: [410, 411, 412, 413, 414, 415] };
    State.graphNodes = [{ id: seedId, isSeed: true }];
    State.graphEdges = [];
    for (const [pole, leaves] of Object.entries(roots)) {
      State.graphNodes.push({ id: Number(pole), isSeed: false });
      State.graphEdges.push({ from: seedId, to: Number(pole), weight: 1 });
      for (const l of leaves) {
        State.graphNodes.push({ id: l, isSeed: false });
        State.graphEdges.push({ from: Number(pole), to: l, weight: 1 });
      }
    }
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([2, 3, 4]);

    const { targets } = placeExpandedNodes({});
    const norm = (a) => {
      let x = a;
      while (x <= -Math.PI) x += 2 * Math.PI;
      while (x > Math.PI) x -= 2 * Math.PI;
      return x;
    };
    const angle = (pole) => norm(Math.atan2(targets.get(pole).y, targets.get(pole).x));

    State.graphEdges = State.graphEdges.filter((e) => e.from !== 4 || e.to === 410);
    State.graphNodes = State.graphNodes.filter((n) => ![411, 412, 413, 414, 415].includes(n.id));
    const { targets: targets2 } = placeExpandedNodes({});

    expect(angle(2)).toBeCloseTo(norm(Math.atan2(targets2.get(2).y, targets2.get(2).x)), 6);
    expect(angle(3)).toBeCloseTo(norm(Math.atan2(targets2.get(3).y, targets2.get(3).x)), 6);

    const pts = [2, 3, 4].map((p) => targets.get(p));
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThanOrEqual(NODE_W);
  });

  it("(в) a shared leaf sits angularly between its two owning poles", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3;
    const aLeaves = [200, 201, 202];
    const bLeaves = [300, 301, 302];
    const shared = 900;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      ...aLeaves.map((id) => ({ id, isSeed: false })),
      ...bLeaves.map((id) => ({ id, isSeed: false })),
      { id: shared, isSeed: false },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      ...aLeaves.map((id) => ({ from: poleA, to: id, weight: 1 })),
      ...bLeaves.map((id) => ({ from: poleB, to: id, weight: 1 })),
      { from: poleA, to: shared, weight: 1 },
      { from: poleB, to: shared, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const { targets } = placeExpandedNodes({});
    const A = targets.get(poleA),
      B = targets.get(poleB),
      L = targets.get(shared);
    const norm = (a) => {
      let x = a;
      while (x <= -Math.PI) x += 2 * Math.PI;
      while (x > Math.PI) x -= 2 * Math.PI;
      return x;
    };
    const thA = Math.atan2(A.y, A.x),
      thB = Math.atan2(B.y, B.x),
      thL = Math.atan2(L.y, L.x);
    const dAB = norm(thB - thA),
      dAL = norm(thL - thA);
    expect(Math.sign(dAL)).toBe(Math.sign(dAB));
    expect(Math.abs(dAL)).toBeLessThan(Math.abs(dAB));
  });

  it("(г) keeps the SF-WEB-51 guarantee: all pairs ≥ MIN_SEP", () => {
    buildMultiPoleGraph();
    const { targets } = placeExpandedNodes({});
    expect(minSepWithSeed(targets)).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });

  it("(д) is deterministic: identical targets on a repeat run", () => {
    buildMultiPoleGraph();
    const a = placeExpandedNodes({});
    buildMultiPoleGraph();
    const b = placeExpandedNodes({});
    for (const id of a.targets.keys()) {
      expect(b.targets.get(id)).toEqual(a.targets.get(id));
    }
  });
});

describe("[SF-WEB-53] cluster gap", () => {
  beforeEach(() => {
    State.graphNodes = [];
    State.graphEdges = [];
    State.currentSeedId = null;
    State.expandedNodes = new Set();
    State.network = {};
    State.nodesDS = {};
  });

  it("two sibling poles' dandelion clouds clear each other by more than plain MIN_SEP", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3;
    const aLeaves = [200, 201, 202, 203];
    const bLeaves = [300, 301, 302, 303];
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      ...aLeaves.map((id) => ({ id, isSeed: false })),
      ...bLeaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      ...aLeaves.map((id) => ({ from: poleA, to: id, weight: 1 })),
      ...bLeaves.map((id) => ({ from: poleB, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const { targets } = placeExpandedNodes({});
    const A = targets.get(poleA),
      B = targets.get(poleB);
    const poleDist = Math.hypot(A.x - B.x, A.y - B.y);
    const rA = Math.max(
      ...aLeaves.map((id) => {
        const t = targets.get(id);
        return Math.hypot(t.x - A.x, t.y - A.y);
      }),
    );
    const rB = Math.max(
      ...bLeaves.map((id) => {
        const t = targets.get(id);
        return Math.hypot(t.x - B.x, t.y - B.y);
      }),
    );
    const clusterGap = poleDist - rA - rB;
    expect(clusterGap).toBeGreaterThan(MIN_SEP * 1.5);
  });

  it("intra-ring node spacing is unaffected: still exactly MIN_SEP-bounded", () => {
    buildMultiPoleGraph();
    const { targets } = placeExpandedNodes({});
    expect(minSepWithSeed(targets)).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });

  it("clears a distinguishable gap even with many narrow-wedge sibling poles", () => {
    const seedId = 1;
    const N = 10;
    State.graphNodes = [{ id: seedId, isSeed: true }];
    State.graphEdges = [];
    const poles = [];
    for (let p = 0; p < N; p++) {
      const poleId = 100 + p;
      poles.push(poleId);
      State.graphNodes.push({ id: poleId, isSeed: false });
      State.graphEdges.push({ from: seedId, to: poleId, weight: 1 });
      for (let l = 0; l < 3; l++) {
        const leafId = 1000 + p * 10 + l;
        State.graphNodes.push({ id: leafId, isSeed: false });
        State.graphEdges.push({ from: poleId, to: leafId, weight: 1 });
      }
    }
    State.currentSeedId = seedId;
    State.expandedNodes = new Set(poles);

    const { targets } = placeExpandedNodes({});
    const poleR = new Map(
      poles.map((poleId) => {
        const P = targets.get(poleId);
        const leafIds = [0, 1, 2].map((l) => 1000 + (poleId - 100) * 10 + l);
        const r = Math.max(
          ...leafIds.map((id) => {
            const t = targets.get(id);
            return Math.hypot(t.x - P.x, t.y - P.y);
          }),
        );
        return [poleId, r];
      }),
    );
    const byAngle = [...poles].sort(
      (a, b) =>
        Math.atan2(targets.get(a).y, targets.get(a).x) -
        Math.atan2(targets.get(b).y, targets.get(b).x),
    );
    for (let i = 0; i < byAngle.length; i++) {
      const a = byAngle[i],
        b = byAngle[(i + 1) % byAngle.length];
      const A = targets.get(a),
        B = targets.get(b);
      const dist = Math.hypot(A.x - B.x, A.y - B.y);
      const gap = dist - poleR.get(a) - poleR.get(b);
      expect(gap).toBeGreaterThan(MIN_SEP * 0.75);
    }
  });
});

describe("[SF-WEB-55] edgeClass", () => {
  beforeEach(() => {
    State.graphNodes = [];
    State.graphEdges = [];
    State.currentSeedId = null;
    State.expandedNodes = new Set();
    State.network = {};
    State.nodesDS = {};
  });

  it("classifies seed→pole and pole→exclusive-leaf edges as intra", () => {
    const seedId = 1,
      poleA = 2;
    const leaves = [200, 201, 202];
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      ...leaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
      ...leaves.map((id) => ({ id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA]);

    const { edgeClass } = placeExpandedNodes({});
    expect(edgeClass.get(`${seedId}_${poleA}`).kind).toBe("intra");
    for (const leaf of leaves) {
      expect(edgeClass.get(`${poleA}_${leaf}`).kind).toBe("intra");
    }
  });

  it("classifies a nested pole's tree edge as intra", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false, _expandParent: poleA },
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
      { id: `${poleA}_${poleB}`, from: poleA, to: poleB, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const { edgeClass } = placeExpandedNodes({});
    expect(edgeClass.get(`${poleA}_${poleB}`).kind).toBe("intra");
  });

  it("classifies a shared (Euler) leaf's edges to both owning poles as cross, hub = seed (different root sectors)", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3,
      shared = 900;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      { id: shared, isSeed: false },
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
      { id: `${seedId}_${poleB}`, from: seedId, to: poleB, weight: 1 },
      { id: `${poleA}_${shared}`, from: poleA, to: shared, weight: 1 },
      { id: `${poleB}_${shared}`, from: poleB, to: shared, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const { edgeClass } = placeExpandedNodes({});
    const eA = edgeClass.get(`${poleA}_${shared}`);
    const eB = edgeClass.get(`${poleB}_${shared}`);
    expect(eA.kind).toBe("cross");
    expect(eB.kind).toBe("cross");
    expect(eA.hub).toBeNull();
    expect(eB.hub).toBeNull();
  });

  it("classifies a leaf↔leaf edge within the same subtree as cross with hub = their shared root pole", () => {
    const seedId = 1,
      poleA = 2;
    const leafX = 200,
      leafY = 201;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: leafX, isSeed: false },
      { id: leafY, isSeed: false },
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
      { id: `${poleA}_${leafX}`, from: poleA, to: leafX, weight: 1 },
      { id: `${poleA}_${leafY}`, from: poleA, to: leafY, weight: 1 },
      { id: `${leafX}_${leafY}`, from: leafX, to: leafY, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA]);

    const { edgeClass } = placeExpandedNodes({});
    const cross = edgeClass.get(`${leafX}_${leafY}`);
    expect(cross.kind).toBe("cross");
    expect(cross.hub).toBe(poleA);
  });

  it("covers every edge in the graph — nothing is left unclassified", () => {
    buildMultiPoleGraph();
    const { edgeClass } = placeExpandedNodes({});
    expect(edgeClass.size).toBe(State.graphEdges.length);
    for (const e of State.graphEdges) {
      const key = e.id ?? `${Math.min(e.from, e.to)}_${Math.max(e.from, e.to)}`;
      expect(edgeClass.has(key)).toBe(true);
    }
  });
});

describe("[SF-WEB-56] cluster gap scales with shared-member count", () => {
  beforeEach(() => {
    State.graphNodes = [];
    State.graphEdges = [];
    State.currentSeedId = null;
    State.expandedNodes = new Set();
    State.network = {};
    State.nodesDS = {};
  });

  function buildTwoPoleGraph(seedId, poleA, poleB, sharedCount) {
    const aLeaves = [200, 201, 202, 203];
    const bLeaves = [300, 301, 302, 303];
    const shared = Array.from({ length: sharedCount }, (_, i) => 9000 + i);
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      ...aLeaves.map((id) => ({ id, isSeed: false })),
      ...bLeaves.map((id) => ({ id, isSeed: false })),
      ...shared.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
      { id: `${seedId}_${poleB}`, from: seedId, to: poleB, weight: 1 },
      ...aLeaves.map((id) => ({ id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 })),
      ...bLeaves.map((id) => ({ id: `${poleB}_${id}`, from: poleB, to: id, weight: 1 })),
      ...shared.flatMap((id) => [
        { id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 },
        { id: `${poleB}_${id}`, from: poleB, to: id, weight: 1 },
      ]),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);
  }

  it("two poles with a LARGE shared lens end up farther apart than two poles with none", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3;
    buildTwoPoleGraph(seedId, poleA, poleB, 0);
    const { targets: targetsNoShare } = placeExpandedNodes({});
    const distNoShare = Math.hypot(
      targetsNoShare.get(poleA).x - targetsNoShare.get(poleB).x,
      targetsNoShare.get(poleA).y - targetsNoShare.get(poleB).y,
    );

    buildTwoPoleGraph(seedId, poleA, poleB, 8);
    const { targets: targetsShared } = placeExpandedNodes({});
    const distShared = Math.hypot(
      targetsShared.get(poleA).x - targetsShared.get(poleB).x,
      targetsShared.get(poleA).y - targetsShared.get(poleB).y,
    );

    expect(distShared).toBeGreaterThan(distNoShare);
  });

  it("a pole with a LARGE lens shared with the seed sits farther from the seed than one with none", () => {
    const seedId = 1,
      poleA = 2;
    const aLeaves = [200, 201, 202, 203];
    const build = (sharedCount) => {
      const shared = Array.from({ length: sharedCount }, (_, i) => 9000 + i);
      State.graphNodes = [
        { id: seedId, isSeed: true },
        { id: poleA, isSeed: false },
        ...aLeaves.map((id) => ({ id, isSeed: false })),
        ...shared.map((id) => ({ id, isSeed: false })),
      ];
      State.graphEdges = [
        { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
        ...aLeaves.map((id) => ({ id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 })),
        ...shared.flatMap((id) => [
          { id: `${seedId}_${id}`, from: seedId, to: id, weight: 1 },
          { id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 },
        ]),
      ];
      State.currentSeedId = seedId;
      State.expandedNodes = new Set([poleA]);
    };

    build(0);
    const { targets: targetsNoShare } = placeExpandedNodes({});
    const rNoShare = Math.hypot(targetsNoShare.get(poleA).x, targetsNoShare.get(poleA).y);

    build(8);
    const { targets: targetsShared } = placeExpandedNodes({});
    const rShared = Math.hypot(targetsShared.get(poleA).x, targetsShared.get(poleA).y);

    expect(rShared).toBeGreaterThan(rNoShare);
  });

  const CONTOUR_BLUR_PX = 16;
  it("между краями оболочек разных секторов остаётся просвет шире размытия", async () => {
    const { computeSectorPolygon } = await import("./bubble-contours.js");
    const seedId = 1,
      poleA = 2,
      poleB = 3;
    buildTwoPoleGraph(seedId, poleA, poleB, 0);
    const { targets, sectorMembers } = placeExpandedNodes({});

    const posOf = (id) => targets.get(id) || (id === seedId ? { x: 0, y: 0 } : null);
    const hullOf = (sid) =>
      computeSectorPolygon([...sectorMembers.get(sid)].map(posOf).filter(Boolean));
    const hullA = hullOf(poleA),
      hullB = hullOf(poleB);
    expect(hullA.length).toBeGreaterThan(2);
    expect(hullB.length).toBeGreaterThan(2);

    let gap = Infinity;
    for (const p of hullA)
      for (const q of hullB) gap = Math.min(gap, Math.hypot(p.x - q.x, p.y - q.y));
    expect(gap).toBeGreaterThan(2 * CONTOUR_BLUR_PX);
  });

  it("держит просвет между оболочками на плотном графе с линзами Эйлера", async () => {
    const { computeSectorPolygon } = await import("./bubble-contours.js");
    const seedId = 1,
      poles = [2, 3, 4, 5];
    const nodes = [{ id: seedId, isSeed: true }, ...poles.map((id) => ({ id }))];
    const edges = poles.map((id) => ({ id: `s_${id}`, from: seedId, to: id, weight: 1 }));
    poles.forEach((p, pi) => {
      for (let k = 0; k < 10; k++) {
        const leaf = 1000 * (pi + 1) + k;
        nodes.push({ id: leaf });
        edges.push({ id: `p${pi}_${leaf}`, from: p, to: leaf, weight: 1 });
      }
    });
    for (let k = 0; k < 16; k++) {
      const leaf = 90000 + k;
      nodes.push({ id: leaf });
      edges.push({ id: `a_${leaf}`, from: poles[0], to: leaf, weight: 1 });
      edges.push({ id: `b_${leaf}`, from: poles[1], to: leaf, weight: 1 });
    }
    State.graphNodes = nodes;
    State.graphEdges = edges;
    State.currentSeedId = seedId;
    State.expandedNodes = new Set(poles);

    const { targets, sectorMembers } = placeExpandedNodes({});
    const posOf = (id) => targets.get(id) || (id === seedId ? { x: 0, y: 0 } : null);
    const hulls = new Map();
    for (const [sid, members] of sectorMembers) {
      const pts = [...members].map(posOf).filter(Boolean);
      if (pts.length >= 3) hulls.set(sid, computeSectorPolygon(pts));
    }

    const ids = [...hulls.keys()];
    let worst = Infinity;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = sectorMembers.get(ids[i]),
          b = sectorMembers.get(ids[j]);
        let shares = false;
        for (const m of a)
          if (b.has(m)) {
            shares = true;
            break;
          }
        if (shares) continue;
        for (const p of hulls.get(ids[i]))
          for (const q of hulls.get(ids[j])) {
            worst = Math.min(worst, Math.hypot(p.x - q.x, p.y - q.y));
          }
      }
    expect(worst).toBeGreaterThan(64);
  });

  it("keeps the SF-WEB-51 no-overlap guarantee under heavy sharing", () => {
    buildTwoPoleGraph(1, 2, 3, 12);
    const { targets } = placeExpandedNodes({});
    expect(minSepWithSeed(targets)).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });

  it("caps the extra shared-count gap — 80 shared members isn't dramatically farther than 20", () => {
    buildTwoPoleGraph(1, 2, 3, 20);
    const { targets: t20 } = placeExpandedNodes({});
    const d20 = Math.hypot(t20.get(2).x - t20.get(3).x, t20.get(2).y - t20.get(3).y);

    buildTwoPoleGraph(1, 2, 3, 80);
    const { targets: t80 } = placeExpandedNodes({});
    const d80 = Math.hypot(t80.get(2).x - t80.get(3).x, t80.get(2).y - t80.get(3).y);

    expect(d80).toBeGreaterThanOrEqual(d20);
    expect(d80).toBeLessThan(d20 * 1.5);
  });
});

describe("placeExpandedNodes — pole/seed pinning across re-layout (SF-WEB-59)", () => {
  it("keeps an already-placed pole's position exactly unchanged when a new sibling is expanded", () => {
    const seedId = 1,
      poleA = 2,
      poleC = 4;
    const aLeaves = [10, 11, 12];
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      ...aLeaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      ...aLeaves.map((id) => ({ from: poleA, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA]);

    const { targets: first } = placeExpandedNodes({});
    const firstPos = { ...first.get(poleA) };

    const cLeaves = [30, 31, 32, 33, 34];
    State.graphNodes.push(
      { id: poleC, isSeed: false },
      ...cLeaves.map((id) => ({ id, isSeed: false })),
    );
    State.graphEdges.push(
      { from: seedId, to: poleC, weight: 1 },
      ...cLeaves.map((id) => ({ from: poleC, to: id, weight: 1 })),
    );
    State.expandedNodes = new Set([poleA, poleC]);
    const savedPositions = { [poleA]: firstPos };
    const { targets: second } = placeExpandedNodes(savedPositions);

    expect(second.get(poleA)).toEqual(firstPos);
  });

  it("gives a pinned pole's fromPos equal to its target — zero animation for a node that isn't moving", () => {
    const seedId = 1,
      poleA = 2;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: 10, isSeed: false },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: poleA, to: 10, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA]);

    const { targets: first } = placeExpandedNodes({});
    const firstPos = { ...first.get(poleA) };
    const { targets: second, fromPos: fromPos2 } = placeExpandedNodes({ [poleA]: firstPos });
    expect(fromPos2.get(poleA)).toEqual(second.get(poleA));
  });

  it("a fresh pole's placement direction accounts for ALL its real hub connections, not only its expand-tree parent", () => {
    const seedId = 1,
      poleA = 2,
      poleB = 3,
      poleX = 200;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false, _poleSettled: true },
      { id: poleB, isSeed: false, _poleSettled: true },
      { id: poleX, isSeed: false, _expandParent: poleA },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      { from: poleA, to: poleX, weight: 1 },
      { from: poleB, to: poleX, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB, poleX]);

    const savedPositions = {
      [poleA]: { x: 1000, y: 0 },
      [poleB]: { x: 0, y: 1000 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const x = targets.get(poleX);
    const angle = Math.atan2(x.y, x.x);

    expect(Math.abs(angle)).toBeGreaterThan(0.1);
    expect(angle).toBeLessThan(Math.PI / 2);
  });

  it("gives a leaf being promoted to a pole for the first time a real pole placement, not its old leaf position", () => {
    const seedId = 1,
      poleA = 2,
      promoted = 300;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false, _poleSettled: true },
      { id: promoted, isSeed: false },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: poleA, to: promoted, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, promoted]);

    const oldLeafPos = { x: 160, y: 5 };
    const savedPositions = {
      [poleA]: { x: 900, y: 0 },
      [promoted]: oldLeafPos,
    };
    const { targets } = placeExpandedNodes(savedPositions);

    const newPos = targets.get(promoted);
    expect(newPos).not.toEqual(oldLeafPos);
    const distFromPoleA = Math.hypot(newPos.x - 900, newPos.y - 0);
    expect(distFromPoleA).toBeGreaterThan(200);
  });
});

describe("placeExpandedNodes — bounded radial growth for crowded shared-hub siblings (SF-WEB-61)", () => {
  it("never lets a same-round sibling's radius balloon far beyond its peers, even when many siblings share a second hub", () => {
    const seedId = 1,
      hubA = 2,
      hubB = 3;
    const soloLeaves = Array.from({ length: 8 }, (_, i) => 100 + i);
    const sharedLeaves = Array.from({ length: 7 }, (_, i) => 200 + i);

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: hubA, isSeed: false, _poleSettled: true },
      { id: hubB, isSeed: false, _poleSettled: true },
      ...soloLeaves.map((id) => ({ id, isSeed: false })),
      ...sharedLeaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: hubA, weight: 1 },
      { from: seedId, to: hubB, weight: 1 },
      ...soloLeaves.map((id) => ({ from: hubA, to: id, weight: 1 })),
      ...sharedLeaves.map((id) => ({ from: hubA, to: id, weight: 1 })),
      ...sharedLeaves.map((id) => ({ from: hubB, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([hubA, hubB, ...soloLeaves, ...sharedLeaves]);

    const savedPositions = {
      [hubA]: { x: 900, y: 0 },
      [hubB]: { x: 0, y: 900 },
    };
    const { targets } = placeExpandedNodes(savedPositions);

    const dist = (id) => {
      const p = targets.get(id);
      return Math.hypot(p.x - 900, p.y - 0);
    };
    const soloDists = soloLeaves.map(dist);
    const sharedDists = sharedLeaves.map(dist);
    const maxSolo = Math.max(...soloDists);
    const maxShared = Math.max(...sharedDists);

    expect(maxShared).toBeLessThan(maxSolo * 4);
  });
});

describe("placeExpandedNodes — radial growth adds a bounded ABSOLUTE distance, independent of depth (SF-WEB-62)", () => {
  function buildCrowdedHub({ hubId, siblingCount = 15, hubB }) {
    const solo = Array.from({ length: Math.ceil(siblingCount / 2) }, (_, i) => hubId * 100000 + i);
    const shared = Array.from(
      { length: Math.floor(siblingCount / 2) },
      (_, i) => hubId * 100000 + 1000 + i,
    );
    const nodes = [
      { id: hubId, isSeed: false, _poleSettled: true },
      { id: hubB, isSeed: false, _poleSettled: true },
      ...solo.map((id) => ({ id, isSeed: false })),
      ...shared.map((id) => ({ id, isSeed: false })),
    ];
    const edges = [
      ...solo.map((id) => ({ from: hubId, to: id, weight: 1 })),
      ...shared.map((id) => ({ from: hubId, to: id, weight: 1 })),
      ...shared.map((id) => ({ from: hubB, to: id, weight: 1 })),
    ];
    return { nodes, edges, solo, shared };
  }

  it("caps the extra distance a crowded pole's own siblings can be pushed to a similar absolute amount whether that pole is near or far from the seed", () => {
    const seedId = 1;
    const nearHub = 2,
      nearHubB = 3;
    const farHub = 20,
      farHubB = 21;

    const near = buildCrowdedHub({ seedId, hubId: nearHub, hubB: nearHubB });
    const far = buildCrowdedHub({ seedId, hubId: farHub, hubB: farHubB });

    State.graphNodes = [{ id: seedId, isSeed: true }, ...near.nodes, ...far.nodes];
    State.graphEdges = [
      { from: seedId, to: nearHub, weight: 1 },
      { from: seedId, to: nearHubB, weight: 1 },
      { from: seedId, to: farHub, weight: 1 },
      { from: seedId, to: farHubB, weight: 1 },
      ...near.edges,
      ...far.edges,
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([
      nearHub,
      nearHubB,
      farHub,
      farHubB,
      ...near.solo,
      ...near.shared,
      ...far.solo,
      ...far.shared,
    ]);

    const savedPositions = {
      [nearHub]: { x: 900, y: 0 },
      [nearHubB]: { x: 0, y: 900 },
      [farHub]: { x: 20000, y: 0 },
      [farHubB]: { x: 0, y: 20000 },
    };
    const { targets } = placeExpandedNodes(savedPositions);

    const maxExtra = (hubPos, siblingIds) => {
      let maxExtra = 0;
      for (const id of siblingIds) {
        const p = targets.get(id);
        const dist = Math.hypot(p.x - hubPos.x, p.y - hubPos.y);
        maxExtra = Math.max(maxExtra, dist);
      }
      return maxExtra;
    };

    const nearSharedMax = maxExtra(savedPositions[nearHub], near.shared);
    const nearSoloMax = maxExtra(savedPositions[nearHub], near.solo);
    const farSharedMax = maxExtra(savedPositions[farHub], far.shared);
    const farSoloMax = maxExtra(savedPositions[farHub], far.solo);

    const nearExtra = nearSharedMax - nearSoloMax;
    const farExtra = farSharedMax - farSoloMax;

    expect(farExtra).toBeLessThan(nearExtra * 4 + 50);
  });
});

describe("placeExpandedNodes — trilateration for nodes with 2 real hub connections (SF-WEB-70)", () => {
  it("lands a node at (approximately) the exact ideal distance from BOTH of its real hub connections when their circles actually intersect", () => {
    const seedId = 1,
      hubA = 2,
      hubB = 3,
      poleX = 200;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: hubA, isSeed: false, _poleSettled: true },
      { id: hubB, isSeed: false, _poleSettled: true },
      { id: poleX, isSeed: false, _expandParent: hubA },
    ];
    State.graphEdges = [
      { from: seedId, to: hubA, weight: 1 },
      { from: seedId, to: hubB, weight: 1 },
      { from: hubA, to: poleX, weight: 1 },
      { from: hubB, to: poleX, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([hubA, hubB, poleX]);

    const savedPositions = {
      [hubA]: { x: 400, y: 0 },
      [hubB]: { x: 0, y: 400 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const pos = targets.get(poleX);

    const distA = Math.hypot(pos.x - 400, pos.y - 0);
    const distB = Math.hypot(pos.x - 0, pos.y - 400);
    expect(Math.abs(distA - distB)).toBeLessThan(1);
    expect(pos.x).toBeGreaterThan(0);
    expect(pos.y).toBeGreaterThan(0);
  });

  it("degrades gracefully (distance-weighted direction blend, no crash) when the two hubs are too far apart for their circles to intersect", () => {
    const seedId = 1,
      hubA = 2,
      hubB = 3,
      poleX = 200;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: hubA, isSeed: false, _poleSettled: true },
      { id: hubB, isSeed: false, _poleSettled: true },
      { id: poleX, isSeed: false, _expandParent: hubA },
    ];
    State.graphEdges = [
      { from: seedId, to: hubA, weight: 1 },
      { from: seedId, to: hubB, weight: 1 },
      { from: hubA, to: poleX, weight: 1 },
      { from: hubB, to: poleX, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([hubA, hubB, poleX]);

    const savedPositions = {
      [hubA]: { x: 5000, y: 0 },
      [hubB]: { x: 0, y: 5000 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const pos = targets.get(poleX);

    expect(Number.isFinite(pos.x)).toBe(true);
    expect(Number.isFinite(pos.y)).toBe(true);
    const distFromHubAOutwardOnly = Math.hypot(pos.x - 5000, pos.y - 0);
    expect(distFromHubAOutwardOnly).toBeGreaterThan(0);
    expect(pos.y).toBeGreaterThan(0);
  });

  it("keeps a node close to its primary hub's own outward line even when that hub carries a huge dandelion (no more flying off into a separate island)", () => {
    const seedId = 1,
      hubA = 2,
      hubB = 3,
      poleX = 200;
    const hubALeaves = Array.from({ length: 120 }, (_, i) => 1000 + i);
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: hubA, isSeed: false, _poleSettled: true },
      { id: hubB, isSeed: false, _poleSettled: true },
      { id: poleX, isSeed: false, _expandParent: hubA },
      ...hubALeaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: hubA, weight: 1 },
      { from: seedId, to: hubB, weight: 1 },
      { from: hubA, to: poleX, weight: 1 },
      { from: hubB, to: poleX, weight: 1 },
      ...hubALeaves.map((id) => ({ from: hubA, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([hubA, hubB, poleX]);

    const savedPositions = {
      [hubA]: { x: 5000, y: 0 },
      [hubB]: { x: 0, y: 500 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const pos = targets.get(poleX);

    expect(Math.abs(pos.y)).toBeLessThan(MIN_SEP * 6 + 1);
  });

  it("anchors the degenerate-blend 'pure' line on the real hub (not the seed's arbitrary fallback angle) when the node's tree parent is the seed itself", () => {
    const seedId = 1,
      hubA = 2,
      poleX = 200;
    const hubALeaves = Array.from({ length: 120 }, (_, i) => 1000 + i);
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: hubA, isSeed: false, _poleSettled: true },
      { id: poleX, isSeed: false, _expandParent: seedId },
      ...hubALeaves.map((id) => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: hubA, weight: 1 },
      { from: seedId, to: poleX, weight: 1 },
      { from: hubA, to: poleX, weight: 1 },
      ...hubALeaves.map((id) => ({ from: hubA, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([hubA, poleX]);

    const savedPositions = { [hubA]: { x: 5000, y: 0 } };
    const { targets } = placeExpandedNodes(savedPositions);
    const pos = targets.get(poleX);

    expect(pos.x).toBeGreaterThan(4000);
    expect(Math.hypot(pos.x - 5000, pos.y)).toBeLessThan(2500);
  });

  it("leaves single-hub nodes on the plain baseR+_ownerVector path, unaffected by trilateration", () => {
    const seedId = 1,
      hubA = 2,
      poleX = 200;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: hubA, isSeed: false, _poleSettled: true },
      { id: poleX, isSeed: false, _expandParent: hubA },
    ];
    State.graphEdges = [
      { from: seedId, to: hubA, weight: 1 },
      { from: hubA, to: poleX, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([hubA, poleX]);

    const savedPositions = { [hubA]: { x: 1000, y: 0 } };
    const { targets } = placeExpandedNodes(savedPositions);
    const pos = targets.get(poleX);

    expect(pos.y).toBeCloseTo(0, 5);
    expect(pos.x).toBeGreaterThan(1000);
  });
});
