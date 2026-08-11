import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { State } from "../state/state.js";
import { classifyGraph } from "./layout.js";
import {
  setEdgeCache,
  clearEdgeCache,
  drawEdges,
  _edgeCacheSize,
  suppressNativeEdgeColor,
  nearestEdgeAt,
} from "./edge-render.js";
import {
  selectEdge,
  clearSelectedEdge,
  resetHoverState,
  highlightEdgePair,
  selectNode,
  clearSelectedNode,
} from "./highlight.js";
import { COLOR } from "../state/state.js";

function mockCtx() {
  const calls = [];
  return {
    calls,
    save() {
      calls.push(["save"]);
    },
    restore() {
      calls.push(["restore"]);
    },
    beginPath() {
      calls.push(["beginPath"]);
    },
    moveTo(x, y) {
      calls.push(["moveTo", x, y]);
    },
    lineTo(x, y) {
      calls.push(["lineTo", x, y]);
    },
    quadraticCurveTo(cx, cy, x, y) {
      calls.push(["quadraticCurveTo", cx, cy, x, y]);
    },
    stroke() {
      calls.push(["stroke"]);
    },
    set strokeStyle(v) {
      calls.push(["strokeStyle", v]);
    },
    set lineWidth(v) {
      calls.push(["lineWidth", v]);
    },
    set globalAlpha(v) {
      calls.push(["globalAlpha", v]);
    },
  };
}

function segmentsDrawn(calls) {
  return calls.filter((c) => c[0] === "quadraticCurveTo" || c[0] === "lineTo").length;
}

function buildGraph({ seedId = 1, poleA = 2, poleB = 3 } = {}) {
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
    { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
    { id: `${seedId}_${poleB}`, from: seedId, to: poleB, weight: 1 },
    ...aLeaves.map((id) => ({ id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 })),
    ...bLeaves.map((id) => ({ id: `${poleB}_${id}`, from: poleB, to: id, weight: 1 })),
    { id: `${poleA}_${shared}`, from: poleA, to: shared, weight: 1 },
    { id: `${poleB}_${shared}`, from: poleB, to: shared, weight: 1 },
    { id: `${aLeaves[0]}_${aLeaves[1]}`, from: aLeaves[0], to: aLeaves[1], weight: 1 },
  ];
  State.currentSeedId = seedId;
  State.expandedNodes = new Set([poleA, poleB]);
  State.network = {};
  State.nodesDS = {};
  return { seedId, poleA, poleB, aLeaves, bLeaves, shared };
}

// [SF-API-21] Координаты приходят с сервера, и в браузерном тесте их взять
// неоткуда — да и незачем: файл про отрисовку рёбер, а ребру важно только
// то, где стоят его концы. Точки разведены так, чтобы кривые не совпадали.
function fakePositions(g) {
  const pos = new Map();
  pos.set(g.poleA, { x: -500, y: 0 });
  pos.set(g.poleB, { x: 500, y: 0 });
  g.aLeaves.forEach((id, i) => pos.set(id, { x: -500 + (i - 1) * 140, y: -260 }));
  g.bLeaves.forEach((id, i) => pos.set(id, { x: 500 + (i - 1) * 140, y: -260 }));
  pos.set(g.shared, { x: 0, y: 60 });
  return pos;
}

function mockNetworkWithPositions(targets) {
  const positions = {};
  for (const [id, p] of targets) positions[id] = { x: p.x, y: p.y };
  positions[State.currentSeedId] = { x: 0, y: 0 };
  return { getPositions: () => positions };
}

