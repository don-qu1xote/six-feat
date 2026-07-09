// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/highlight.test.js — unit tests for buildDefaultColorCache/
//                                  invalidateColorCache (vis-adapter/highlight.js),
//                                  driven against a mock graph + DataSet stubs.
//                                  No real vis.Network/vis-network involved:
//                                  State.nodesDS/edgesDS are plain {update}
//                                  stubs and State.graphNodes/graphEdges are
//                                  hand-built mock graph data.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State, COLOR, DIM_LEVELS } from "../state/state.js";
import { seedShadow } from "./visuals.js";
import {
  buildDefaultColorCache,
  invalidateColorCache,
  applyDimState,
  resetHoverState,
  clearHoverHighlight,
} from "./highlight.js";

function mockDataSet() {
  return { update: vi.fn() };
}

beforeEach(() => {
  invalidateColorCache();
  resetHoverState();
  State.graphNodes = [
    { id: 1, isSeed: true },
    { id: 2, isSeed: false, _dimBorder: "#111111" },
  ];
  State.graphEdges = [{ id: "1_2", from: 1, to: 2, dominantRole: "featured" }];
  State.nodesDS = mockDataSet();
  State.edgesDS = mockDataSet();
  State.expandedNodes = new Set();
});

describe("buildDefaultColorCache + applyDimState('default')", () => {
  it("caches each node's default border/shadow and each edge's role color", () => {
    buildDefaultColorCache();
    applyDimState("default", {});

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const byId = Object.fromEntries(nodeUpdates.map(u => [u.id, u]));

    // Seed node: no explicit _dimBorder -> falls back to the muted-primary
    // rgba, and gets the seed glow.
    expect(byId[1].color.border).toBe("rgba(143,166,201,0.25)");
    expect(byId[1].shadow).toEqual(seedShadow());
    expect(byId[1].opacity).toBe(DIM_LEVELS.off);

    // Non-seed node: explicit _dimBorder used verbatim, no shadow.
    expect(byId[2].color.border).toBe("#111111");
    expect(byId[2].shadow).toEqual({ enabled: false });

    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates).toEqual([
      { id: "1_2", color: { color: COLOR.signal, opacity: 0.45 } },
    ]);
  });

  it("reuses the cached colors on a later default-apply even if the graph changed underneath it", () => {
    buildDefaultColorCache();

    // Mutate the graph without rebuilding the cache.
    State.graphNodes[1]._dimBorder = "#222222";

    applyDimState("default", {});
    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const node2 = nodeUpdates.find(u => u.id === 2);
    expect(node2.color.border).toBe("#111111"); // stale cached value, not "#222222"
  });
});

