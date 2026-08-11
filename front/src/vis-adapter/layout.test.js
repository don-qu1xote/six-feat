import { describe, it, expect, beforeEach } from "vitest";
import {
  placePathNodes,
  classifyGraph,
  buildLayoutRequest,
  markEntrancePending,
  markLayoutSettled,
  beginLayout,
  isCurrentLayout,
  entranceFrom,
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

function resetGraph() {
  State.graphNodes = [];
  State.graphEdges = [];
  State.currentSeedId = null;
  State.expandedNodes = new Set();
  State.network = {};
  State.nodesDS = {};
}

function buildTwoPoleGraph({ seedId = 1, poleA = 2, poleB = 3 } = {}) {
  const aLeaves = [200, 201];
  const bLeaves = [300, 301];
  const shared = 900;
  const seedLeaf = 999;
  State.graphNodes = [
    { id: seedId, isSeed: true },
    { id: poleA, isSeed: false },
    { id: poleB, isSeed: false },
    ...aLeaves.map((id) => ({ id, isSeed: false })),
    ...bLeaves.map((id) => ({ id, isSeed: false })),
    { id: shared, isSeed: false },
    { id: seedLeaf, isSeed: false },
  ];
  State.graphEdges = [
    { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
    { id: `${seedId}_${poleB}`, from: seedId, to: poleB, weight: 1 },
    { id: `${seedId}_${seedLeaf}`, from: seedId, to: seedLeaf, weight: 1 },
    ...aLeaves.map((id) => ({ id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 })),
    ...bLeaves.map((id) => ({ id: `${poleB}_${id}`, from: poleB, to: id, weight: 1 })),
    { id: `${poleA}_${shared}`, from: poleA, to: shared, weight: 1 },
    { id: `${poleB}_${shared}`, from: poleB, to: shared, weight: 1 },
  ];
  State.currentSeedId = seedId;
  State.expandedNodes = new Set([poleA, poleB]);
  State.network = {};
  State.nodesDS = {};
  return { seedId, poleA, poleB, aLeaves, bLeaves, shared, seedLeaf };
}

beforeEach(resetGraph);

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

    const { edgeClass } = classifyGraph();
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

    const { edgeClass } = classifyGraph();
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

    const { edgeClass } = classifyGraph();
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

    const { edgeClass } = classifyGraph();
    const cross = edgeClass.get(`${leafX}_${leafY}`);
    expect(cross.kind).toBe("cross");
    expect(cross.hub).toBe(poleA);
  });

  it("covers every edge in the graph — nothing is left unclassified", () => {
    buildTwoPoleGraph();
    const { edgeClass } = classifyGraph();
    expect(edgeClass.size).toBe(State.graphEdges.length);
    for (const e of State.graphEdges) {
      const key = e.id ?? `${Math.min(e.from, e.to)}_${Math.max(e.from, e.to)}`;
      expect(edgeClass.has(key)).toBe(true);
    }
  });
});

