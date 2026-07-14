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
import { placePathNodes, placeExpandedNodes, NODE_W } from "./layout.js";
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

  it("centers a single shared leaf on the line between its two owning poles, not off to one side", () => {
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

    // Pin the two poles' angles via savedPositions so they aren't placed
    // diametrically opposite (the automatic "largest free angular gap"
    // placement for exactly two fresh poles puts the second at +180° from
    // the first — see the big comment in layout.js above the Euler-zone
    // math): with A and B on exactly opposite sides of the seed, the
    // natural midpoint of their gap IS the seed, and the code deliberately
    // pushes the zone off that line to avoid rendering the leaf on top of
    // the seed cluster — a different, already-covered case, not what this
    // test is after. 90° apart keeps a well-defined "between A and B" line
    // that doesn't pass through the seed.
    const savedPositions = {
      [poleA]: { x: 900, y: 0 },
      [poleB]: { x: 0, y: 900 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const A = targets.get(poleA), B = targets.get(poleB), L = targets.get(sharedLeaf);
    expect(A).toBeTruthy();
    expect(B).toBeTruthy();
    expect(L).toBeTruthy();

    // L must lie (near enough) ON the line A-B — perpendicular distance from
    // the line ~0 — and strictly between A and B along it, i.e. "centered
    // between owners" rather than off to one side or beyond either pole.
    const dx = B.x - A.x, dy = B.y - A.y;
    const lenSq = dx * dx + dy * dy;
    const t = ((L.x - A.x) * dx + (L.y - A.y) * dy) / lenSq; // projection param, 0=A, 1=B
    const projX = A.x + t * dx, projY = A.y + t * dy;
    const perpDist = Math.hypot(L.x - projX, L.y - projY);

    expect(perpDist).toBeLessThan(1);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1);
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
    // pole dandelion gets.
    for (const d of pairwiseDistances(leafPoints)) {
      expect(d).toBeGreaterThanOrEqual(NODE_W - 1e-6);
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
  // was invisible to that spacing math. Two root poles pinned close in
  // angle (20° apart via savedPositions) with one of them carrying a large
  // nested subtree used to let that subtree's leaves land much closer to
  // the neighboring pole's own territory than accounting for the full
  // subtree (poleReach) does — exactly the "hairball" overlap this guards
  // against after a few rounds of expand. 500 sits strictly between the
  // pre-fix (~231px, dR-only) and post-fix (~851px, poleReach) minimum
  // cross-cluster distance measured for this exact scenario — this would
  // fail if the reach accounting regressed back to plain dR.
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
    expect(minCrossDist).toBeGreaterThan(500);
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