beforeEach(() => {
  State.graphNodes = [];
  State.graphEdges = [];
  State.currentSeedId = null;
  State.expandedNodes = new Set();
  State.network = null;
  State.nodesDS = null;
  State.pathHighlight = null;
  clearSelectedEdge();
  resetHoverState();
  clearEdgeCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("suppressNativeEdgeColor", () => {
  it("zeroes opacity and forces a transparent color at the base, hover, and highlight levels", () => {
    const input = {
      id: "1_2",
      from: 1,
      to: 2,
      width: 2,
      color: {
        color: "#5EE6C5",
        opacity: 0.4,
        inherit: false,
        hover: { color: "#7FFFD9", opacity: 0.9 },
        highlight: { color: "#7FFFD9", opacity: 1.0 },
      },
    };
    const out = suppressNativeEdgeColor(input);

    expect(out.color.opacity).toBe(0);
    expect(out.color.color).toBe("rgba(0,0,0,0)");
    expect(out.color.hover.opacity).toBe(0);
    expect(out.color.hover.color).toBe("rgba(0,0,0,0)");
    expect(out.color.highlight.opacity).toBe(0);
    expect(out.color.highlight.color).toBe("rgba(0,0,0,0)");
  });

  it("leaves every non-color, non-title field untouched", () => {
    const input = {
      id: "1_2",
      from: 1,
      to: 2,
      width: 3,
      title: "x",
      color: { color: "#fff", opacity: 1 },
    };
    const out = suppressNativeEdgeColor(input);
    expect(out.id).toBe("1_2");
    expect(out.from).toBe(1);
    expect(out.to).toBe(2);
    expect(out.width).toBe(3);
  });

  it("clears title — vis.js's own built-in tooltip for a suppressed edge is unreliable (see header comment)", () => {
    const input = {
      id: "1_2",
      from: 1,
      to: 2,
      width: 3,
      title: "x",
      color: { color: "#fff", opacity: 1 },
    };
    const out = suppressNativeEdgeColor(input);
    expect(out.title).toBeUndefined();
  });
});

describe("setEdgeCache / clearEdgeCache", () => {
  it("caches exactly one entry per classified edge", () => {
    buildGraph();
    const { edgeClass } = classifyGraph();
    setEdgeCache(edgeClass);
    expect(_edgeCacheSize()).toBe(State.graphEdges.length);
  });

  it("clearEdgeCache empties the cache", () => {
    buildGraph();
    const { edgeClass } = classifyGraph();
    setEdgeCache(edgeClass);
    expect(_edgeCacheSize()).toBeGreaterThan(0);
    clearEdgeCache();
    expect(_edgeCacheSize()).toBe(0);
  });
});

describe("nearestEdgeAt", () => {
  it("finds the edge whose drawn curve passes through the click point (a leaf endpoint with exactly one incident edge, always exactly on the curve regardless of bow)", () => {
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const leafPos = targets.get(g.aLeaves[2]);
    const hit = nearestEdgeAt(leafPos, 5);
    expect(hit).toBe(`${g.poleA}_${g.aLeaves[2]}`);
  });

  it("returns null when the click point is far from every cached edge", () => {
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const hit = nearestEdgeAt({ x: 1e6, y: 1e6 }, 5);
    expect(hit).toBeNull();
    void g;
  });

  it("returns null when the cache is empty (no layout drawn yet)", () => {
    buildGraph();
    State.network = mockNetworkWithPositions(new Map());
    expect(nearestEdgeAt({ x: 0, y: 0 }, 1000)).toBeNull();
  });
});

describe("drawEdges", () => {
  it("draws every single edge — nothing is hidden", () => {
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const ctx = mockCtx();
    drawEdges(ctx);

    expect(segmentsDrawn(ctx.calls)).toBe(State.graphEdges.length);
    void g;
  });

  it("batches same-style edges into a single stroke() call instead of one per edge", () => {
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const ctx = mockCtx();
    drawEdges(ctx);

    const strokeCalls = ctx.calls.filter((c) => c[0] === "stroke").length;
    const saveCalls = ctx.calls.filter((c) => c[0] === "save").length;
    expect(strokeCalls).toBe(1);
    expect(strokeCalls).toBeLessThan(State.graphEdges.length);
    expect(saveCalls).toBe(0);
  });

  it("still uses a separate stroke() call per distinct style (e.g. a hovered edge doesn't merge into the base-style batch)", () => {
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);
    State.edgesDS = { get: () => ({ _brightColor: "#fff", _color: "#000" }), update: () => {} };
    State.nodesDS = { get: () => null };
    selectEdge(`${g.poleA}_${g.aLeaves[0]}`);

    const ctx = mockCtx();
    drawEdges(ctx);

    const strokeCalls = ctx.calls.filter((c) => c[0] === "stroke").length;
    expect(strokeCalls).toBe(2);
  });

  it("draws a cross-sector edge as a curve whose control point is NOT the straight-line midpoint (bent toward its hub)", () => {
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const ctx = mockCtx();
    drawEdges(ctx);

    const crossId = `${g.aLeaves[0]}_${g.aLeaves[1]}`;
    const meta = edgeClass.get(crossId);
    expect(meta.kind).toBe("cross");

    const from = targets.get(g.aLeaves[0]),
      to = targets.get(g.aLeaves[1]);
    const mx = (from.x + to.x) / 2,
      my = (from.y + to.y) / 2;

    const call = ctx.calls.find(
      (c) =>
        c[0] === "quadraticCurveTo" && Math.abs(c[3] - to.x) < 1e-6 && Math.abs(c[4] - to.y) < 1e-6,
    );
    expect(call).toBeTruthy();
    const [, cx, cy] = call;
    expect(Math.hypot(cx - mx, cy - my)).toBeGreaterThan(1);
  });

  it("bounds the cross-sector bow by the edge's own chord length, even when the hub is very far away", () => {
    const from = 100,
      to = 101,
      farHub = 999;
    const edgeClass = new Map([[`${from}_${to}`, { from, to, kind: "cross", hub: farHub }]]);
    setEdgeCache(edgeClass);
    State.network = {
      getPositions: () => ({
        [from]: { x: 0, y: 0 },
        [to]: { x: 100, y: 0 },
        [farHub]: { x: 50, y: 50000 },
      }),
    };

    const ctx = mockCtx();
    drawEdges(ctx);

    const call = ctx.calls.find((c) => c[0] === "quadraticCurveTo");
    expect(call).toBeTruthy();
    const [, cx, cy] = call;
    const mx = 50,
      my = 0;
    const chordLen = 100;
    const bowMagnitude = Math.hypot(cx - mx, cy - my);
    expect(bowMagnitude).toBeLessThan(chordLen);
  });

  it("draws an intra-sector edge as a short curve (small bow off the midpoint, not a big arc)", () => {
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const ctx = mockCtx();
    drawEdges(ctx);

    const intraId = `${g.poleA}_${g.aLeaves[0]}`;
    expect(edgeClass.get(intraId).kind).toBe("intra");

    const from = targets.get(g.poleA),
      to = targets.get(g.aLeaves[0]);
    const mx = (from.x + to.x) / 2,
      my = (from.y + to.y) / 2;
    const segLen = Math.hypot(to.x - from.x, to.y - from.y);

    const call = ctx.calls.find(
      (c) =>
        c[0] === "quadraticCurveTo" && Math.abs(c[3] - to.x) < 1e-6 && Math.abs(c[4] - to.y) < 1e-6,
    );
    expect(call).toBeTruthy();
    const [, cx, cy] = call;
    const bow = Math.hypot(cx - mx, cy - my);
    expect(bow).toBeGreaterThan(0);
    expect(bow).toBeLessThan(segLen * 0.25);
  });

  it("still draws every edge as a curve (quadraticCurveTo), never degrading to straight lineTo, on a large graph", () => {
    const seedId = 1;
    const LARGE_EDGE_COUNT = 500;
    State.graphNodes = [{ id: seedId, isSeed: true }];
    State.graphEdges = [];
    const targets = new Map([[seedId, { x: 0, y: 0 }]]);
    const edgeClass = new Map();
    for (let i = 0; i < LARGE_EDGE_COUNT; i++) {
      const a = 1000 + i,
        b = 2000 + i;
      State.graphNodes.push({ id: a, isSeed: false }, { id: b, isSeed: false });
      const e = { id: `${a}_${b}`, from: a, to: b, weight: 1 };
      State.graphEdges.push(e);
      targets.set(a, { x: i, y: 0 });
      targets.set(b, { x: i, y: 10 });
      edgeClass.set(e.id, { from: a, to: b, kind: "cross", hub: null });
    }
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);
    State.currentSeedId = seedId;

    const ctx = mockCtx();
    drawEdges(ctx);

    const curveCalls = ctx.calls.filter((c) => c[0] === "quadraticCurveTo").length;
    const lineCalls = ctx.calls.filter((c) => c[0] === "lineTo").length;
    expect(curveCalls).toBe(LARGE_EDGE_COUNT);
    expect(lineCalls).toBe(0);
  });

  it("brightens (raises opacity/width) the selected edge and no other", () => {
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);
    State.nodesDS = { get: () => null };
    State.edgesDS = { get: () => ({ _brightColor: "#fff", _color: "#000" }), update: () => {} };

    const selectedId = `${g.poleA}_${g.aLeaves[0]}`;
    selectEdge(selectedId);
    expect(State.selectedEdgeId).toBe(selectedId);

    const ctx = mockCtx();
    drawEdges(ctx);

    const idx = ctx.calls.findIndex(
      (c) =>
        c[0] === "quadraticCurveTo" &&
        Math.abs(c[3] - targets.get(g.aLeaves[0]).x) < 1e-6 &&
        Math.abs(c[4] - targets.get(g.aLeaves[0]).y) < 1e-6,
    );
    expect(idx).toBeGreaterThan(-1);
    const alphaBefore = [...ctx.calls.slice(0, idx)].reverse().find((c) => c[0] === "globalAlpha");
    expect(alphaBefore[1]).toBe(1.0);
  });

  it("skips (does not crash on) edges whose endpoint has no live position", () => {
    buildGraph();
    const { edgeClass } = classifyGraph();
    setEdgeCache(edgeClass);
    State.network = { getPositions: () => ({}) };
    const ctx = mockCtx();
    expect(() => drawEdges(ctx)).not.toThrow();
    expect(segmentsDrawn(ctx.calls)).toBe(0);
  });

  it("no-ops with an empty cache", () => {
    State.network = { getPositions: () => ({}) };
    const ctx = mockCtx();
    drawEdges(ctx);
    expect(ctx.calls.length).toBe(0);
  });

  it("brightens the hovered edge (via the real highlight.js hover path) and no other", () => {
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      cb(0);
      return 1;
    });
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const hoveredId = `${g.poleB}_${g.bLeaves[0]}`;
    State.edgesDS = {
      get: (id) => (id === hoveredId ? { _brightColor: "#fff", _color: "#000" } : null),
      update: () => {},
    };
    State.nodesDS = { get: () => null };
    highlightEdgePair(hoveredId);
    const ctx = mockCtx();
    drawEdges(ctx);

    const to = targets.get(g.bLeaves[0]);
    const idx = ctx.calls.findIndex(
      (c) =>
        c[0] === "quadraticCurveTo" && Math.abs(c[3] - to.x) < 1e-6 && Math.abs(c[4] - to.y) < 1e-6,
    );
    expect(idx).toBeGreaterThan(-1);
    const alphaBefore = [...ctx.calls.slice(0, idx)].reverse().find((c) => c[0] === "globalAlpha");
    expect(alphaBefore[1]).toBe(0.85);

    const otherTo = targets.get(g.aLeaves[0]);
    const otherIdx = ctx.calls.findIndex(
      (c) =>
        c[0] === "quadraticCurveTo" &&
        Math.abs(c[3] - otherTo.x) < 1e-6 &&
        Math.abs(c[4] - otherTo.y) < 1e-6,
    );
    const otherAlpha = [...ctx.calls.slice(0, otherIdx)]
      .reverse()
      .find((c) => c[0] === "globalAlpha");
    expect(otherAlpha[1]).toBe(0.38);
  });
});

