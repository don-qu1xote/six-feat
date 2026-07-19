// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/edge-render.test.js — [SF-WEB-55] custom edge-draw layer:
// setEdgeCache()/drawEdges() driven against a mock canvas 2D ctx (records
// calls instead of actually painting — no real <canvas> involved, same
// "record the call sequence" style physics.test.js's mockNetwork already
// uses for vis.Network) and State.network stubbed with just getPositions().
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { State } from "../state/state.js";
import { placeExpandedNodes } from "./layout.js";
import { setEdgeCache, clearEdgeCache, drawEdges, _edgeCacheSize, suppressNativeEdgeColor, nearestEdgeAt } from "./edge-render.js";
import { selectEdge, clearSelectedEdge, resetHoverState, highlightEdgePair, selectNode, clearSelectedNode } from "./highlight.js";
import { COLOR } from "../state/state.js";

function mockCtx() {
  const calls = [];
  return {
    calls,
    save()  { calls.push(["save"]); },
    restore() { calls.push(["restore"]); },
    beginPath() { calls.push(["beginPath"]); },
    moveTo(x, y) { calls.push(["moveTo", x, y]); },
    lineTo(x, y) { calls.push(["lineTo", x, y]); },
    quadraticCurveTo(cx, cy, x, y) { calls.push(["quadraticCurveTo", cx, cy, x, y]); },
    stroke() { calls.push(["stroke"]); },
    set strokeStyle(v) { calls.push(["strokeStyle", v]); },
    set lineWidth(v)   { calls.push(["lineWidth", v]); },
    set globalAlpha(v) { calls.push(["globalAlpha", v]); },
  };
}

function segmentsDrawn(calls) {
  return calls.filter(c => c[0] === "quadraticCurveTo" || c[0] === "lineTo").length;
}

function buildGraph({ seedId = 1, poleA = 2, poleB = 3 } = {}) {
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
    { id: `${seedId}_${poleA}`, from: seedId, to: poleA, weight: 1 },
    { id: `${seedId}_${poleB}`, from: seedId, to: poleB, weight: 1 },
    ...aLeaves.map(id => ({ id: `${poleA}_${id}`, from: poleA, to: id, weight: 1 })),
    ...bLeaves.map(id => ({ id: `${poleB}_${id}`, from: poleB, to: id, weight: 1 })),
    { id: `${poleA}_${shared}`, from: poleA, to: shared, weight: 1 },
    { id: `${poleB}_${shared}`, from: poleB, to: shared, weight: 1 },
    // Cross-sector "companion" edge between two exclusive leaves of the
    // SAME pole (not a tree/exclusive-ownership edge) — hub = that pole.
    { id: `${aLeaves[0]}_${aLeaves[1]}`, from: aLeaves[0], to: aLeaves[1], weight: 1 },
  ];
  State.currentSeedId = seedId;
  State.expandedNodes = new Set([poleA, poleB]);
  State.network = {};
  State.nodesDS = {};
  return { seedId, poleA, poleB, aLeaves, bLeaves, shared };
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

