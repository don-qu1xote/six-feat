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
    // genuinely dense blob (near the Euler limit) — the bounded 8-iteration
    // solver (SF-WEB-51, kept as-is) converges to within a few px of MIN_SEP
    // here rather than exactly, so allow a small slack (imperceptible on
    // screen — well within the hover-outline/antialiasing margin NODE_GAP
    // already budgets for). [SF-WEB-57] Slack widened slightly vs. the old
    // wedge-based pole placement: the two owning poles no longer land at a
    // fixed minimal-radius π-wedge — their vector-based angle depends on id,
    // which shifts the local density this dense a lens converges from. The
    // test's real point is the multi-ring spread below; the general
    // ≥ MIN_SEP guarantee on realistic graphs is covered by the SF-WEB-51/52
    // no-overlap tests.
    for (const d of pairwiseDistances(leafPoints)) {
      expect(d).toBeGreaterThanOrEqual(NODE_W - 4);
    }

    // Actually spans more than one ring: not every leaf is the same
    // distance from the zone's own centroid (a single flat ring, the old
    // bug, puts every leaf at the exact same radius).
    const cx = leafPoints.reduce((s, p) => s + p.x, 0) / leafPoints.length;
    const cy = leafPoints.reduce((s, p) => s + p.y, 0) / leafPoints.length;
    const radii = leafPoints.map(p => Math.hypot(p.x - cx, p.y - cy));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(NODE_W);
  });

  // [SF-WEB-56 follow-up] ROOT CAUSE of "two edges": a shared leaf's zone
  // center used to be recomputed from the two owning poles' PLACED (x,y)
  // angles via a "shortest arc" bisector — for exactly 2 root poles (an
  // ordinary, frequent case, not a rare degeneration: splitting 2π between
  // ANY two poles — whatever their relative weight — puts their WEDGE
  // CENTERS exactly π apart: center-to-center distance is always half of
  // each wedge's own width, summed, which is always half of the full 2π
  // regardless of how unevenly the two wedges split it) the "shortest arc"
  // is mathematically undefined at exactly π apart, and the old formula's
  // arbitrary tie-break sent the zone perpendicular to BOTH poles, often
  // much farther from either pole than the poles were from the seed —
  // producing two long, dramatically diverging arcs to a single shared leaf
  // that read as "two edges" on the live graph. There is no fully "natural"
  // placement for this exact case (the pole-pole axis passes straight
  // through the seed, so the geometric midpoint of the two poles collapses
  // onto the seed itself — see the OTHER old bug this exact branch already
  // guards against) — the fix's fallback (the poles' shared wedge boundary,
  // pushed out to a bounded minimum radius) is the best available anchor;
  // this test locks in that it stays BOUNDED (a small, fixed multiple of
  // the seed-to-pole reach), not a runaway distance.
  it("keeps a shared leaf's reach from each owning pole bounded — no runaway divergent arcs — even in the unavoidable exactly-2-poles case", () => {
    const seedId = 1, poleA = 2, poleB = 3, sharedLeaf = 200;
    State.graphNodes = [
      { id: seedId, isSeed: true }, { id: poleA, isSeed: false }, { id: poleB, isSeed: false },
      { id: sharedLeaf, isSeed: false },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 }, { from: seedId, to: poleB, weight: 1 },
      { from: poleA, to: sharedLeaf, weight: 1 }, { from: poleB, to: sharedLeaf, weight: 1 },
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);

    const { targets } = placeExpandedNodes({});
    const A = targets.get(poleA), B = targets.get(poleB), L = targets.get(sharedLeaf);
    const seedToPoleReach = Math.max(Math.hypot(A.x, A.y), Math.hypot(B.x, B.y));
    const poleToLeafReach = Math.max(Math.hypot(L.x - A.x, L.y - A.y), Math.hypot(L.x - B.x, L.y - B.y));

    // Bounded by a small multiple of the seed-to-pole reach — the old bug
    // had no such bound at all (radius came from (rA+rB)/2, which grows
    // with the poles' OWN distance from seed, compounding with the
    // perpendicular angular miss).
    expect(poleToLeafReach).toBeLessThan(seedToPoleReach * 1.5);
  });

  // For 2 poles that AREN'T root siblings splitting the full circle between
  // just themselves (here: 3 root poles total, A and B share a leaf, C is
  // an unrelated third pole) — A and B's angles are independent (id-derived
  // fallback, SF-WEB-57), so they are no longer forced to exactly opposite
  // angles. The shared leaf's zone centres on the literal geometric midpoint
  // between them — the strongest, most direct form of "reads as a boundary
  // between the two clusters" (SF-WEB-56's own wording — visual delineation,
  // not a random far-off point) — UNLESS that midpoint itself lands too
  // close to the seed's own dandelion, in which case it's pushed straight
  // out along the same ray (never perpendicular/sideways — that "wrong-side
  // jump" was the original bug this test guards against). So the invariant
  // that must hold regardless of the push is: same ANGLE as the true
  // midpoint, not necessarily the same DISTANCE.
  it("places a shared leaf on the same ray as the literal midpoint of its two owning poles when a third pole breaks exact angular opposition", () => {
    const seedId = 1, poleA = 2, poleB = 3, poleC = 4, sharedLeaf = 200;
    const cLeaves = [400, 401, 402, 403, 404, 405, 406, 407];  // gives poleC real weight of its own
    State.graphNodes = [
      { id: seedId, isSeed: true }, { id: poleA, isSeed: false }, { id: poleB, isSeed: false }, { id: poleC, isSeed: false },
      { id: sharedLeaf, isSeed: false },
      ...cLeaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 }, { from: seedId, to: poleB, weight: 1 }, { from: seedId, to: poleC, weight: 1 },
      { from: poleA, to: sharedLeaf, weight: 1 }, { from: poleB, to: sharedLeaf, weight: 1 },
      ...cLeaves.map(id => ({ from: poleC, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB, poleC]);

    const { targets } = placeExpandedNodes({});
    const A = targets.get(poleA), B = targets.get(poleB), L = targets.get(sharedLeaf);
    const midX = (A.x + B.x) / 2, midY = (A.y + B.y) / 2;
    const midDist = Math.hypot(midX, midY);
    // Only meaningful when the midpoint itself isn't degenerate (near seed) —
    // with a third pole in play, A and B are no longer forced opposite.
    expect(midDist).toBeGreaterThan(50);
    const midAngle = Math.atan2(midY, midX);
    const leafAngle = Math.atan2(L.y, L.x);
    const norm = a => { let x = a; while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
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
  // was invisible to that spacing math.
  //
  // [SF-WEB-59] savedPositions is no longer "inert" for poles — an entry
  // there now PINS that pole permanently (never repositioned on a later
  // call, see placeChildren's pinned/fresh split), by explicit request
  // ("экспайред [=раскрытые] и сид ноды... насмерть прибиты"). Feeding an
  // artificially bad (too-close) savedPositions pair here would just lock
  // in that bad placement — correct new behavior, not something this test
  // should exercise. Testing FRESH placement instead (no savedPositions for
  // the poles): the vector+nudge engine (SF-WEB-57) still has to keep
  // poleA's whole nested subtree clear of poleB's leaves by construction.
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

    const { targets } = placeExpandedNodes({});

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

  // (б) [SF-WEB-57] Root poles no longer divide 2π proportionally to
  //     subtree weight (that top-down scheme was the ROOT CAUSE of "the
  //     whole graph turns into a line": a node with exactly one child
  //     handed its child the FULL parent wedge — same centre angle, only
  //     the radius grew, so any single-child expansion chain was perfectly
  //     collinear). Each root pole's angle now comes from its own
  //     deterministic id-derived direction, independent of leaf/subtree
  //     weight — verified here by giving poles wildly different weights
  //     (2, 4, 6 leaves) and checking that weight has NO bearing on the
  //     assigned angle (it's the same regardless of the other poles present),
  //     while the poles still tile the circle without overlapping.
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
    const norm = a => { let x = a; while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
    const angle = pole => norm(Math.atan2(targets.get(pole).y, targets.get(pole).x));

    // Same graph, but pole 4's weight is now tiny (one leaf instead of six) —
    // the OLD algorithm would have given it a much narrower wedge and shifted
    // every other pole's centre angle along with it; the new one shouldn't
    // move pole 2 or 3 at all, since their own id-derived attempt angle
    // never depended on pole 4's weight in the first place.
    State.graphEdges = State.graphEdges.filter(e => e.from !== 4 || e.to === 410);
    State.graphNodes = State.graphNodes.filter(n => ![411, 412, 413, 414, 415].includes(n.id));
    const { targets: targets2 } = placeExpandedNodes({});

    expect(angle(2)).toBeCloseTo(norm(Math.atan2(targets2.get(2).y, targets2.get(2).x)), 6);
    expect(angle(3)).toBeCloseTo(norm(Math.atan2(targets2.get(3).y, targets2.get(3).x)), 6);

    // Poles still tile the circle without overlapping (no two closer than
    // MIN_SEP once dandelion radii are accounted for) — the actual guarantee
    // that matters, now delivered by incremental angular nudging instead of
    // analytic wedge subdivision.
    const pts = [2, 3, 4].map(p => targets.get(p));
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThanOrEqual(NODE_W);
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

  // Dense/narrow-wedge case: many sibling poles crowding the full circle
  // (the exact "many small leaf-poles around a hub" shape from the app
  // screenshot that motivated this ticket). Here each pole's own wedge is
  // narrow, so fitR — not baseR — decides the radius, and a fixed additive
  // gap constant on baseR alone would have zero effect (adjacent dandelions
  // would sit tangent to their wedge boundary with no slack at all). This
  // is the case the plain-additive-constant version of clusterGap silently
  // failed on; the fitR "collar" (dR + gap/2) is what fixes it.
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
    // Each pole's own dandelion radius: farthest of its 3 leaves from it.
    const poleR = new Map(poles.map(poleId => {
      const P = targets.get(poleId);
      const leafIds = [0, 1, 2].map(l => 1000 + (poleId - 100) * 10 + l);
      const r = Math.max(...leafIds.map(id => {
        const t = targets.get(id);
        return Math.hypot(t.x - P.x, t.y - P.y);
      }));
      return [poleId, r];
    }));
    // Compare every ADJACENT pair by angle (they're the ones whose wedges
    // actually touch) rather than all pairs.
    const byAngle = [...poles].sort((a, b) =>
      Math.atan2(targets.get(a).y, targets.get(a).x) - Math.atan2(targets.get(b).y, targets.get(b).x));
    for (let i = 0; i < byAngle.length; i++) {
      const a = byAngle[i], b = byAngle[(i + 1) % byAngle.length];
      const A = targets.get(a), B = targets.get(b);
      const dist = Math.hypot(A.x - B.x, A.y - B.y);
      const gap = dist - poleR.get(a) - poleR.get(b);
      expect(gap).toBeGreaterThan(MIN_SEP * 0.75);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-55] edgeClass — intra/cross edge classification consumed by
// vis-adapter/edge-render.js. "intra" is exactly the parent→child edge that
// placed the node (pole tree edge, or pole/seed → its own exclusive leaf);
// everything else ("cross") gets a hub for its chord-style arc: the shared
// root pole if both endpoints trace to the same subtree, otherwise the seed
// (hub: null).
// ════════════════════════════════════════════════════════════════════════════
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
    const seedId = 1, poleA = 2;
    const leaves = [200, 201, 202];
    State.graphNodes = [
      { id: seedId, isSeed: true }, { id: poleA, isSeed: false },
      ...leaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
      ...leaves.map(id => ({ id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 })),
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
    const seedId = 1, poleA = 2, poleB = 3;
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
    const seedId = 1, poleA = 2, poleB = 3, shared = 900;
    State.graphNodes = [
      { id: seedId, isSeed: true }, { id: poleA, isSeed: false }, { id: poleB, isSeed: false },
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
    // Different root sectors (poleA vs poleB, both root poles) → hub is the
    // seed, represented as null (see edge-render.js: null → {0,0}).
    expect(eA.hub).toBeNull();
    expect(eB.hub).toBeNull();
  });

  it("classifies a leaf↔leaf edge within the same subtree as cross with hub = their shared root pole", () => {
    const seedId = 1, poleA = 2;
    const leafX = 200, leafY = 201;
    State.graphNodes = [
      { id: seedId, isSeed: true }, { id: poleA, isSeed: false },
      { id: leafX, isSeed: false }, { id: leafY, isSeed: false },
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
      { id: `${poleA}_${leafX}`, from: poleA, to: leafX, weight: 1 },
      { id: `${poleA}_${leafY}`, from: poleA, to: leafY, weight: 1 },
      // Extra "companion" collaboration edge between two of the pole's own
      // leaves — not a tree edge, not an exclusive-ownership edge either.
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
    // buildMultiPoleGraph()'s fixture edges predate SF-WEB-55 and don't set
    // .id — same "min(from,to)_max(from,to)" fallback layout.js itself uses
    // when .id is absent (real graph.js-built edges always have it).
    buildMultiPoleGraph();
    const { edgeClass } = placeExpandedNodes({});
    expect(edgeClass.size).toBe(State.graphEdges.length);
    for (const e of State.graphEdges) {
      const key = e.id ?? `${Math.min(e.from, e.to)}_${Math.max(e.from, e.to)}`;
      expect(edgeClass.has(key)).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-56] Cluster gap scales with SHARED MEMBER COUNT, not just a
// cluster's own radius (SF-WEB-54's dR-only version left dense, heavily-
// shared regions reading as one blurred blob, since dR-proportional gap
// didn't grow with how much cross-sector traffic converges there). Also
// verifies the seed↔pole and pole↔pole cases use the exact same formula.
// ════════════════════════════════════════════════════════════════════════════
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
      { id: seedId, isSeed: true }, { id: poleA, isSeed: false }, { id: poleB, isSeed: false },
      ...aLeaves.map(id => ({ id, isSeed: false })),
      ...bLeaves.map(id => ({ id, isSeed: false })),
      ...shared.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
      { id: `${seedId}_${poleB}`, from: seedId, to: poleB, weight: 1 },
      ...aLeaves.map(id => ({ id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 })),
      ...bLeaves.map(id => ({ id: `${poleB}_${id}`, from: poleB, to: id, weight: 1 })),
      ...shared.flatMap(id => [
        { id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 },
        { id: `${poleB}_${id}`, from: poleB, to: id, weight: 1 },
      ]),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB]);
  }

  it("two poles with a LARGE shared lens end up farther apart than two poles with none", () => {
    const seedId = 1, poleA = 2, poleB = 3;
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
    const seedId = 1, poleA = 2;
    const aLeaves = [200, 201, 202, 203];
    const build = sharedCount => {
      const shared = Array.from({ length: sharedCount }, (_, i) => 9000 + i);
      State.graphNodes = [
        { id: seedId, isSeed: true }, { id: poleA, isSeed: false },
        ...aLeaves.map(id => ({ id, isSeed: false })),
        ...shared.map(id => ({ id, isSeed: false })),
      ];
      State.graphEdges = [
        { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
        ...aLeaves.map(id => ({ id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 })),
        ...shared.flatMap(id => [
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

  it("keeps the SF-WEB-51 no-overlap guarantee under heavy sharing", () => {
    buildTwoPoleGraph(1, 2, 3, 12);
    const { targets } = placeExpandedNodes({});
    expect(minSepWithSeed(targets)).toBeGreaterThanOrEqual(MIN_SEP - 1e-6);
  });

  // [SF-WEB-56 follow-up] The first version scaled LINEARLY with shared
  // count (sharedCount * 39px) — on a real, densely-collaborated artist
  // graph (dozens of shared featured-on credits between two poles is
  // ordinary), that blew the gap out to thousands of pixels, leaving huge
  // empty voids instead of a "distinguishably separated" boundary (exactly
  // what the live-app screenshot showed). sqrt-scaling + a hard cap keeps
  // the growth diminishing and bounded regardless of how many members two
  // clusters share.
  it("caps the extra shared-count gap — 80 shared members isn't dramatically farther than 20", () => {
    buildTwoPoleGraph(1, 2, 3, 20);
    const { targets: t20 } = placeExpandedNodes({});
    const d20 = Math.hypot(t20.get(2).x - t20.get(3).x, t20.get(2).y - t20.get(3).y);

    buildTwoPoleGraph(1, 2, 3, 80);
    const { targets: t80 } = placeExpandedNodes({});
    const d80 = Math.hypot(t80.get(2).x - t80.get(3).x, t80.get(2).y - t80.get(3).y);

    // Still grows a bit (sqrt is monotonic)…
    expect(d80).toBeGreaterThanOrEqual(d20);
    // …but nowhere near proportionally — a naive linear formula would have
    // made d80 roughly 4x d20 (80/20); the capped sqrt version stays close.
    expect(d80).toBeLessThan(d20 * 1.5);
  });
});

// [SF-WEB-59] "экспайред [=раскрытые] и сид ноды... насмерть прибиты к
// своим местам и никакими расширениями не должны быть смещены" — once a
// pole has a saved (previously rendered) position, placeExpandedNodes must
// reuse it EXACTLY on every later call, regardless of what else gets
// expanded alongside it.
describe("placeExpandedNodes — pole/seed pinning across re-layout (SF-WEB-59)", () => {
  it("keeps an already-placed pole's position exactly unchanged when a new sibling is expanded", () => {
    const seedId = 1, poleA = 2, poleC = 4;
    const aLeaves = [10, 11, 12];
    State.graphNodes = [
      { id: seedId, isSeed: true }, { id: poleA, isSeed: false },
      ...aLeaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      ...aLeaves.map(id => ({ from: poleA, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA]);

    const { targets: first } = placeExpandedNodes({});
    const firstPos = { ...first.get(poleA) };

    // Second call: poleA now has a saved position (as if already rendered),
    // AND a brand-new sibling poleC (lower id than poleA — under the OLD
    // "recompute everything from scratch, sorted by id" scheme this would
    // have been processed FIRST and could steal poleA's slot).
    const cLeaves = [30, 31, 32, 33, 34];
    State.graphNodes.push({ id: poleC, isSeed: false }, ...cLeaves.map(id => ({ id, isSeed: false })));
    State.graphEdges.push(
      { from: seedId, to: poleC, weight: 1 },
      ...cLeaves.map(id => ({ from: poleC, to: id, weight: 1 })),
    );
    State.expandedNodes = new Set([poleA, poleC]);
    const savedPositions = { [poleA]: firstPos };
    const { targets: second } = placeExpandedNodes(savedPositions);

    expect(second.get(poleA)).toEqual(firstPos);
  });

  it("gives a pinned pole's fromPos equal to its target — zero animation for a node that isn't moving", () => {
    const seedId = 1, poleA = 2;
    State.graphNodes = [{ id: seedId, isSeed: true }, { id: poleA, isSeed: false }, { id: 10, isSeed: false }];
    State.graphEdges = [{ from: seedId, to: poleA, weight: 1 }, { from: poleA, to: 10, weight: 1 }];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA]);

    const { targets: first } = placeExpandedNodes({});
    const firstPos = { ...first.get(poleA) };
    const { targets: second, fromPos: fromPos2 } = placeExpandedNodes({ [poleA]: firstPos });
    expect(fromPos2.get(poleA)).toEqual(second.get(poleA));
  });

  it("a fresh pole's placement direction accounts for ALL its real hub connections, not only its expand-tree parent", () => {
    const seedId = 1, poleA = 2, poleB = 3, poleX = 200;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      // [SF-WEB-60] _poleSettled: true — same "already went through one
      // full placement pass" marker placeChildren itself sets on a real
      // graphNode after freshly placing it (see layout.js). Without it, a
      // mere savedPositions entry is no longer enough to pin a pole (that
      // was the SF-WEB-60 bug: a node's OLD LEAF position, present in
      // savedPositions long before it ever became a pole, used to get
      // mistaken for an already-settled POLE position) — poleA/poleB
      // would just get recomputed fresh here instead of staying at the
      // controlled positions this test needs.
      { id: poleA, isSeed: false, _poleSettled: true },
      { id: poleB, isSeed: false, _poleSettled: true },
      // poleX's expand-TREE parent is poleA, but it also has a direct real
      // edge to poleB — both must pull its placement vector.
      { id: poleX, isSeed: false, _expandParent: poleA },
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: seedId, to: poleB, weight: 1 },
      { from: poleA, to: poleX, weight: 1 },
      { from: poleB, to: poleX, weight: 1 },  // the EXTRA connection
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleA, poleB, poleX]);

    // Pin poleA and poleB far apart at controlled angles (0° and 90°) so
    // poleX's own vector-sum direction is predictable.
    const savedPositions = {
      [poleA]: { x: 1000, y: 0 },
      [poleB]: { x: 0, y: 1000 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const x = targets.get(poleX);
    const angle = Math.atan2(x.y, x.x);

    // Pure "continue from tree-parent poleA" would give angle ≈ 0. The
    // extra edge to poleB (at 90°) must pull it meaningfully off that.
    // [SF-WEB-70] Threshold lowered from 0.2 to 0.1: trilateration (now used
    // here — 2 real hub connections) pulls by the actual GEOMETRICALLY
    // required amount, not a naive position-average like the old
    // _ownerVector path did — genuinely smaller in this fixture, but still
    // clearly non-zero (real signal, not noise).
    expect(Math.abs(angle)).toBeGreaterThan(0.1);
    // But it shouldn't overshoot past poleB's own angle either — the
    // result is a genuine blend, not a jump to the OTHER extreme.
    expect(angle).toBeLessThan(Math.PI / 2);
  });

  // [SF-WEB-60] THE actual regression report: "мы прибили полюс к его
  // старой позиции ЛИСТА, а не дали ему полноценно разместиться как
  // полюс" — a node that already exists on the graph as a plain LEAF (in
  // savedPositions from being drawn in a ring around its parent) gets
  // double-clicked to become a NEW pole for the very first time. It must
  // get a REAL vector+nudge pole placement (far enough from its parent for
  // its own dandelion + gap, per baseR), not simply stay glued to its old,
  // much-closer-in leaf-ring coordinate just because that id already had
  // *some* entry in savedPositions.
  it("gives a leaf being promoted to a pole for the first time a real pole placement, not its old leaf position", () => {
    const seedId = 1, poleA = 2, promoted = 300;
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: poleA, isSeed: false, _poleSettled: true },
      { id: promoted, isSeed: false },  // still a plain leaf as far as this call knows
    ];
    State.graphEdges = [
      { from: seedId, to: poleA, weight: 1 },
      { from: poleA, to: promoted, weight: 1 },
    ];
    State.currentSeedId = seedId;
    // `promoted` is now expanded (double-clicked) — but its _poleSettled
    // flag was never set, because until this exact call it was only ever
    // a leaf, never placed as a pole.
    State.expandedNodes = new Set([poleA, promoted]);

    const oldLeafPos = { x: 160, y: 5 };  // where it sat in poleA's leaf ring
    const savedPositions = {
      [poleA]: { x: 900, y: 0 },
      [promoted]: oldLeafPos,
    };
    const { targets } = placeExpandedNodes(savedPositions);

    const newPos = targets.get(promoted);
    // A real pole placement sits baseR away from its parent (poleA's own
    // dandelion radius + gap + this node's own dandelion radius) — that's
    // necessarily much farther than a leaf-ring radius (~150-200px). If
    // the old bug were still present, newPos would equal oldLeafPos exactly.
    expect(newPos).not.toEqual(oldLeafPos);
    const distFromPoleA = Math.hypot(newPos.x - 900, newPos.y - 0);
    expect(distFromPoleA).toBeGreaterThan(200);
  });
});

// [SF-WEB-61] THE "ЧП" regression report: "наша с тобой реализация
// векторами работает плохо для нескольких отцов с одной стороны" — when
// many siblings under one parent ALSO share a real edge to the same other
// hub, their _ownerVector attemptAngle clusters near-identically. Enough of
// them independently exhaust the 24-try angular nudge and used to fall back
// to an UNBOUNDED radius-growth escape valve (`r *= 1.15` up to 32 times,
// ≈111x max) — producing a few nodes stretched wildly farther than their
// siblings (repro measured ≈88x). The fix tracks the best angle found
// during nudging and caps the growth fallback to a small bounded multiple.
describe("placeExpandedNodes — bounded radial growth for crowded shared-hub siblings (SF-WEB-61)", () => {
  it("never lets a same-round sibling's radius balloon far beyond its peers, even when many siblings share a second hub", () => {
    const seedId = 1, hubA = 2, hubB = 3;
    const soloLeaves = Array.from({ length: 8 }, (_, i) => 100 + i);
    const sharedLeaves = Array.from({ length: 7 }, (_, i) => 200 + i);

    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: hubA, isSeed: false, _poleSettled: true },
      { id: hubB, isSeed: false, _poleSettled: true },
      ...soloLeaves.map(id => ({ id, isSeed: false })),
      ...sharedLeaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: hubA, weight: 1 },
      { from: seedId, to: hubB, weight: 1 },
      ...soloLeaves.map(id => ({ from: hubA, to: id, weight: 1 })),
      // Every "shared" leaf hangs off hubA in the expand tree AND also has
      // a real edge to hubB — this is the "second father" pulling all of
      // their attemptAngle toward roughly the same direction.
      ...sharedLeaves.map(id => ({ from: hubA, to: id, weight: 1 })),
      ...sharedLeaves.map(id => ({ from: hubB, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([hubA, hubB, ...soloLeaves, ...sharedLeaves]);

    const savedPositions = {
      [hubA]: { x: 900, y: 0 },
      [hubB]: { x: 0, y: 900 },
    };
    const { targets } = placeExpandedNodes(savedPositions);

    const dist = id => {
      const p = targets.get(id);
      return Math.hypot(p.x - 900, p.y - 0);
    };
    const soloDists = soloLeaves.map(dist);
    const sharedDists = sharedLeaves.map(dist);
    const maxSolo = Math.max(...soloDists);
    const maxShared = Math.max(...sharedDists);

    // Before the fix this ratio measured ≈88x on an equivalent repro.
    expect(maxShared).toBeLessThan(maxSolo * 4);
  });
});

// [SF-WEB-62] "мы посчитали направление правильно, а вот растояние нас
// подвело" — SF-WEB-61's fix capped the radial-growth fallback at a
// MULTIPLIER of baseR (1.15^6 ≈ 2.3x), which meant the absolute extra
// distance it could add scaled with how far the pole already was from the
// seed: a small, reasonable jump for a shallow pole, but a huge one for a
// pole several expand-levels deep. This regression pins the fix's actual
// requirement: the ABSOLUTE extra distance the growth fallback ever adds
// must stay roughly the same regardless of depth/baseR magnitude.
describe("placeExpandedNodes — radial growth adds a bounded ABSOLUTE distance, independent of depth (SF-WEB-62)", () => {
  function buildCrowdedHub({ hubId, siblingCount = 15, hubB }) {
    const solo = Array.from({ length: Math.ceil(siblingCount / 2) }, (_, i) => hubId * 100000 + i);
    const shared = Array.from({ length: Math.floor(siblingCount / 2) }, (_, i) => hubId * 100000 + 1000 + i);
    const nodes = [
      { id: hubId, isSeed: false, _poleSettled: true },
      { id: hubB, isSeed: false, _poleSettled: true },
      ...solo.map(id => ({ id, isSeed: false })),
      ...shared.map(id => ({ id, isSeed: false })),
    ];
    const edges = [
      ...solo.map(id => ({ from: hubId, to: id, weight: 1 })),
      ...shared.map(id => ({ from: hubId, to: id, weight: 1 })),
      ...shared.map(id => ({ from: hubB, to: id, weight: 1 })), // second father, same crowding as SF-WEB-61's repro
    ];
    return { nodes, edges, solo, shared };
  }

  it("caps the extra distance a crowded pole's own siblings can be pushed to a similar absolute amount whether that pole is near or far from the seed", () => {
    const seedId = 1;
    const nearHub = 2, nearHubB = 3;
    const farHub = 20, farHubB = 21;

    const near = buildCrowdedHub({ seedId, hubId: nearHub, hubB: nearHubB });
    const far  = buildCrowdedHub({ seedId, hubId: farHub,  hubB: farHubB });

    State.graphNodes = [
      { id: seedId, isSeed: true },
      ...near.nodes, ...far.nodes,
    ];
    State.graphEdges = [
      { from: seedId, to: nearHub,  weight: 1 },
      { from: seedId, to: nearHubB, weight: 1 },
      { from: seedId, to: farHub,   weight: 1 },
      { from: seedId, to: farHubB,  weight: 1 },
      ...near.edges, ...far.edges,
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([
      nearHub, nearHubB, farHub, farHubB,
      ...near.solo, ...near.shared, ...far.solo, ...far.shared,
    ]);

    // farHub/farHubB pinned MUCH farther from the seed than nearHub/nearHubB
    // — this is the "several expand-levels deep" case, all else equal.
    const savedPositions = {
      [nearHub]:  { x: 900,   y: 0 },
      [nearHubB]: { x: 0,     y: 900 },
      [farHub]:   { x: 20000, y: 0 },
      [farHubB]:  { x: 0,     y: 20000 },
    };
    const { targets } = placeExpandedNodes(savedPositions);

    const maxExtra = (hubPos, siblingIds) => {
      let maxExtra = 0;
      for (const id of siblingIds) {
        const p = targets.get(id);
        const dist = Math.hypot(p.x - hubPos.x, p.y - hubPos.y);
        // solo siblings (no growth fallback triggered) give the "expected"
        // un-grown distance baseline for this hub.
        maxExtra = Math.max(maxExtra, dist);
      }
      return maxExtra;
    };

    const nearSharedMax = maxExtra(savedPositions[nearHub], near.shared);
    const nearSoloMax   = maxExtra(savedPositions[nearHub], near.solo);
    const farSharedMax  = maxExtra(savedPositions[farHub], far.shared);
    const farSoloMax    = maxExtra(savedPositions[farHub], far.solo);

    const nearExtra = nearSharedMax - nearSoloMax;
    const farExtra   = farSharedMax - farSoloMax;

    // Before this fix (multiplicative 1.15^6 cap), farExtra would be
    // roughly farHub's own baseR / nearHub's baseR times bigger than
    // nearExtra (here that ratio is ~20000/900 ≈ 22x) — an absolute-step
    // cap keeps the two comparable instead.
    expect(farExtra).toBeLessThan(nearExtra * 4 + 50);
  });
});

// [SF-WEB-70] "для больших толчках (сильный вектор) пользуйся
// трилатерацией" — a node with 2+ real hub connections lands at
// (approximately) the exact ideal distance from BOTH hubs simultaneously
// (true 2-circle trilateration) instead of just "roughly pulled toward
// both" the way _ownerVector's plain position-average did. A node with
// exactly ONE real connection (the common case) is completely unaffected —
// still the plain baseR+_ownerVector path, byte-for-byte.
describe("placeExpandedNodes — trilateration for nodes with 2 real hub connections (SF-WEB-70)", () => {
  it("lands a node at (approximately) the exact ideal distance from BOTH of its real hub connections when their circles actually intersect", () => {
    const seedId = 1, hubA = 2, hubB = 3, poleX = 200;
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
    const seedId = 1, hubA = 2, hubB = 3, poleX = 200;
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

  // [SF-WEB-65] "картина далека от целевой... несколько несвязанных
  // кластеров" — a degenerate-blend node whose PRIMARY hub (h1) itself
  // carries a huge dandelion (hundreds of leaves, so a huge R1) used to
  // fly off into its own visually separate "island": the same small
  // ANGULAR deviation toward a secondary hub, multiplied by a giant R1,
  // is a giant ABSOLUTE sideways displacement. The fix caps that lateral
  // displacement in absolute px, not degrees — this pins the node close
  // to h1's own honest "continue straight outward" line regardless of how
  // large h1's own dandelion is.
  it("keeps a node close to its primary hub's own outward line even when that hub carries a huge dandelion (no more flying off into a separate island)", () => {
    const seedId = 1, hubA = 2, hubB = 3, poleX = 200;
    const hubALeaves = Array.from({ length: 120 }, (_, i) => 1000 + i);
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: hubA, isSeed: false, _poleSettled: true },
      { id: hubB, isSeed: false, _poleSettled: true },
      { id: poleX, isSeed: false, _expandParent: hubA },
      ...hubALeaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: hubA, weight: 1 },
      { from: seedId, to: hubB, weight: 1 },
      { from: hubA, to: poleX, weight: 1 },
      { from: hubB, to: poleX, weight: 1 },
      ...hubALeaves.map(id => ({ from: hubA, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([hubA, hubB, poleX]);

    const savedPositions = {
      [hubA]: { x: 5000, y: 0 },
      [hubB]: { x: 0, y: 500 },
    };
    const { targets } = placeExpandedNodes(savedPositions);
    const pos = targets.get(poleX);

    // The node's lateral distance off hubA's own straight "continue
    // outward from seed" line (the x-axis here, since hubA sits at
    // (5000,0)) must stay bounded — not a multi-thousand-px swing.
    expect(Math.abs(pos.y)).toBeLessThan(MIN_SEP * 6 + 1);
  });

  // [SF-WEB-70] The anchor bug found in the earlier session (SF-WEB-66):
  // when the node's TREE PARENT is the seed itself (no real direction —
  // seed sits at (0,0)) but it ALSO has a real edge to an already-placed,
  // large hub, the degenerate "pure" line must anchor on the hub that
  // actually has a direction — not on the seed's arbitrary fallback angle.
  it("anchors the degenerate-blend 'pure' line on the real hub (not the seed's arbitrary fallback angle) when the node's tree parent is the seed itself", () => {
    const seedId = 1, hubA = 2, poleX = 200;
    const hubALeaves = Array.from({ length: 120 }, (_, i) => 1000 + i);
    State.graphNodes = [
      { id: seedId, isSeed: true },
      { id: hubA, isSeed: false, _poleSettled: true },
      { id: poleX, isSeed: false, _expandParent: seedId },
      ...hubALeaves.map(id => ({ id, isSeed: false })),
    ];
    State.graphEdges = [
      { from: seedId, to: hubA, weight: 1 },
      { from: seedId, to: poleX, weight: 1 },
      { from: hubA, to: poleX, weight: 1 },
      ...hubALeaves.map(id => ({ from: hubA, to: id, weight: 1 })),
    ];
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([hubA, poleX]);

    const savedPositions = { [hubA]: { x: 5000, y: 0 } };
    const { targets } = placeExpandedNodes(savedPositions);
    const pos = targets.get(poleX);

    expect(pos.x).toBeGreaterThan(4000);
    expect(Math.hypot(pos.x - 5000, pos.y)).toBeLessThan(2500);
  });

  // A node with exactly ONE real connection must be completely unaffected
  // — _trilaterationPoint returns null (< 2 hubs), the plain baseR+
  // _ownerVector path runs exactly as it did before this ticket.
  it("leaves single-hub nodes on the plain baseR+_ownerVector path, unaffected by trilateration", () => {
    const seedId = 1, hubA = 2, poleX = 200;
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

    // Continues straight out from hubA along the seed→hubA ray (x-axis).
    expect(pos.y).toBeCloseTo(0, 5);
    expect(pos.x).toBeGreaterThan(1000);
  });
});