describe("drawEdges — unified selection color (SF-WEB-59)", () => {
  it("paints a directly-selected edge with COLOR.neon", () => {
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);
    State.edgesDS = { get: () => ({ _brightColor: "#fff", _color: "#000" }), update: () => {} };
    State.nodesDS = { get: () => null };
    selectEdge(`${g.poleA}_${g.aLeaves[0]}`);

    const ctx = mockCtx();
    drawEdges(ctx);
    const strokeColors = ctx.calls.filter((c) => c[0] === "strokeStyle").map((c) => c[1]);
    expect(strokeColors).toContain(COLOR.neon);
  });

  it("paints an edge incident to the currently-selected NODE with the same COLOR.neon", () => {
    const g = buildGraph();
    const { edgeClass } = classifyGraph();
    const targets = fakePositions(g);
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);
    State.edgesDS = { get: () => ({ _brightColor: "#fff", _color: "#000" }), update: () => {} };
    State.nodesDS = { get: () => null, update: () => {} };
    selectNode(g.poleA);
    const ctx = mockCtx();
    drawEdges(ctx);
    const strokeColors = ctx.calls.filter((c) => c[0] === "strokeStyle").map((c) => c[1]);
    expect(strokeColors).toContain(COLOR.neon);

    clearSelectedNode();
  });
});