describe("invalidateColorCache", () => {
  it("forces the next default-apply to rebuild from current graph state", () => {
    buildDefaultColorCache();
    State.graphNodes[1]._dimBorder = "#222222";

    invalidateColorCache();
    applyDimState("default", {});

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const node2 = nodeUpdates.find(u => u.id === 2);
    expect(node2.color.border).toBe("#222222"); // rebuilt, reflects the change
  });

  it("is safe to call before any cache has ever been built", () => {
    expect(() => invalidateColorCache()).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Regression guard for the O(1) node/edge id-lookup + adjacency-index caches
// (_nodeById/_edgeById/_edgeIdsByNode) added to fix hover lag: hovering a node
// used to rescan the ENTIRE State.graphEdges array (State.graphEdges.find())
// once to find incident edges and again per incident edge, i.e. O(E + degree·E)
// work per hover instead of O(degree). The tests below don't assert on timing
// (flaky in CI) — they assert on the *correctness* of the new indexed lookups,
// which is exactly what a broken adjacency-index refactor (wrong e.from/e.to
// handling, or a cache not invalidated on graph mutation) would get wrong.
// ════════════════════════════════════════════════════════════════════════════
describe("applyDimState('hover') — adjacency-index edge highlighting", () => {
  beforeEach(() => {
    // Force the hover rAF debounce (see _applyHoverNode/_applyHoverNodeEdges
    // in highlight.js) to run synchronously so the update() calls it makes
    // are observable immediately, without a real animation-frame tick.
    vi.stubGlobal("requestAnimationFrame", cb => { cb(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("highlights only the edges actually incident to the hovered node, ignoring unrelated edges", () => {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
      { id: 3, isSeed: false, _dimBorder: "#222222" },
      { id: 4, isSeed: false, _dimBorder: "#333333" },
    ];
    // Node 2 is incident to "1_2" and "2_3" only — "3_4" must NOT light up.
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "2_3", from: 2, to: 3, dominantRole: "primary",  weight: 1 },
      { id: "3_4", from: 3, to: 4, dominantRole: "primary",  weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: id => ({ id, _brightColor: "#fff" }) };

    applyDimState("hover", { nodeId: 2 });

    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates.map(u => u.id).sort()).toEqual(["1_2", "2_3"]);
  });

  it("rebuilds the lookup caches after invalidateColorCache(), so a node/edge added since the last build is still hoverable", () => {
    buildDefaultColorCache(); // builds caches from the 2-node graph in the outer beforeEach

    // Simulate a graph mutation (e.g. expand merging in a new leaf) that adds
    // a node/edge unknown to the cache just built above.
    State.graphNodes.push({ id: 3, isSeed: false, _dimBorder: "#333333" });
    State.graphEdges.push({ id: "2_3", from: 2, to: 3, dominantRole: "primary", weight: 1 });
    State.edgesDS.get = id => ({ id, _brightColor: "#fff" });

    invalidateColorCache();
    applyDimState("hover", { nodeId: 3 });

    // A stale (non-invalidated) cache wouldn't know node 3 exists, so
    // _applyHoverNode would bail out early with no nodesDS.update() call at all.
    expect(State.nodesDS.update).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates.map(u => u.id)).toEqual(["2_3"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Regression guard: clearHoverHighlight(blurredNodeId) must ignore a STALE
// blur (one that no longer matches the currently-applied hover) instead of
// reverting whatever IS currently hovered. Reproduces the reported bug —
// "the highlighted node doesn't match the cursor" in dense areas of the
// graph — where a node's own blurNode can be delivered after a *different*
// node's hoverNode has already landed (vis.js only guarantees blur-before-
// hover ordering within a single mousemove; several distinct mousemoves can
// each fire their own blur/hover pair before the first one's rAF runs).
// ════════════════════════════════════════════════════════════════════════════
describe("clearHoverHighlight(blurredNodeId) — stale blur guard", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", cb => { cb(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not revert node B's highlight when a stale blur for the previously-hovered node A arrives after B was already applied", () => {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
      { id: 3, isSeed: false, _dimBorder: "#222222" },
    ];
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "1_3", from: 1, to: 3, dominantRole: "featured", weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: id => ({ id, _brightColor: "#fff" }) };

    // Cursor was on node 2 (A) — its hover already fully applied.
    applyDimState("hover", { nodeId: 2 });
    expect(State.nodesDS.update).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));

    // Cursor moved on to node 3 (B) — its hover applies too (both landed
    // within the same simulated frame, as they would in a dense cluster).
    State.nodesDS.update.mockClear();
    applyDimState("hover", { nodeId: 3 });
    expect(State.nodesDS.update).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));

    // A stale blurNode for node 2 (A) arrives after B's hover already
    // landed — it must NOT revert node 3's (B, current) highlight.
    State.nodesDS.update.mockClear();
    clearHoverHighlight(2);
    expect(State.nodesDS.update).not.toHaveBeenCalled();

    // The matching blur for the actually-current node (3) still works.
    clearHoverHighlight(3);
    expect(State.nodesDS.update).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
  });

  it("still clears unconditionally when called with no id (blurEdge / existing callers)", () => {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
    ];
    State.graphEdges = [{ id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 }];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: id => ({ id, _brightColor: "#fff" }) };

    applyDimState("hover", { nodeId: 2 });
    State.nodesDS.update.mockClear();

    clearHoverHighlight();
    expect(State.nodesDS.update).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });
});