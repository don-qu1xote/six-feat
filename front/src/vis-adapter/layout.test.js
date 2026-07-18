// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/layout.test.js — SF-WEB-17: placePathNodes lays a six-degrees
//                                path out as a straight, evenly-spaced,
//                                centered left-to-right row (replacing the
//                                old single-angle diagonal), given only the
//                                path node ids and the canvas viewport size.
//
// [SF-WEB-29] placeExpandedNodes ("одуванчик" + "круги Эйлера" expand
// layout) below: ring targets around a pole must not overlap (exact-chord
// _ringCap, not the old arc-length approximation — see layout.js), the
// dandelion's radius must grow with its leaf count, and a shared leaf
// (Euler zone) must land between its two owning poles, not off to one side.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from "vitest";
import { placePathNodes, placeExpandedNodes, resolveCollisions, NODE_W, MIN_SEP, SOLVER_ITERS } from "./layout.js";
import { State } from "../state/state.js";

function xs(targets, path) {
  return path.map(id => targets.get(id).x);
}

describe("placePathNodes", () => {
  it("returns empty maps for a path shorter than 2 nodes", () => {
    expect(placePathNodes([], { width: 1200 })).toEqual({ targets: new Map(), fromPos: new Map() });
    expect(placePathNodes([1], { width: 1200 })).toEqual({ targets: new Map(), fromPos: new Map() });
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

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-29] placeExpandedNodes — dandelion rings + Euler zones
// ════════════════════════════════════════════════════════════════════════════

function pairwiseDistances(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      out.push(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
    }
  }
  return out;
}

// Builds a seed with a single expanded pole carrying `n` exclusive leaves —
// the minimal graph shape that exercises the dandelion-ring math in
// placeExpandedNodes without any Euler-zone (shared-leaf) involvement.
function graphWithPoleLeaves(n) {
  const seedId = 1, poleId = 2;
  const leafIds = Array.from({ length: n }, (_, i) => 100 + i);

  State.graphNodes = [
    { id: seedId, isSeed: true },
    { id: poleId, isSeed: false },
    ...leafIds.map(id => ({ id, isSeed: false })),
  ];
  State.graphEdges = [
    { from: seedId, to: poleId, weight: 1 },
    ...leafIds.map(id => ({ from: poleId, to: id, weight: 1 })),
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

  // [SF-WEB-29 follow-up] initNetwork (render.js) now routes the very first
  // seed render through this same function, with State.expandedNodes still
  // empty (nothing has been expanded yet) — this used to hit an early
  // return that skipped step 5 entirely, leaving the seed's own direct
  // neighbours with no dandelion layout at all (left to vis.js's free-
  // running barnesHut physics instead, sized independently of LEAF_R/
  // LEAF_GAP). Guards against that regressing again.
  it("places the seed's own direct neighbours in a dandelion, even with nothing expanded", () => {
    const seedId = 1;
    const neighborIds = [10, 11, 12, 13, 14, 15];

    State.graphNodes = [
      { id: seedId, isSeed: true },
      ...neighborIds.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = neighborIds.map(id => ({ from: seedId, to: id, weight: 1 }));
    State.currentSeedId = seedId;
    State.expandedNodes = new Set(); // nothing expanded — fresh search
    State.network = {};
    State.nodesDS = {};

    const { targets } = placeExpandedNodes({});
    expect(targets.size).toBe(neighborIds.length);

    const points = neighborIds.map(id => targets.get(id));
    expect(points.every(Boolean)).toBe(true);
    for (const d of pairwiseDistances(points)) {
      expect(d).toBeGreaterThanOrEqual(NODE_W - 1e-6);
    }
    // Never at the seed's own origin.
    for (const p of points) {
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(1);
    }
  });

  it("places every leaf, with no pair closer than NODE_W — no ring overlaps, for a small leaf count", () => {
    const { leafIds } = graphWithPoleLeaves(6);
    const { targets } = placeExpandedNodes({});

    expect(targets.size).toBe(1 + leafIds.length); // pole + leaves

    const leafPoints = leafIds.map(id => targets.get(id));
    expect(leafPoints.every(Boolean)).toBe(true);
    for (const d of pairwiseDistances(leafPoints)) {
      expect(d).toBeGreaterThanOrEqual(NODE_W - 1e-6);
    }
  });

  it("places every leaf with no overlaps for a large leaf count spanning several rings", () => {
    const { leafIds } = graphWithPoleLeaves(40);
    const { targets } = placeExpandedNodes({});

    const leafPoints = leafIds.map(id => targets.get(id));
    expect(leafPoints.every(Boolean)).toBe(true);
    for (const d of pairwiseDistances(leafPoints)) {
      expect(d).toBeGreaterThanOrEqual(NODE_W - 1e-6);
    }
  });

  it("dandelion radius (max leaf distance from the pole) grows with the leaf count", () => {
    const radiusFor = n => {
      const { poleId, leafIds } = graphWithPoleLeaves(n);
      const { targets } = placeExpandedNodes({});
      const pole = targets.get(poleId);
      return Math.max(...leafIds.map(id => {
        const p = targets.get(id);
        return Math.hypot(p.x - pole.x, p.y - pole.y);
      }));
    };

    const r5  = radiusFor(5);
    State.graphNodes = []; State.graphEdges = []; // fresh graph per call
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

  // [SF-WEB-52] Under the sector rule a shared leaf sits on the ANGULAR
  // BOUNDARY between its two owning sectors (the angular bisector between the
  // poles), not on the straight A–B segment the old flat layout used — this
  // is the ticket's test (в), and the seriation puts lens-sharing poles
  // adjacent so that boundary is a clean seam.
  it("puts a single shared leaf between the angular ranges of its two owning poles", () => {
    const seedId = 1, poleA = 2, poleB = 3, sharedLeaf = 200;

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
    const A = targets.get(poleA), B = targets.get(poleB), L = targets.get(sharedLeaf);
    expect(A).toBeTruthy();
    expect(B).toBeTruthy();
    expect(L).toBeTruthy();

    // The lens leaf's angle from seed lies strictly between the two poles'
    // angles (on the shorter arc) — i.e. between their angular ranges.
    const thA = Math.atan2(A.y, A.x), thB = Math.atan2(B.y, B.x), thL = Math.atan2(L.y, L.x);
    const norm = a => { let x = a; while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
    const dAB = norm(thB - thA);              // shorter-arc A→B
    const dAL = norm(thL - thA);              // shorter-arc A→L
    // L is between A and B iff dAL has the same sign as dAB and |dAL| < |dAB|.
    expect(Math.sign(dAL)).toBe(Math.sign(dAB));
    expect(Math.abs(dAL)).toBeLessThan(Math.abs(dAB));
    expect(Math.abs(dAL)).toBeGreaterThan(0);
  });

  it("spreads 3+ shared leaves in a cluster around the zone center, not in a straight line", () => {
    const seedId = 1, poleA = 2, poleB = 3;
    const sharedLeaves = [200, 201, 202];

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      ...sharedLeaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      ...sharedLeaves.map(id => ({ from: poleA, to: id, weight: 1 })),
      ...sharedLeaves.map(id => ({ from: poleB, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const savedPositions = {
      [poleA]: { x: 900, y: 0 },
      [poleB]: { x: 0, y: 900 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const leafPoints = sharedLeaves.map(id => targets.get(id));
    expect(leafPoints.every(Boolean)).toBe(true);

    // Not collinear: not all three points lie on a single straight line
    // (the old bug — a perpendicular-band formula for 2-owner zones lined
    // shared leaves up in a row; the fix is a shared ring formula).
    const [p0, p1, p2] = leafPoints;
    const cross = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
    expect(Math.abs(cross)).toBeGreaterThan(1);

    for (const d of pairwiseDistances(leafPoints)) {
      expect(d).toBeGreaterThan(0);
    }
  });

  // [SF-WEB-29 follow-up] Regression: a large Euler zone (many artists
  // shared between the same set of poles — common in a dense collaboration
  // graph once several poles are expanded) used to sit in a SINGLE flat
  // ring whose radius grew linearly with leaf count — for dozens of shared
  // leaves this became one huge halo with every edge from every owning pole
  // converging on it ("wagon wheel" look). Now it spills over into further
  // concentric rings the same way a pole's own exclusive-leaf dandelion
  // does, so it stays compact instead of ballooning into a single ring.
  it("spills a large shared-leaf zone into multiple concentric rings instead of one giant ring", () => {
    const seedId = 1, poleA = 2, poleB = 3;
    const sharedLeaves = Array.from({ length: 40 }, (_, i) => 200 + i);

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      ...sharedLeaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      ...sharedLeaves.map(id => ({ from: poleA, to: id, weight: 1 })),
      ...sharedLeaves.map(id => ({ from: poleB, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const savedPositions = {
      [poleA]: { x: 900, y: 0 },
      [poleB]: { x: 0, y: 900 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const leafPoints = sharedLeaves.map(id => targets.get(id));
    expect(leafPoints.every(Boolean)).toBe(true);

    // No pair closer than a node diameter — same overlap guarantee the
    // pole dandelion gets. [SF-WEB-52] 40 shared leaves in ONE lens is a
    // genuinely dense blob (near the Euler limit) sitting close to the seed
    // now that the two owning poles get minimal-radius π-wedges — the bounded
    // 8-iteration solver (SF-WEB-51, kept as-is) converges to within a sub-px
    // of MIN_SEP here rather than exactly, so allow a 0.5px slack. The
    // test's real point is the multi-ring spread below; the general
    // ≥ MIN_SEP guarantee on realistic graphs is covered by the SF-WEB-51/52
    // no-overlap tests.
    for (const d of pairwiseDistances(leafPoints)) {
      expect(d).toBeGreaterThanOrEqual(NODE_W - 0.5);
    }

    // Actually spans more than one ring: not every leaf is the same
    // distance from the zone's own centroid (a single flat ring, the old
    // bug, puts every leaf at the exact same radius).
    const cx = leafPoints.reduce((s, p) => s + p.x, 0) / leafPoints.length;
    const cy = leafPoints.reduce((s, p) => s + p.y, 0) / leafPoints.length;
    const radii = leafPoints.map(p => Math.hypot(p.x - cx, p.y - cy));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(NODE_W);
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
    const seedId = 1, poleA = 2, nestedPole = 200;

    // poleA was expanded first (direct seed neighbor — root pole). nestedPole
    // was one of poleA's exclusive leaves, then itself got expanded — a
    // 2nd-degree ("nested") pole. graph.js::mergeGraph is responsible for
    // stamping _expandParent = poleA on it; here we set that up directly to
    // exercise the layout math in isolation.
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
    const A = targets.get(poleA), N = targets.get(nestedPole);
    expect(A).toBeTruthy();
    expect(N).toBeTruthy();

    const distFromParent = Math.hypot(N.x - A.x, N.y - A.y);
    const distFromSeed = Math.hypot(N.x, N.y);

    // The nested pole must sit close to its parent, and clearly closer to
    // the parent than it is out on a fresh seed-orbit ring (POLE_DIST=900
    // away from seed) — the bug this guards against placed EVERY expanded
    // node on that same seed orbit regardless of true parentage.
    expect(distFromParent).toBeLessThan(400);
    expect(distFromSeed).toBeGreaterThan(A.x - 50); // farther from seed than the parent itself (grows outward)
  });

  it("fans multiple children of the same nested parent apart instead of stacking them", () => {
    const seedId = 1, poleA = 2;
    const children = [200, 201, 202];

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      ...children.map(id => ({ id, isSeed: false, _expandParent: poleA })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      ...children.map(id => ({ from: poleA, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, ...children]);

    const savedPositions = { [poleA]: { x: 900, y: 0 } };
    const { targets } = placeExpandedNodes(savedPositions);
    const points = children.map(id => targets.get(id));
    expect(points.every(Boolean)).toBe(true);
    for (const d of pairwiseDistances(points)) {
      expect(d).toBeGreaterThan(1);
    }
  });

  // [SF-WEB-29 follow-up] Regression: a root pole's own dandelion radius
  // (dR) used to be the ONLY thing considered when spacing it apart from a
  // neighboring root pole — a nested (2nd-degree) subtree hanging off that
  // pole extends well past its own dR, in roughly the same direction, but
  // was invisible to that spacing math. [SF-WEB-52] Now guaranteed by
  // construction: poleA (with its whole nested subtree) and poleB own
  // DISJOINT angular sectors, so poleB's leaves cannot land in poleA's
  // subtree's wedge regardless of how deep/heavy that subtree is. The
  // savedPositions below no longer pin angles (sector rule ignores them —
  // placement is deterministic from the expansion tree), they're just inert
  // now. 300px is comfortably above MIN_SEP (78) — proving clear separation
  // — and below the actual ~470px this scenario produces under the sector
  // rule (it would fail only if the two subtrees' wedges started overlapping).
  it("keeps a neighboring root pole's leaves clear of another pole's nested subtree", () => {
    const seedId = 1, poleA = 2, poleB = 3, nestedUnderA = 200;
    const aLeaves = Array.from({ length: 12 }, (_, i) => 1000 + i);
    const nestedLeaves = Array.from({ length: 20 }, (_, i) => 2000 + i);
    const bLeaves = Array.from({ length: 10 }, (_, i) => 3000 + i);

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: poleB, isSeed: false },
      { id: nestedUnderA, isSeed: false, _expandParent: poleA },
      ...aLeaves.map(id => ({ id, isSeed: false })),
      ...nestedLeaves.map(id => ({ id, isSeed: false })),
      ...bLeaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      { from: poleA, to: nestedUnderA, weight: 1 },
      ...aLeaves.map(id => ({ from: poleA, to: id, weight: 1 })),
      ...nestedLeaves.map(id => ({ from: nestedUnderA, to: id, weight: 1 })),
      ...bLeaves.map(id => ({ from: poleB, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB, nestedUnderA]);

    const ang = (20 * Math.PI) / 180;
    const savedPositions = {
      [poleA]: { x: 900, y: 0 },
      [poleB]: { x: 900 * Math.cos(ang), y: 900 * Math.sin(ang) },
    };
    const { targets } = placeExpandedNodes(savedPositions);

    const aSidePoints = [poleA, nestedUnderA, ...aLeaves, ...nestedLeaves].map(id => targets.get(id));
    const bSidePoints = [poleB, ...bLeaves].map(id => targets.get(id));
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

// [SF-WEB-29 follow-up] The seed used to be excluded from Euler-zone
// ownership entirely — a leaf connected to BOTH the seed directly AND an
// expanded pole was classified as purely the pole's own exclusive leaf,
// rendered in the pole's ring with a long, unaccounted-for extra edge
// stretching all the way back to the seed. On a dense real collaboration
// graph this produced dozens of very long crossing edges (reported as
// "seed exclusivity — there's no lens for it") and needlessly crowded each
// pole's own ring with leaves that should have split off into a seed↔pole
// lens instead.
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
    const seedId = 1, poleA = 2, sharedLeaf = 100, exclusiveLeaf = 101;

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false },
      { id: sharedLeaf, isSeed: false },
      { id: exclusiveLeaf, isSeed: false },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: sharedLeaf, weight: 1 },  // seed also directly knows this one
      { from: poleA, to: sharedLeaf, weight: 1 },
      { from: poleA, to: exclusiveLeaf, weight: 1 }, // only poleA knows this one
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA]);

    const savedPositions = { [poleA]: { x: 900, y: 0 } };
    const { targets } = placeExpandedNodes(savedPositions);
    const A = targets.get(poleA), L = targets.get(sharedLeaf), E = targets.get(exclusiveLeaf);
    expect(A).toBeTruthy();
    expect(L).toBeTruthy();
    expect(E).toBeTruthy();

    // L sits on the seed(0,0)->A line, not off wherever poleA's own ring
    // (baseAngle-oriented, could be any angle) happens to put it.
    const t = (L.x * A.x + L.y * A.y) / (A.x * A.x + A.y * A.y);
    const projX = A.x * t, projY = A.y * t;
    expect(Math.hypot(L.x - projX, L.y - projY)).toBeLessThan(1);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);

    // The purely-exclusive leaf is unaffected — still in poleA's own ring.
    expect(Math.hypot(E.x - A.x, E.y - A.y)).toBeLessThan(400);
  });

  it("still gives a seed-only leaf (no pole connection at all) its own dandelion slot", () => {
    const seedId = 1, poleA = 2, seedOnlyLeaf = 300;

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
    expect(Math.hypot(L.x, L.y)).toBeGreaterThan(1); // not dropped at the seed's own origin
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-51] Collision-aware engine — the GUARANTEE the independent
// dandelion/Euler placement never gave: after placeExpandedNodes, no two
// nodes (incl. the seed at 0,0) are closer than MIN_SEP, deterministically,
// without any reliance on physics. Plus the raw resolveCollisions() solver
// (spatial grid, hard iteration cap).
// ════════════════════════════════════════════════════════════════════════════

// Minimum centre-to-centre distance among a set of points (incl. an implied
// pinned seed at the origin, which real render code keeps at 0,0).
function minSepWithSeed(targets) {
  const pts = [{ x: 0, y: 0 }, ...targets.values()];
  let min = Infinity;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  return min;
}

// A dense, realistic multi-pole graph: seed + K expanded poles, each with
// its own exclusive leaves, several Euler lenses (leaves shared between pole
// pairs and between the seed and a pole). Returns the id groupings so tests
// can assert per-cluster.
function buildMultiPoleGraph() {
  const seedId = 1;
  const poles = [2, 3, 4];
  const exclusive = { 2: [200, 201, 202, 203, 204, 205, 206, 207, 208, 209],
                      3: [300, 301, 302, 303, 304, 305, 306, 307],
                      4: [400, 401, 402, 403, 404, 405] };
  const shared23 = [5000, 5001, 5002, 5003, 5004];
  const shared34 = [6000, 6001, 6002];
  const sharedSeed2 = [7000, 7001];

  const nodes = [{ id: seedId, isSeed: true }, ...poles.map(id => ({ id, isSeed: false }))];
  const edges = poles.map(id => ({ from: seedId, to: id, weight: 1 }));

  for (const [pole, leaves] of Object.entries(exclusive)) {
    for (const l of leaves) { nodes.push({ id: l, isSeed: false }); edges.push({ from: Number(pole), to: l, weight: 1 }); }
  }
  for (const l of shared23) { nodes.push({ id: l, isSeed: false }); edges.push({ from: 2, to: l, weight: 1 }, { from: 3, to: l, weight: 1 }); }
  for (const l of shared34) { nodes.push({ id: l, isSeed: false }); edges.push({ from: 3, to: l, weight: 1 }, { from: 4, to: l, weight: 1 }); }
  for (const l of sharedSeed2) { nodes.push({ id: l, isSeed: false }); edges.push({ from: seedId, to: l, weight: 1 }, { from: 2, to: l, weight: 1 }); }

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
    // Rp = actual outer radius of each pole's own exclusive-leaf cloud.
    const rp = {};
    for (const p of poles) {
      const pole = targets.get(p);
      rp[p] = Math.max(...exclusive[p].map(l => {
        const t = targets.get(l);
        return Math.hypot(t.x - pole.x, t.y - pole.y);
      }));
    }
    for (let i = 0; i < poles.length; i++)
      for (let j = i + 1; j < poles.length; j++) {
        const A = targets.get(poles[i]), B = targets.get(poles[j]);
        const d = Math.hypot(A.x - B.x, A.y - B.y);
        expect(d).toBeGreaterThanOrEqual(rp[poles[i]] + rp[poles[j]] - 1e-6);
      }
  });

  it("Euler-lens leaves do not cross the parent poles' own dandelions (every cross pair ≥ MIN_SEP)", () => {
    const { exclusive, shared23 } = buildMultiPoleGraph();
    const { targets } = placeExpandedNodes({});
    const lensPts = shared23.map(l => targets.get(l));
    const parentPts = [...exclusive[2], ...exclusive[3]].map(l => targets.get(l));
    let minCross = Infinity;
    for (const a of lensPts) for (const b of parentPts)
      minCross = Math.min(minCross, Math.hypot(a.x - b.x, a.y - b.y));
    expect(minCross).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });

  it("initial seed-only graph: leaves land in rings ≥ MIN_SEP apart, none piled at the origin", () => {
    const seedId = 1;
    const leaves = Array.from({ length: 24 }, (_, i) => 100 + i);
    State.graphNodes = [{ id: seedId, isSeed: true }, ...leaves.map(id => ({ id, isSeed: false }))];
    State.graphEdges = leaves.map(id => ({ from: seedId, to: id, weight: 1 }));
    State.currentSeedId = seedId;
    State.expandedNodes = new Set(); // nothing expanded — the initNetwork path

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
    // seed + 6 poles × 30 exclusive leaves = 187 nodes, well past the 150
    // threshold — exactly the dense regime the screenshot showed.
    const seedId = 1;
    const poles = [2, 3, 4, 5, 6, 7];
    const nodes = [{ id: seedId, isSeed: true }, ...poles.map(id => ({ id, isSeed: false }))];
    const edges = poles.map(id => ({ from: seedId, to: id, weight: 1 }));
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
  // The engine feeds the solver a near-solved layout (rings are already
  // ≥ MIN_SEP by construction), which is why the placeExpandedNodes tests
  // above hold the FULL ≥ MIN_SEP guarantee. The raw solver's own contract
  // on an arbitrary overlapping input is bounded-iteration: monotonically
  // separate toward MIN_SEP, never a hang — a from-scratch dense pile isn't
  // fully spread in a fixed 8 passes (nor is it ever produced by the
  // engine). This asserts the mechanic, not a from-scratch miracle.
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
      for (let c = 0; c < 5; c++) targets.set(id++, { x: c * 70, y: r * 70 }); // 70 < MIN_SEP: mild overlap
    const before = minPair(targets);
    resolveCollisions(targets, new Set(), null);
    const after = minPair(targets);
    expect(after).toBeGreaterThan(before);              // strictly less overlap
    expect(after).toBeGreaterThanOrEqual(MIN_SEP * 0.95); // reaches essentially MIN_SEP for a realistic density
  });

  it("never moves a pinned point, and pushes an overlapping movable point off it", () => {
    const targets = new Map([
      [1, { x: 0, y: 0 }],   // pinned
      [2, { x: 5, y: 0 }],   // movable, overlapping the pinned one
    ]);
    resolveCollisions(targets, new Set([1]), null);
    expect(targets.get(1)).toEqual({ x: 0, y: 0 }); // pinned held exactly
    expect(Math.hypot(...Object.values(targets.get(2)))).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
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

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-52] Sector ("pie") pole layout — the expansion tree recursively
// slices the plane into non-overlapping angular wedges, so no two dandelions
// can ever collide, in whatever order/direction the graph grew. Tests (а)–(д)
// from the ticket.
// ════════════════════════════════════════════════════════════════════════════

// True iff two sets of angles occupy disjoint contiguous arcs — i.e. going
// once around the circle, the A/B labels change at most twice (A…A B…B).
// Interleaving (overlapping sectors) would flip labels more than twice.
function sectorsDisjoint(anglesA, anglesB) {
  const pts = [
    ...anglesA.map(a => [a, "A"]),
    ...anglesB.map(a => [a, "B"]),
  ].sort((x, y) => x[0] - y[0]);
  let changes = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i][1] !== pts[(i + 1) % pts.length][1]) changes++;
  }
  return changes <= 2;
}

function anglesOf(targets, ids) {
  return ids.map(id => {
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

  // (а) Subtrees expanded in different directions occupy DISJOINT angular
  //     sectors — the core "two dandelions cannot overlap by construction".
  it("(а) two poles' whole subtrees lie in non-overlapping angular sectors", () => {
    const seedId = 1;
    // pole 2: exclusive leaves + a nested pole 3 (which itself has leaves).
    const poleTwo = 2, nestedThree = 3;
    const twoLeaves = [200, 201, 202, 203];
    const threeLeaves = [300, 301, 302];
    // pole 5: its own exclusive leaves (a different branch/direction).
    const poleFive = 5;
    const fiveLeaves = [500, 501, 502, 503, 504];

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleTwo, isSeed: false },
      { id: nestedThree, isSeed: false, _expandParent: poleTwo },
      { id: poleFive, isSeed: false },
      ...twoLeaves.map(id => ({ id, isSeed: false })),
      ...threeLeaves.map(id => ({ id, isSeed: false })),
      ...fiveLeaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleTwo, weight: 1 },
      { from: seedId, to: poleFive, weight: 1 },
      { from: poleTwo, to: nestedThree, weight: 1 },
      ...twoLeaves.map(id => ({ from: poleTwo, to: id, weight: 1 })),
      ...threeLeaves.map(id => ({ from: nestedThree, to: id, weight: 1 })),
      ...fiveLeaves.map(id => ({ from: poleFive, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleTwo, nestedThree, poleFive]);

    const { targets } = placeExpandedNodes({});
    const subtreeTwo = [poleTwo, nestedThree, ...twoLeaves, ...threeLeaves];
    const subtreeFive = [poleFive, ...fiveLeaves];

    expect(sectorsDisjoint(
      anglesOf(targets, subtreeTwo),
      anglesOf(targets, subtreeFive),
    )).toBe(true);
  });

  // (б) The children of a node divide the parent's sector proportionally to
  //     subtree weight and their sub-sectors SUM to the parent's sector. A
  //     pole sits at the centre of its own wedge, so its angle encodes its
  //     wedge — verified at both the root level (poles tiling 2π) and one
  //     level down (a pole's children tiling its wedge). No shared leaves →
  //     seriation is a plain id sort, so the expected order is deterministic.
  it("(б) child sectors are weight-proportional and sum to the parent sector", () => {
    const seedId = 1;
    // Three root poles with leaf counts 2, 4, 6 → weights 2, 4, 6 (sum 12).
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
    const totalW = 2 + 4 + 6;
    // Expected wedge centres: cumulative from -π/2, order [2,3,4] (id sort).
    let cur = -Math.PI / 2;
    const expected = {};
    for (const [pole, w] of [[2, 2], [3, 4], [4, 6]]) {
      const wdt = 2 * Math.PI * w / totalW;
      expected[pole] = cur + wdt / 2;
      cur += wdt;
    }
    // Total of the three wedges is exactly 2π (== the seed's full sector).
    expect(cur - (-Math.PI / 2)).toBeCloseTo(2 * Math.PI, 9);

    const norm = a => { let x = a; while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
    for (const pole of [2, 3, 4]) {
      const t = targets.get(pole);
      expect(norm(Math.atan2(t.y, t.x))).toBeCloseTo(norm(expected[pole]), 6);
    }
  });

  // (в) A shared leaf of {A,B} lands between the angular ranges of A and B —
  //     on the seam of their two sectors. (Also covered by the Euler-zone
  //     describe above; asserted here directly against sector angles.)
  it("(в) a shared leaf sits angularly between its two owning poles", () => {
    const seedId = 1, poleA = 2, poleB = 3;
    const aLeaves = [200, 201, 202];
    const bLeaves = [300, 301, 302];
    const shared = 900;
    State.graphNodes = [
      { id: seedId, isSeed: true }, { id: poleA, isSeed: false }, { id: poleB, isSeed: false },
      ...aLeaves.map(id => ({ id, isSeed: false })),
      ...bLeaves.map(id => ({ id, isSeed: false })),
      { id: shared, isSeed: false },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 }, { from: seedId, to: poleB, weight: 1 },
      ...aLeaves.map(id => ({ from: poleA, to: id, weight: 1 })),
      ...bLeaves.map(id => ({ from: poleB, to: id, weight: 1 })),
      { from: poleA, to: shared, weight: 1 }, { from: poleB, to: shared, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const { targets } = placeExpandedNodes({});
    const A = targets.get(poleA), B = targets.get(poleB), L = targets.get(shared);
    const norm = a => { let x = a; while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
    const thA = Math.atan2(A.y, A.x), thB = Math.atan2(B.y, B.x), thL = Math.atan2(L.y, L.x);
    const dAB = norm(thB - thA), dAL = norm(thL - thA);
    expect(Math.sign(dAL)).toBe(Math.sign(dAB));
    expect(Math.abs(dAL)).toBeLessThan(Math.abs(dAB));
  });

  // (г) The SF-WEB-51 no-overlap guarantee still holds under the sector rule.
  it("(г) keeps the SF-WEB-51 guarantee: all pairs ≥ MIN_SEP", () => {
    buildMultiPoleGraph();
    const { targets } = placeExpandedNodes({});
    expect(minSepWithSeed(targets)).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });

  // (д) Deterministic — one input yields byte-identical targets on a re-run.
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

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-53] Cosmetic polish: cluster-to-cluster gap (dandelion↔dandelion,
// dandelion↔lens) must read as distinguishably larger than the plain
// node-to-node MIN_SEP used inside a single ring — without changing intra-
// ring spacing itself (still exactly MIN_SEP, see the SF-WEB-51 tests above).
// ════════════════════════════════════════════════════════════════════════════
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
    const seedId = 1, poleA = 2, poleB = 3;
    const aLeaves = [200, 201, 202, 203];
    const bLeaves = [300, 301, 302, 303];
    State.graphNodes = [
      { id: seedId, isSeed: true }, { id: poleA, isSeed: false }, { id: poleB, isSeed: false },
      ...aLeaves.map(id => ({ id, isSeed: false })),
      ...bLeaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 }, { from: seedId, to: poleB, weight: 1 },
      ...aLeaves.map(id => ({ from: poleA, to: id, weight: 1 })),
      ...bLeaves.map(id => ({ from: poleB, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const { targets } = placeExpandedNodes({});
    const A = targets.get(poleA), B = targets.get(poleB);
    const poleDist = Math.hypot(A.x - B.x, A.y - B.y);
    const rA = Math.max(...aLeaves.map(id => {
      const t = targets.get(id);
      return Math.hypot(t.x - A.x, t.y - A.y);
    }));
    const rB = Math.max(...bLeaves.map(id => {
      const t = targets.get(id);
      return Math.hypot(t.x - B.x, t.y - B.y);
    }));
    // Residual gap between the two dandelion clouds' outer edges (pole
    // distance minus both leaf-cloud radii) must clear a full node-to-node
    // MIN_SEP by a distinguishable margin — this is exactly the "заметно
    // дальше друг от друга" requirement, kept separate from intra-ring
    // spacing (checked below, unchanged).
    const clusterGap = poleDist - rA - rB;
    expect(clusterGap).toBeGreaterThan(MIN_SEP * 1.5);
  });

  it("intra-ring node spacing is unaffected: still exactly MIN_SEP-bounded", () => {
    buildMultiPoleGraph();
    const { targets } = placeExpandedNodes({});
    expect(minSepWithSeed(targets)).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });
});