describe("classifyGraph — sectorMembers", () => {
  it("returns empty maps when there is no seed", () => {
    expect(classifyGraph()).toEqual({ edgeClass: new Map(), sectorMembers: new Map() });
  });

  it("gives every pole and the seed a sector of its own", () => {
    const g = buildTwoPoleGraph();
    const { sectorMembers } = classifyGraph();
    expect([...sectorMembers.keys()].sort((a, b) => a - b)).toEqual([g.seedId, g.poleA, g.poleB]);
  });

  it("puts an exclusive leaf in its own pole's sector and nowhere else", () => {
    const g = buildTwoPoleGraph();
    const { sectorMembers } = classifyGraph();
    expect(sectorMembers.get(g.poleA).has(g.aLeaves[0])).toBe(true);
    expect(sectorMembers.get(g.poleB).has(g.aLeaves[0])).toBe(false);
    expect(sectorMembers.get(g.seedId).has(g.aLeaves[0])).toBe(false);
  });

  it("puts a shared leaf in both owning sectors — that is what makes the lens a lens", () => {
    const g = buildTwoPoleGraph();
    const { sectorMembers } = classifyGraph();
    expect(sectorMembers.get(g.poleA).has(g.shared)).toBe(true);
    expect(sectorMembers.get(g.poleB).has(g.shared)).toBe(true);
  });

  it("leaves a neighbour of the seed alone in the seed's sector", () => {
    const g = buildTwoPoleGraph();
    const { sectorMembers } = classifyGraph();
    expect(sectorMembers.get(g.seedId).has(g.seedLeaf)).toBe(true);
    expect(sectorMembers.get(g.poleA).has(g.seedLeaf)).toBe(false);
  });

  it("does not hang on a cycle in the expand chain", () => {
    const g = buildTwoPoleGraph();
    State.graphNodes.find((n) => n.id === g.poleA)._expandParent = g.poleB;
    State.graphNodes.find((n) => n.id === g.poleB)._expandParent = g.poleA;
    const { sectorMembers } = classifyGraph();
    expect(sectorMembers.size).toBe(3);
  });
});

describe("buildLayoutRequest — structure, not data", () => {
  it("returns null without a seed", () => {
    expect(buildLayoutRequest({})).toBeNull();
  });

  it("sends ids and edges only — no names, images or roles", () => {
    const g = buildTwoPoleGraph();
    State.graphNodes.forEach((n) => {
      n.name = "Some Artist";
      n.image = "https://example.test/pic.jpg";
    });
    State.graphEdges.forEach((e) => {
      e.dominantRole = "featured";
    });

    const req = buildLayoutRequest({});
    expect(req.seed_id).toBe(g.seedId);
    expect(req.nodes).toEqual(State.graphNodes.map((n) => n.id));
    expect(req.edges).toEqual(State.graphEdges.map((e) => [e.from, e.to]));
    const serialized = JSON.stringify(req);
    expect(serialized).not.toContain("Some Artist");
    expect(serialized).not.toContain("example.test");
    expect(serialized).not.toContain("featured");
  });

  it("carries the drawn node size, so the server never has to know it", () => {
    buildTwoPoleGraph();
    const req = buildLayoutRequest({});
    expect(req.node_gap).toBe(NODE_GAP);
    expect(2 * req.node_radius + req.node_gap).toBe(MIN_SEP);
  });

  it("pins a pole only once it has settled, never before", () => {
    const g = buildTwoPoleGraph();
    const saved = { [g.poleA]: { x: 10, y: 20 }, [g.poleB]: { x: -10, y: -20 } };

    expect(buildLayoutRequest(saved).pinned).toEqual({});

    State.graphNodes.find((n) => n.id === g.poleA)._poleSettled = true;
    expect(buildLayoutRequest(saved).pinned).toEqual({ [g.poleA]: { x: 10, y: 20 } });
  });

  it("pins a leaf the moment it has a position — a leaf has nothing to settle into", () => {
    const g = buildTwoPoleGraph();
    const req = buildLayoutRequest({ [g.seedLeaf]: { x: 7, y: 8 } });
    expect(req.pinned).toEqual({ [g.seedLeaf]: { x: 7, y: 8 } });
  });

  it("never pins a node still parked at its entrance, however finite that position looks", () => {
    const g = buildTwoPoleGraph();
    const leaf = State.graphNodes.find((n) => n.id === g.seedLeaf);
    markEntrancePending([leaf]);

    expect(buildLayoutRequest({ [g.seedLeaf]: { x: 0, y: 0 } }).pinned).toEqual({});

    markLayoutSettled(new Map([[g.seedLeaf, { x: 7, y: 8 }]]));
    expect(buildLayoutRequest({ [g.seedLeaf]: { x: 7, y: 8 } }).pinned).toEqual({
      [g.seedLeaf]: { x: 7, y: 8 },
    });
  });

  it("never pins the seed: it is always the origin, and saying so twice invites disagreement", () => {
    const g = buildTwoPoleGraph();
    const req = buildLayoutRequest({ [g.seedId]: { x: 500, y: 500 } });
    expect(req.pinned[g.seedId]).toBeUndefined();
  });

  it("survives being handed no saved positions at all", () => {
    buildTwoPoleGraph();
    expect(buildLayoutRequest(null).pinned).toEqual({});
    expect(buildLayoutRequest(undefined).pinned).toEqual({});
  });

  it("skips a position that is not a number, rather than sending NaN to the server", () => {
    const g = buildTwoPoleGraph();
    const req = buildLayoutRequest({ [g.seedLeaf]: { x: NaN, y: 3 } });
    expect(req.pinned).toEqual({});
  });

  it("passes the expand chain through, and leaves the seed's own parent out of it", () => {
    const g = buildTwoPoleGraph();
    State.graphNodes.find((n) => n.id === g.poleB)._expandParent = g.poleA;
    const req = buildLayoutRequest({});
    expect(req.expand_parent).toEqual({ [g.poleB]: g.poleA });
  });
});

