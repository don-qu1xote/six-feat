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
  selectNode,
  clearSelectedNode,
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
  State.selectedNodeId = null;
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
// SF-WEB-07: hover is rAF-debounced — rapid repeated hoverNode/hoverEdge
// dispatches (vis.js can fire several per animation frame while the mouse
// moves across a dense cluster) must collapse into a SINGLE DataSet.update()
// per frame, not one per event. Unlike the tests above, this block does NOT
// auto-flush requestAnimationFrame — it queues callbacks so the test can
// dispatch several hover events, assert nothing has painted yet, then flush
// exactly once and count the resulting update() calls.
// ════════════════════════════════════════════════════════════════════════════
describe("SF-WEB-07: hover rAF debounce — no redundant recompute per frame", () => {
  // Real cancelAnimationFrame semantics matter here (unlike the
  // always-synchronous stub other describe blocks in this file use):
  // _applyHoverNode cancels-and-reschedules on every call, so a fake that
  // doesn't actually deregister the cancelled callback would still fire it
  // on flush and defeat the very coalescing this block is testing.
  let rafQueue, nextRafId;

  beforeEach(() => {
    rafQueue = new Map();
    nextRafId = 1;
    vi.stubGlobal("requestAnimationFrame", cb => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", id => { rafQueue.delete(id); });

    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111", _accent: "#8FA6C9" },
      { id: 3, isSeed: false, _dimBorder: "#222222", _accent: "#8FA6C9" },
    ];
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "2_3", from: 2, to: 3, dominantRole: "primary",  weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: id => ({ id, _brightColor: "#fff" }) };
    State.network = {}; // _applyHoverEdge requires a truthy State.network
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushOneFrame() {
    const due = [...rafQueue.values()];
    rafQueue.clear();
    due.forEach(cb => cb(0));
  }

  it("collapses several hoverNode dispatches on the same node into one nodesDS.update() call", () => {
    applyDimState("hover", { nodeId: 2 });
    applyDimState("hover", { nodeId: 2 });
    applyDimState("hover", { nodeId: 2 });

    expect(State.nodesDS.update).not.toHaveBeenCalled(); // nothing painted before the frame runs
    flushOneFrame();

    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);
  });

  it("collapses rapid hoverNode dispatches on DIFFERENT nodes within the same frame into one update() — only the latest wins", () => {
    applyDimState("hover", { nodeId: 2 });
    applyDimState("hover", { nodeId: 3 }); // cursor moved to a neighbour before the frame ran

    flushOneFrame();

    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);
    expect(State.nodesDS.update).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
  });

  it("batches multiple hoverEdge dispatches within the same frame into a single edgesDS.update() call", () => {
    applyDimState("edge", { edgeId: "1_2" });
    applyDimState("edge", { edgeId: "2_3" });

    expect(State.edgesDS.update).not.toHaveBeenCalled();
    flushOneFrame();

    expect(State.edgesDS.update).toHaveBeenCalledTimes(1);
    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates.map(u => u.id).sort()).toEqual(["1_2", "2_3"]);
  });

  it("hovering a node incidentally batches its edges into the SAME frame as the node paint, not an extra one", () => {
    applyDimState("hover", { nodeId: 2 }); // paints node 2 + edges 1_2/2_3 in one rAF callback

    flushOneFrame();

    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);
    expect(State.edgesDS.update).toHaveBeenCalledTimes(1);
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

// ════════════════════════════════════════════════════════════════════════════
// SF-WEB-15: selectNode/clearSelectedNode — persistent single-node selection.
// Regression guard for "clicking different nodes accumulates highlighting":
// exactly one node (+ its incident edges) must carry the selection marker at
// a time — mirroring hover-neighborhood's node+edges reach, but persistent
// and painted in the marker's own neon accent — and clicking background
// (clearSelectedNode) must return the graph to no selection at all.
// ════════════════════════════════════════════════════════════════════════════
describe("selectNode/clearSelectedNode — persistent single-node selection", () => {
  function graphWithChain() {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
      { id: 3, isSeed: false, _dimBorder: "#222222" },
      { id: 4, isSeed: false, _dimBorder: "#333333" },
    ];
    // Chain 1-2-3-4: node 2's edges are "1_2"/"2_3", node 3's are "2_3"/"3_4".
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "2_3", from: 2, to: 3, dominantRole: "primary",  weight: 1 },
      { id: "3_4", from: 3, to: 4, dominantRole: "primary",  weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: id => ({ id, _brightColor: "#fff" }) };
  }

  it("selecting a node also highlights its incident edges in the same neon accent as the node border", () => {
    graphWithChain();

    selectNode(2); // click A

    const nodeUpd = State.nodesDS.update.mock.calls.find(c => c[0].id === 2)[0];
    expect(nodeUpd.color.border).toBe(COLOR.neon);

    const [edgeUpd] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpd.map(u => u.id).sort()).toEqual(["1_2", "2_3"]); // only A's own edges
    expect(edgeUpd.every(u => u.color.color === COLOR.neon)).toBe(true);
  });

  it("clicking node A then node B leaves exactly B (+ its edges) selected — no accumulation", () => {
    graphWithChain();

    selectNode(2); // click A
    expect(State.selectedNodeId).toBe(2);

    State.nodesDS.update.mockClear();
    State.edgesDS.update.mockClear();
    selectNode(3); // click B

    expect(State.selectedNodeId).toBe(3);

    // Node: A reverted to its default border, B marked selected — never both.
    const nodeCalls = State.nodesDS.update.mock.calls.map(c => c[0]);
    const revertA = nodeCalls.find(u => u.id === 2);
    const markB   = nodeCalls.find(u => u.id === 3);
    expect(revertA.color.border).toBe("#111111");
    expect(markB.color.border).toBe(COLOR.neon);

    // Edges: "1_2" (only A's) reverted to default; "2_3" (shared) and "3_4"
    // (only B's) end up marked — last write per id is the final canvas state.
    const edgeUpdates = {};
    for (const [batch] of State.edgesDS.update.mock.calls) {
      for (const u of batch) edgeUpdates[u.id] = u;
    }
    expect(edgeUpdates["1_2"].color.color).not.toBe(COLOR.neon);
    expect(edgeUpdates["2_3"].color.color).toBe(COLOR.neon);
    expect(edgeUpdates["3_4"].color.color).toBe(COLOR.neon);
  });

  it("clicking the background (clearSelectedNode) removes both the node marker and its edge highlights", () => {
    graphWithChain();

    selectNode(2);
    State.nodesDS.update.mockClear();
    State.edgesDS.update.mockClear();

    clearSelectedNode();

    expect(State.selectedNodeId).toBe(null);
    const [nodeUpd] = State.nodesDS.update.mock.calls[0];
    expect(nodeUpd).toMatchObject({ id: 2, color: { border: "#111111" } });

    const [edgeUpd] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpd.map(u => u.id).sort()).toEqual(["1_2", "2_3"]);
    expect(edgeUpd.every(u => u.color.color !== COLOR.neon)).toBe(true);
  });

  it("clearSelectedNode is a no-op when nothing is selected", () => {
    clearSelectedNode();
    expect(State.selectedNodeId).toBe(null);
    expect(State.nodesDS.update).not.toHaveBeenCalled();
  });
});