// [SF-WEB-56] suppressNativeEdgeColor — the original SF-WEB-55 version only
// zeroed color.opacity on the native edge, which highlight.js's own hover/
// selection color writes could still override back to visible (a SEPARATE,
// later edgesDS.update() with its own {color:{color,opacity:1}}), producing
// the "two edges" bug (native straight line + our arc, both visible)
// reported against the live app. This makes the base fill unambiguously
// invisible: opacity AND a fully-transparent color string, at all three
// levels (base/hover/highlight).
describe("suppressNativeEdgeColor", () => {
  it("zeroes opacity and forces a transparent color at the base, hover, and highlight levels", () => {
    const input = {
      id: "1_2", from: 1, to: 2, width: 2,
      color: {
        color: "#5EE6C5", opacity: 0.4, inherit: false,
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
    const input = { id: "1_2", from: 1, to: 2, width: 3, title: "x", color: { color: "#fff", opacity: 1 } };
    const out = suppressNativeEdgeColor(input);
    expect(out.id).toBe("1_2");
    expect(out.from).toBe(1);
    expect(out.to).toBe(2);
    expect(out.width).toBe(3);
  });

  // [SF-WEB-73] "подсветка не совпадает с тултипом" — vis.js's own
  // built-in (title-based) tooltip uses its OWN internal hit-test
  // (edges.smooth "continuous"), provably inconsistent with both the
  // curve actually drawn (edge-render.js) AND with the native hoverEdge
  // event's own params.edge on a dense hub (reproduced live — see this
  // function's header comment). A suppressed edge's title is cleared so
  // vis.js never shows its own (potentially wrong) tooltip for it —
  // events.js now shows its own, built from the same curve-aware hit test
  // that drives the hover highlight.
  it("clears title — vis.js's own built-in tooltip for a suppressed edge is unreliable (see header comment)", () => {
    const input = { id: "1_2", from: 1, to: 2, width: 3, title: "x", color: { color: "#fff", opacity: 1 } };
    const out = suppressNativeEdgeColor(input);
    expect(out.title).toBeUndefined();
  });
});

describe("setEdgeCache / clearEdgeCache", () => {
  it("caches exactly one entry per classified edge", () => {
    buildGraph();
    const { edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    expect(_edgeCacheSize()).toBe(State.graphEdges.length);
  });

  it("clearEdgeCache empties the cache", () => {
    buildGraph();
    const { edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    expect(_edgeCacheSize()).toBeGreaterThan(0);
    clearEdgeCache();
    expect(_edgeCacheSize()).toBe(0);
  });
});

// [SF-WEB-73] "подсветка не совпадает с тултипом" — found live on a dense
// hub: vis.js's native click hit-test (params.edges), its hoverEdge event,
// AND its own built-in title-tooltip each follow edges.smooth
// "continuous" — a DIFFERENT curve than the one this module actually draws
// (_curvePoint's hub-bowed quadratic for cross edges) — and, on a dense
// hub, they don't even agree WITH EACH OTHER, reproducibly, for the exact
// same cursor position. nearestEdgeAt tests a point against the SAME curve
// drawEdges() paints, so every consumer (click, hover, tooltip in
// events.js) gets one single, consistent answer.
describe("nearestEdgeAt", () => {
  it("finds the edge whose drawn curve passes through the click point (a leaf endpoint with exactly one incident edge, always exactly on the curve regardless of bow)", () => {
    const g = buildGraph();
    const { targets, edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    // aLeaves[2] has exactly one edge (poleA→aLeaves[2]) — unlike aLeaves[0]/
    // [1] (also share the companion cross-edge) or poleA/the seed
    // (many incident edges), so this click point is unambiguously on only
    // one curve.
    const leafPos = targets.get(g.aLeaves[2]);
    const hit = nearestEdgeAt(leafPos, 5);
    expect(hit).toBe(`${g.poleA}_${g.aLeaves[2]}`);
  });

  it("returns null when the click point is far from every cached edge", () => {
    const g = buildGraph();
    const { targets, edgeClass } = placeExpandedNodes({});
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
    const { targets, edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const ctx = mockCtx();
    drawEdges(ctx);

    expect(segmentsDrawn(ctx.calls)).toBe(State.graphEdges.length);
    void g;
  });

  // [SF-WEB-56 follow-up] Perf: the flyout animation calls drawEdges on
  // EVERY rendered frame (not once, unlike the layout computation) — on a
  // dense graph, one save()/beginPath()/stroke()/restore() per EDGE per
  // frame was measured as the dominant per-frame cost (stroke() is the
  // expensive part — real canvas rasterization). Same-style edges (same
  // color/opacity/width — the overwhelming majority at rest, since role
  // color is the only thing that varies edge-to-edge normally) now share a
  // single path and a single stroke() call.
  it("batches same-style edges into a single stroke() call instead of one per edge", () => {
    buildGraph();
    const { targets, edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const ctx = mockCtx();
    drawEdges(ctx);

    const strokeCalls = ctx.calls.filter(c => c[0] === "stroke").length;
    const saveCalls = ctx.calls.filter(c => c[0] === "save").length;
    // All edges in buildGraph() share the same (unhovered, unselected,
    // off-path) role color — one stroke() for all of them, not one each.
    expect(strokeCalls).toBe(1);
    expect(strokeCalls).toBeLessThan(State.graphEdges.length);
    // save()/restore() per edge is pure overhead now that style is set
    // once per group, not per edge — gone entirely.
    expect(saveCalls).toBe(0);
  });

  it("still uses a separate stroke() call per distinct style (e.g. a hovered edge doesn't merge into the base-style batch)", () => {
    const g = buildGraph();
    const { targets, edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);
    State.edgesDS = { get: () => ({ _brightColor: "#fff", _color: "#000" }), update: () => {} };
    State.nodesDS = { get: () => null };
    selectEdge(`${g.poleA}_${g.aLeaves[0]}`);

    const ctx = mockCtx();
    drawEdges(ctx);

    const strokeCalls = ctx.calls.filter(c => c[0] === "stroke").length;
    // Base-style group + the one selected edge's own (brighter) group.
    expect(strokeCalls).toBe(2);
  });

  it("draws a cross-sector edge as a curve whose control point is NOT the straight-line midpoint (bent toward its hub)", () => {
    const g = buildGraph();
    const { targets, edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const ctx = mockCtx();
    drawEdges(ctx);

    // The leafA0↔leafA1 "companion" edge is cross-sector (hub = poleA).
    const crossId = `${g.aLeaves[0]}_${g.aLeaves[1]}`;
    const meta = edgeClass.get(crossId);
    expect(meta.kind).toBe("cross");

    const from = targets.get(g.aLeaves[0]), to = targets.get(g.aLeaves[1]);
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;

    // Find the quadraticCurveTo call landing on this edge's endpoint.
    const call = ctx.calls.find(c =>
      c[0] === "quadraticCurveTo" && Math.abs(c[3] - to.x) < 1e-6 && Math.abs(c[4] - to.y) < 1e-6);
    expect(call).toBeTruthy();
    const [, cx, cy] = call;
    // Control point must be measurably off the straight-line midpoint —
    // proves it's a real arc, not a disguised straight line.
    expect(Math.hypot(cx - mx, cy - my)).toBeGreaterThan(1);
  });

  // [SF-WEB-56 follow-up] The first version pulled the control point by a
  // FRACTION OF THE DISTANCE TO THE HUB — on a dense graph the hub (often
  // the seed) can sit very far from a cross-sector edge's own chord, and
  // 35% of a huge distance put the control point way outside the chord's
  // own span: a quadratic curve with a control point that far off looks
  // like a sharp "V" (two nearly-straight segments meeting at the control
  // point) rather than a smooth arc — read by users as "two edges" for one
  // connection. The bow must now be bounded by the CHORD's own length,
  // regardless of how far away the hub actually is.
  it("bounds the cross-sector bow by the edge's own chord length, even when the hub is very far away", () => {
    const from = 100, to = 101, farHub = 999;
    const edgeClass = new Map([[`${from}_${to}`, { from, to, kind: "cross", hub: farHub }]]);
    setEdgeCache(edgeClass);
    State.network = {
      getPositions: () => ({
        [from]:   { x: 0, y: 0 },
        [to]:     { x: 100, y: 0 },
        [farHub]: { x: 50, y: 50000 },  // absurdly far off the chord
      }),
    };

    const ctx = mockCtx();
    drawEdges(ctx);

    const call = ctx.calls.find(c => c[0] === "quadraticCurveTo");
    expect(call).toBeTruthy();
    const [, cx, cy] = call;
    const mx = 50, my = 0;
    const chordLen = 100;
    const bowMagnitude = Math.hypot(cx - mx, cy - my);
    // Bounded by (a small multiple of) the chord length — NOT anywhere near
    // the 50000px hub distance a distance-fraction formula would produce.
    expect(bowMagnitude).toBeLessThan(chordLen);
  });

  it("draws an intra-sector edge as a short curve (small bow off the midpoint, not a big arc)", () => {
    const g = buildGraph();
    const { targets, edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const ctx = mockCtx();
    drawEdges(ctx);

    const intraId = `${g.poleA}_${g.aLeaves[0]}`;
    expect(edgeClass.get(intraId).kind).toBe("intra");

    const from = targets.get(g.poleA), to = targets.get(g.aLeaves[0]);
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    const segLen = Math.hypot(to.x - from.x, to.y - from.y);

    const call = ctx.calls.find(c =>
      c[0] === "quadraticCurveTo" && Math.abs(c[3] - to.x) < 1e-6 && Math.abs(c[4] - to.y) < 1e-6);
    expect(call).toBeTruthy();
    const [, cx, cy] = call;
    const bow = Math.hypot(cx - mx, cy - my);
    // Present (a real curve, not a straight lineTo)…
    expect(bow).toBeGreaterThan(0);
    // …but short relative to the segment — reads as a gentle curve, not a
    // pronounced arc like the cross-sector case above.
    expect(bow).toBeLessThan(segLen * 0.25);
  });

  // [SF-WEB-59] SF-WEB-55/56 used to degrade curves to straight lineTo past
  // a cache-size threshold ("cheap perf valve") — reported as a regression:
  // the abrupt style switch itself reads worse than the load it was meant
  // to offset, and the system should hold up under curves regardless of
  // graph size. Locks in that a LARGE graph still gets curves, not lines.
  it("still draws every edge as a curve (quadraticCurveTo), never degrading to straight lineTo, on a large graph", () => {
    const seedId = 1;
    const LARGE_EDGE_COUNT = 500;
    State.graphNodes = [{ id: seedId, isSeed: true }];
    State.graphEdges = [];
    const targets = new Map([[seedId, { x: 0, y: 0 }]]);
    const edgeClass = new Map();
    for (let i = 0; i < LARGE_EDGE_COUNT; i++) {
      const a = 1000 + i, b = 2000 + i;
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

    const curveCalls = ctx.calls.filter(c => c[0] === "quadraticCurveTo").length;
    const lineCalls  = ctx.calls.filter(c => c[0] === "lineTo").length;
    expect(curveCalls).toBe(LARGE_EDGE_COUNT);  // every edge still drawn, still curved
    expect(lineCalls).toBe(0);
  });

  it("brightens (raises opacity/width) the selected edge and no other", () => {
    const g = buildGraph();
    const { targets, edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);
    State.nodesDS = { get: () => null };
    State.edgesDS = { get: () => ({ _brightColor: "#fff", _color: "#000" }), update: () => {} };

    const selectedId = `${g.poleA}_${g.aLeaves[0]}`;
    selectEdge(selectedId);
    expect(State.selectedEdgeId).toBe(selectedId);

    const ctx = mockCtx();
    drawEdges(ctx);

    // Find the globalAlpha value set immediately before the stroke() that
    // lands on the selected edge's endpoint.
    const idx = ctx.calls.findIndex(c =>
      c[0] === "quadraticCurveTo" &&
      Math.abs(c[3] - targets.get(g.aLeaves[0]).x) < 1e-6 &&
      Math.abs(c[4] - targets.get(g.aLeaves[0]).y) < 1e-6);
    expect(idx).toBeGreaterThan(-1);
    const alphaBefore = [...ctx.calls.slice(0, idx)].reverse().find(c => c[0] === "globalAlpha");
    expect(alphaBefore[1]).toBe(1.0);
  });

  it("skips (does not crash on) edges whose endpoint has no live position", () => {
    buildGraph();
    const { edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = { getPositions: () => ({}) };  // nothing has a live position

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
    vi.stubGlobal("requestAnimationFrame", cb => { cb(0); return 1; });
    const g = buildGraph();
    const { targets, edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);

    const hoveredId = `${g.poleB}_${g.bLeaves[0]}`;
    State.edgesDS = { get: id => id === hoveredId ? { _brightColor: "#fff", _color: "#000" } : null, update: () => {} };
    State.nodesDS = { get: () => null };
    highlightEdgePair(hoveredId);  // applyDimState("edge", {edgeId}) — same entry point highlight.js's own callers use

    const ctx = mockCtx();
    drawEdges(ctx);

    const to = targets.get(g.bLeaves[0]);
    const idx = ctx.calls.findIndex(c =>
      c[0] === "quadraticCurveTo" && Math.abs(c[3] - to.x) < 1e-6 && Math.abs(c[4] - to.y) < 1e-6);
    expect(idx).toBeGreaterThan(-1);
    const alphaBefore = [...ctx.calls.slice(0, idx)].reverse().find(c => c[0] === "globalAlpha");
    expect(alphaBefore[1]).toBe(0.85);

    // A non-hovered edge stays at the plain base opacity.
    const otherTo = targets.get(g.aLeaves[0]);
    const otherIdx = ctx.calls.findIndex(c =>
      c[0] === "quadraticCurveTo" && Math.abs(c[3] - otherTo.x) < 1e-6 && Math.abs(c[4] - otherTo.y) < 1e-6);
    const otherAlpha = [...ctx.calls.slice(0, otherIdx)].reverse().find(c => c[0] === "globalAlpha");
    expect(otherAlpha[1]).toBe(0.38);
  });
});

// [SF-WEB-59] Selection color must be the SAME (COLOR.neon) regardless of
// whether the user clicked the edge directly or clicked a node it's
// incident to — previously a directly-selected edge got a lightened role
// hue while a node-selected edge (via the native DataSet, invisible for any
// edge our canvas layer owns) got no distinct color from drawEdges at all.
describe("drawEdges — unified selection color (SF-WEB-59)", () => {
  it("paints a directly-selected edge with COLOR.neon", () => {
    const g = buildGraph();
    const { targets, edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);
    State.edgesDS = { get: () => ({ _brightColor: "#fff", _color: "#000" }), update: () => {} };
    State.nodesDS = { get: () => null };
    selectEdge(`${g.poleA}_${g.aLeaves[0]}`);

    const ctx = mockCtx();
    drawEdges(ctx);
    const strokeColors = ctx.calls.filter(c => c[0] === "strokeStyle").map(c => c[1]);
    expect(strokeColors).toContain(COLOR.neon);
  });

  it("paints an edge incident to the currently-selected NODE with the same COLOR.neon", () => {
    const g = buildGraph();
    const { targets, edgeClass } = placeExpandedNodes({});
    setEdgeCache(edgeClass);
    State.network = mockNetworkWithPositions(targets);
    State.edgesDS = { get: () => ({ _brightColor: "#fff", _color: "#000" }), update: () => {} };
    State.nodesDS = { get: () => null, update: () => {} };
    selectNode(g.poleA);  // poleA↔aLeaves[0] is one of poleA's incident edges

    const ctx = mockCtx();
    drawEdges(ctx);
    const strokeColors = ctx.calls.filter(c => c[0] === "strokeStyle").map(c => c[1]);
    expect(strokeColors).toContain(COLOR.neon);

    clearSelectedNode();
  });
});