describe("markLayoutSettled / entranceFrom — applying the answer", () => {
  it("marks exactly the poles the layout answered for", () => {
    const g = buildTwoPoleGraph();
    markLayoutSettled(new Map([[g.poleA, { x: 1, y: 2 }]]));
    expect(State.graphNodes.find((n) => n.id === g.poleA)._poleSettled).toBe(true);
    expect(State.graphNodes.find((n) => n.id === g.poleB)._poleSettled).toBeUndefined();
  });

  it("leaves a node the layout did not answer for parked, rather than trusting its position", () => {
    const g = buildTwoPoleGraph();
    markEntrancePending(State.graphNodes);
    markLayoutSettled(new Map([[g.poleA, { x: 1, y: 2 }]]));
    expect(State.graphNodes.find((n) => n.id === g.poleA)._entrancePending).toBe(false);
    expect(State.graphNodes.find((n) => n.id === g.poleB)._entrancePending).toBe(true);
  });

  it("survives being handed nothing at all", () => {
    buildTwoPoleGraph();
    expect(() => markLayoutSettled(null)).not.toThrow();
    expect(() => markEntrancePending(null)).not.toThrow();
  });

  it("starts everything at the origin when there is nothing saved", () => {
    const g = buildTwoPoleGraph();
    const from = entranceFrom(null, [g.poleA, g.poleB]);
    expect(from.get(g.poleA)).toEqual({ x: 0, y: 0 });
    expect(from.get(g.poleB)).toEqual({ x: 0, y: 0 });
  });

  it("starts a node's flight where it already is, and the seed's at the origin", () => {
    const g = buildTwoPoleGraph();
    const from = entranceFrom({ [g.poleA]: { x: 40, y: 50 } }, [g.poleA, g.poleB]);
    expect(from.get(g.poleA)).toEqual({ x: 40, y: 50 });
    expect(from.get(g.poleB)).toEqual({ x: 0, y: 0 });
  });
});

describe("beginLayout — whose answer is still wanted", () => {
  it("keeps the generation it handed out current until the next one starts", () => {
    const { generation } = beginLayout();
    expect(isCurrentLayout(generation)).toBe(true);
  });

  it("retires the previous generation the moment a newer layout begins", () => {
    const stale = beginLayout().generation;
    const fresh = beginLayout().generation;
    expect(isCurrentLayout(stale)).toBe(false);
    expect(isCurrentLayout(fresh)).toBe(true);
  });

  it("aborts the request the retired generation was waiting on", () => {
    const { signal } = beginLayout();
    expect(signal.aborted).toBe(false);
    beginLayout();
    expect(signal.aborted).toBe(true);
  });
});
