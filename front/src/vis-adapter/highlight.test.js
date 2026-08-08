import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State, COLOR, DIM_LEVELS, PATH_HIGHLIGHT_LEVELS } from "../state/state.js";
import { seedShadow, nodeShadowFor } from "./visuals.js";
import {
  buildDefaultColorCache,
  invalidateColorCache,
  applyDimState,
  resetHoverState,
  clearHoverHighlight,
  selectNode,
  clearSelectedNode,
  selectEdge,
  clearSelectedEdge,
  highlightEdgePair,
  highlightPath,
  recolorInPlace,
  markCompareEndpoint,
  clearCompareEndpoints,
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
  State.selectedEdgeId = null;
});

describe("buildDefaultColorCache + applyDimState('default')", () => {
  it("caches each node's default border/shadow and each edge's role color", () => {
    buildDefaultColorCache();
    applyDimState("default", {});

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const byId = Object.fromEntries(nodeUpdates.map((u) => [u.id, u]));

    expect(byId[1].color.border).toBe("rgba(143,166,201,0.25)");
    expect(byId[1].shadow).toEqual(seedShadow());
    expect(byId[1].opacity).toBe(DIM_LEVELS.off);

    expect(byId[2].color.border).toBe("#111111");
    expect(byId[2].shadow).toEqual(nodeShadowFor(State.graphNodes[1]));
    expect(byId[2].shadow.enabled).toBe(true);

    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates).toEqual([{ id: "1_2", color: { color: COLOR.signal, opacity: 0.45 } }]);
  });

  it("reuses the cached colors on a later default-apply even if the graph changed underneath it", () => {
    buildDefaultColorCache();

    State.graphNodes[1]._dimBorder = "#222222";

    applyDimState("default", {});
    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const node2 = nodeUpdates.find((u) => u.id === 2);
    expect(node2.color.border).toBe("#111111");
  });
});

describe("invalidateColorCache", () => {
  it("forces the next default-apply to rebuild from current graph state", () => {
    buildDefaultColorCache();
    State.graphNodes[1]._dimBorder = "#222222";

    invalidateColorCache();
    applyDimState("default", {});

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const node2 = nodeUpdates.find((u) => u.id === 2);
    expect(node2.color.border).toBe("#222222");
  });

  it("is safe to call before any cache has ever been built", () => {
    expect(() => invalidateColorCache()).not.toThrow();
  });
});

describe("applyDimState('hover') — adjacency-index edge highlighting", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      cb(0);
      return 1;
    });
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
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "2_3", from: 2, to: 3, dominantRole: "primary", weight: 1 },
      { id: "3_4", from: 3, to: 4, dominantRole: "primary", weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: (id) => ({ id, _brightColor: "#fff" }) };

    applyDimState("hover", { nodeId: 2 });

    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates.map((u) => u.id).sort()).toEqual(["1_2", "2_3"]);
  });

  it("rebuilds the lookup caches after invalidateColorCache(), so a node/edge added since the last build is still hoverable", () => {
    buildDefaultColorCache();
    State.graphNodes.push({ id: 3, isSeed: false, _dimBorder: "#333333" });
    State.graphEdges.push({ id: "2_3", from: 2, to: 3, dominantRole: "primary", weight: 1 });
    State.edgesDS.get = (id) => ({ id, _brightColor: "#fff" });

    invalidateColorCache();
    applyDimState("hover", { nodeId: 3 });

    expect(State.nodesDS.update).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 3 })]),
    );
    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates.map((u) => u.id)).toEqual(["2_3"]);
  });
});

describe("SF-WEB-07: hover rAF debounce — no redundant recompute per frame", () => {
  let rafQueue, nextRafId;

  beforeEach(() => {
    rafQueue = new Map();
    nextRafId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id) => {
      rafQueue.delete(id);
    });

    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111", _accent: "#8FA6C9" },
      { id: 3, isSeed: false, _dimBorder: "#222222", _accent: "#8FA6C9" },
    ];
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "2_3", from: 2, to: 3, dominantRole: "primary", weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: (id) => ({ id, _brightColor: "#fff" }) };
    State.network = {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushOneFrame() {
    const due = [...rafQueue.values()];
    rafQueue.clear();
    due.forEach((cb) => cb(0));
  }

  it("collapses several hoverNode dispatches on the same node into one nodesDS.update() call", () => {
    applyDimState("hover", { nodeId: 2 });
    applyDimState("hover", { nodeId: 2 });
    applyDimState("hover", { nodeId: 2 });

    expect(State.nodesDS.update).not.toHaveBeenCalled();
    flushOneFrame();

    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);
  });

  it("collapses rapid hoverNode dispatches on DIFFERENT nodes within the same frame into one update() — only the latest wins", () => {
    applyDimState("hover", { nodeId: 2 });
    applyDimState("hover", { nodeId: 3 });
    flushOneFrame();

    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);
    expect(State.nodesDS.update).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 3 })]),
    );
  });

  it("batches multiple hoverEdge dispatches within the same frame into a single edgesDS.update() call", () => {
    applyDimState("edge", { edgeId: "1_2" });
    applyDimState("edge", { edgeId: "2_3" });

    expect(State.edgesDS.update).not.toHaveBeenCalled();
    flushOneFrame();

    expect(State.edgesDS.update).toHaveBeenCalledTimes(1);
    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates.map((u) => u.id).sort()).toEqual(["1_2", "2_3"]);
  });

  it("hovering a node incidentally batches its edges into the SAME frame as the node paint, not an extra one", () => {
    applyDimState("hover", { nodeId: 2 });
    flushOneFrame();

    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);
    expect(State.edgesDS.update).toHaveBeenCalledTimes(1);
  });
});

describe("SF-WEB-34: blur/hover coalesce through one rAF tick in dense clusters", () => {
  let rafQueue, nextRafId;

  beforeEach(() => {
    rafQueue = new Map();
    nextRafId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id) => {
      rafQueue.delete(id);
    });

    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111", _accent: "#8FA6C9" },
      { id: 3, isSeed: false, _dimBorder: "#222222", _accent: "#8FA6C9" },
      { id: 4, isSeed: false, _dimBorder: "#333333", _accent: "#8FA6C9" },
    ];
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "1_3", from: 1, to: 3, dominantRole: "featured", weight: 1 },
      { id: "1_4", from: 1, to: 4, dominantRole: "featured", weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: (id) => ({ id, _brightColor: "#fff" }) };
    State.network = {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function flushOneFrame() {
    const due = [...rafQueue.values()];
    rafQueue.clear();
    due.forEach((cb) => cb(0));
  }

  it("blur(A),hover(B),blur(B),hover(C) inside one tick leaves exactly C highlighted, with one recompute for the one rAF tick", () => {
    applyDimState("hover", { nodeId: 2 });
    flushOneFrame();
    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);
    State.nodesDS.update.mockClear();
    State.edgesDS.update.mockClear();

    clearHoverHighlight(2);
    applyDimState("hover", { nodeId: 3 });
    clearHoverHighlight(3);
    applyDimState("hover", { nodeId: 4 });
    expect(State.nodesDS.update).not.toHaveBeenCalled();

    flushOneFrame();

    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const byId = Object.fromEntries(nodeUpdates.map((u) => [u.id, u]));

    expect(byId[2]).toBeDefined();
    expect(byId[2].borderWidth).toBe(2);
    expect(byId[3]).toBeUndefined();
    expect(byId[4]).toBeDefined();
    expect(byId[4].borderWidth).toBe(3);
  });
});

describe("clearHoverHighlight(blurredNodeId) — stale blur guard", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      cb(0);
      return 1;
    });
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
    State.edgesDS = { update: vi.fn(), get: (id) => ({ id, _brightColor: "#fff" }) };

    applyDimState("hover", { nodeId: 2 });
    expect(State.nodesDS.update).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 2 })]),
    );

    State.nodesDS.update.mockClear();
    applyDimState("hover", { nodeId: 3 });
    expect(State.nodesDS.update).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 3 })]),
    );

    State.nodesDS.update.mockClear();
    clearHoverHighlight(2);
    expect(State.nodesDS.update).not.toHaveBeenCalled();

    clearHoverHighlight(3);
    expect(State.nodesDS.update).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 3 })]),
    );
  });

  it("still clears unconditionally when called with no id (blurEdge / existing callers)", () => {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
    ];
    State.graphEdges = [{ id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 }];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: (id) => ({ id, _brightColor: "#fff" }) };

    applyDimState("hover", { nodeId: 2 });
    State.nodesDS.update.mockClear();

    clearHoverHighlight();
    expect(State.nodesDS.update).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 2 })]),
    );
  });
});

describe("[SF-WEB-61] hover-revert borderWidth matches nodeVisual's for expanded (non-seed) hubs", () => {
  it("reverts an expanded, non-seed node to the SAME borderWidth nodeVisual gives it on first render", () => {
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
    ];
    State.graphEdges = [{ id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 }];
    State.expandedNodes = new Set([2]);
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: (id) => ({ id, _brightColor: "#fff" }) };

    applyDimState("hover", { nodeId: 2 });
    State.nodesDS.update.mockClear();
    clearHoverHighlight(2);

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const upd = nodeUpdates.find((u) => u.id === 2);
    expect(upd.borderWidth).toBe(5);
    vi.unstubAllGlobals();
  });
});

describe("selectNode/clearSelectedNode — persistent single-node selection", () => {
  function graphWithChain() {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
      { id: 3, isSeed: false, _dimBorder: "#222222" },
      { id: 4, isSeed: false, _dimBorder: "#333333" },
    ];
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "2_3", from: 2, to: 3, dominantRole: "primary", weight: 1 },
      { id: "3_4", from: 3, to: 4, dominantRole: "primary", weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: (id) => ({ id, _brightColor: "#fff" }) };
  }

  it("selecting a node also highlights its incident edges in the same neon accent as the node border", () => {
    graphWithChain();

    selectNode(2);
    const nodeUpd = State.nodesDS.update.mock.calls.find((c) => c[0].id === 2)[0];
    expect(nodeUpd.color.border).toBe(COLOR.neon);

    const [edgeUpd] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpd.map((u) => u.id).sort()).toEqual(["1_2", "2_3"]);
    expect(edgeUpd.every((u) => u.color.color === COLOR.neon)).toBe(true);
  });

  it("clicking node A then node B leaves exactly B (+ its edges) selected — no accumulation", () => {
    graphWithChain();

    selectNode(2);
    expect(State.selectedNodeId).toBe(2);

    State.nodesDS.update.mockClear();
    State.edgesDS.update.mockClear();
    selectNode(3);
    expect(State.selectedNodeId).toBe(3);

    const nodeCalls = State.nodesDS.update.mock.calls.map((c) => c[0]);
    const revertA = nodeCalls.find((u) => u.id === 2);
    const markB = nodeCalls.find((u) => u.id === 3);
    expect(revertA.color.border).toBe("#111111");
    expect(markB.color.border).toBe(COLOR.neon);

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
    expect(edgeUpd.map((u) => u.id).sort()).toEqual(["1_2", "2_3"]);
    expect(edgeUpd.every((u) => u.color.color !== COLOR.neon)).toBe(true);
  });

  it("clearSelectedNode is a no-op when nothing is selected", () => {
    clearSelectedNode();
    expect(State.selectedNodeId).toBe(null);
    expect(State.nodesDS.update).not.toHaveBeenCalled();
  });
});

describe("[SF-WEB-28] selectNode/selectEdge mutual exclusion", () => {
  function graphWithChain() {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
      { id: 3, isSeed: false, _dimBorder: "#222222" },
      { id: 4, isSeed: false, _dimBorder: "#333333" },
    ];
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "2_3", from: 2, to: 3, dominantRole: "primary", weight: 1 },
      { id: "3_4", from: 3, to: 4, dominantRole: "primary", weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = { update: vi.fn(), get: (id) => ({ id, _brightColor: "#fff" }) };
  }

  it("selecting a node clears a previously selected edge", () => {
    graphWithChain();

    selectEdge("3_4");
    expect(State.selectedEdgeId).toBe("3_4");

    selectNode(2);

    expect(State.selectedNodeId).toBe(2);
    expect(State.selectedEdgeId).toBe(null);
  });

  it("selecting an edge clears a previously selected node", () => {
    graphWithChain();

    selectNode(2);
    expect(State.selectedNodeId).toBe(2);

    selectEdge("3_4");

    expect(State.selectedEdgeId).toBe("3_4");
    expect(State.selectedNodeId).toBe(null);
  });

  it("node -> edge -> node leaves exactly one marker set at every step, never both", () => {
    graphWithChain();

    selectNode(2);
    expect(State.selectedNodeId).toBe(2);
    expect(State.selectedEdgeId).toBe(null);

    selectEdge("1_2");
    expect(State.selectedNodeId).toBe(null);
    expect(State.selectedEdgeId).toBe("1_2");

    selectNode(4);
    expect(State.selectedNodeId).toBe(4);
    expect(State.selectedEdgeId).toBe(null);
  });

  it("clearing both markers (background click) leaves neither set, regardless of which was active", () => {
    graphWithChain();

    selectEdge("2_3");
    clearSelectedNode();
    clearSelectedEdge();
    expect(State.selectedNodeId).toBe(null);
    expect(State.selectedEdgeId).toBe(null);

    selectNode(3);
    clearSelectedEdge();
    clearSelectedNode();
    expect(State.selectedNodeId).toBe(null);
    expect(State.selectedEdgeId).toBe(null);
  });

  it("selecting a node visually reverts the previously selected edge to its default color", () => {
    graphWithChain();

    selectEdge("3_4");
    State.edgesDS.update.mockClear();

    selectNode(2);

    const revertCall = State.edgesDS.update.mock.calls.find(
      ([arg]) => !Array.isArray(arg) && arg.id === "3_4",
    );
    expect(revertCall).toBeTruthy();
    expect(revertCall[0].color.color).not.toBe(COLOR.neon);
  });

  it("selecting an edge visually reverts the previously selected node to its default border", () => {
    graphWithChain();

    selectNode(4);
    State.nodesDS.update.mockClear();

    selectEdge("1_2");

    const nodeUpdates = State.nodesDS.update.mock.calls.map((c) => c[0]);
    const revertedNode4 = nodeUpdates.find((u) => u.id === 4);
    expect(revertedNode4.color.border).toBe("#333333");
  });
});

describe("highlightPath — dim option (SF-WEB-61)", () => {
  function graphWithOffPathNode() {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
      { id: 3, isSeed: false, _dimBorder: "#222222" },
    ];
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "1_3", from: 1, to: 3, dominantRole: "producer", weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = { update: vi.fn(), getIds: () => [1, 2, 3] };
    State.edgesDS = { update: vi.fn(), getIds: () => ["1_2", "1_3"] };
  }

  it("dims the off-path node down to neverTouched by default (regular path finder, unchanged)", () => {
    graphWithOffPathNode();
    highlightPath([1, 2]);

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const off = nodeUpdates.find((u) => u.id === 3);
    expect(off.opacity).toBe(PATH_HIGHLIGHT_LEVELS.neverTouched.opacity);

    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    const offEdge = edgeUpdates.find((u) => u.id === "1_3");
    expect(offEdge.color.opacity).toBe(PATH_HIGHLIGHT_LEVELS.neverTouched.edgeOpacity);
  });

  it("leaves the off-path node at full resting opacity with dim:false (Compare mode)", () => {
    graphWithOffPathNode();
    highlightPath([1, 2], { dim: false });

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const off = nodeUpdates.find((u) => u.id === 3);
    expect(off.opacity).toBe(1);
    expect(off.color.border).toBe("#222222");
    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    const offEdge = edgeUpdates.find((u) => u.id === "1_3");
    expect(offEdge.color.opacity).toBeGreaterThan(PATH_HIGHLIGHT_LEVELS.neverTouched.edgeOpacity);
  });

  it("still highlights every path node AND both endpoints brightly with dim:false", () => {
    graphWithOffPathNode();
    highlightPath([1, 2], { dim: false });

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const seed = nodeUpdates.find((u) => u.id === 1);
    const end = nodeUpdates.find((u) => u.id === 2);
    expect(seed.opacity).toBe(1);
    expect(seed.color.border).toBe(COLOR.neon);
    expect(end.opacity).toBe(1);
    expect(end.color.border).toBe(COLOR.neon);
  });
});

describe("[SF-WEB-56 follow-up] suppressed (canvas-drawn) edges stay invisible through every recolor path", () => {
  function graphWithSuppressedEdge() {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
    ];
    State.graphEdges = [{ id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 }];
    invalidateColorCache();
    State.nodesDS = mockDataSet();
    State.edgesDS = {
      update: vi.fn(),
      get: (id) => ({ id, _brightColor: "#fff", _color: "#000" }),
    };
    State.selectedNodeId = null;
    State.selectedEdgeId = null;
    State.suppressedEdgeIds = new Set(["1_2"]);
  }

  afterEach(() => {
    State.suppressedEdgeIds = undefined;
  });

  it("stays invisible on hover (highlightEdgePair)", () => {
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      cb(0);
      return 1;
    });
    graphWithSuppressedEdge();

    highlightEdgePair("1_2");

    const call = State.edgesDS.update.mock.calls.flatMap((c) => c[0]).find((u) => u.id === "1_2");
    expect(call).toBeTruthy();
    expect(call.color.opacity).toBe(0);
    vi.unstubAllGlobals();
  });

  it("stays invisible when persistently selected (selectEdge)", () => {
    graphWithSuppressedEdge();

    selectEdge("1_2");

    const call = State.edgesDS.update.mock.calls.find(
      ([arg]) => !Array.isArray(arg) && arg.id === "1_2",
    );
    expect(call).toBeTruthy();
    expect(call[0].color.opacity).toBe(0);
  });

  it("stays invisible when reverted to default (clearSelectedEdge)", () => {
    graphWithSuppressedEdge();
    selectEdge("1_2");
    State.edgesDS.update.mockClear();

    clearSelectedEdge();

    const call = State.edgesDS.update.mock.calls.find(
      ([arg]) => !Array.isArray(arg) && arg.id === "1_2",
    );
    expect(call).toBeTruthy();
    expect(call[0].color.opacity).toBe(0);
  });

  it("stays invisible when lit up as a selected node's incident edge (selectNode)", () => {
    graphWithSuppressedEdge();

    selectNode(2);

    const call = State.edgesDS.update.mock.calls.flatMap((c) => c[0]).find((u) => u.id === "1_2");
    expect(call).toBeTruthy();
    expect(call.color.opacity).toBe(0);
  });

  it("stays invisible in a full default-state batch reset (applyDimState('default'))", () => {
    graphWithSuppressedEdge();
    buildDefaultColorCache();

    applyDimState("default", {});

    const call = State.edgesDS.update.mock.calls.flatMap((c) => c[0]).find((u) => u.id === "1_2");
    expect(call).toBeTruthy();
    expect(call.color.opacity).toBe(0);
  });

  it("stays invisible in path highlighting, even for the onPath edge itself", () => {
    graphWithSuppressedEdge();
    State.nodesDS = { update: vi.fn(), getIds: () => [1, 2] };
    State.edgesDS = { update: vi.fn(), getIds: () => ["1_2"] };

    applyDimState("path", { path: [1, 2] });

    const call = State.edgesDS.update.mock.calls.flatMap((c) => c[0]).find((u) => u.id === "1_2");
    expect(call).toBeTruthy();
    expect(call.color.opacity).toBe(0);
  });

  it("stays invisible after a theme recolor (recolorInPlace)", () => {
    graphWithSuppressedEdge();

    recolorInPlace({});

    const call = State.edgesDS.update.mock.calls.flatMap((c) => c[0]).find((u) => u.id === "1_2");
    expect(call).toBeTruthy();
    expect(call.color.opacity).toBe(0);
    expect(call._color).toBeTruthy();
    expect(call._brightColor).toBeTruthy();
  });

  it("a NON-suppressed edge in the same graph is unaffected (still gets its normal visible color)", () => {
    graphWithSuppressedEdge();
    State.graphEdges.push({ id: "2_3", from: 2, to: 3, dominantRole: "primary", weight: 1 });
    State.graphNodes.push({ id: 3, isSeed: false });
    invalidateColorCache();
    State.suppressedEdgeIds = new Set(["1_2"]);
    recolorInPlace({});

    const suppressed = State.edgesDS.update.mock.calls
      .flatMap((c) => c[0])
      .find((u) => u.id === "1_2");
    const normal = State.edgesDS.update.mock.calls.flatMap((c) => c[0]).find((u) => u.id === "2_3");
    expect(suppressed.color.opacity).toBe(0);
    expect(normal.color.opacity).toBe(0.4);
  });
});

describe("highlightPath — expanded-tree tier", () => {
  function graph() {
    State.graphNodes = [
      { id: 1, isSeed: true },
      { id: 2, isSeed: false, _dimBorder: "#111111" },
      { id: 3, isSeed: false, _dimBorder: "#222222" },
      { id: 4, isSeed: false, _dimBorder: "#333333" },
    ];
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, dominantRole: "featured", weight: 1 },
      { id: "3_4", from: 3, to: 4, dominantRole: "producer", weight: 1 },
    ];
    invalidateColorCache();
    State.nodesDS = { update: vi.fn(), getIds: () => [1, 2, 3, 4] };
    State.edgesDS = { update: vi.fn(), getIds: () => ["1_2", "3_4"] };
  }

  it("keeps an expanded but off-path node brighter than an untouched one", () => {
    graph();
    State.expandedNodes = new Set([3]);

    highlightPath([1, 2]);

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const expanded = nodeUpdates.find((u) => u.id === 3);
    const untouched = nodeUpdates.find((u) => u.id === 4);

    expect(expanded.opacity).toBe(PATH_HIGHLIGHT_LEVELS.expandedOffPath.opacity);
    expect(untouched.opacity).toBe(PATH_HIGHLIGHT_LEVELS.neverTouched.opacity);
    expect(expanded.opacity).toBeGreaterThan(untouched.opacity);
  });

  it("keeps an edge inside the expanded tree brighter than an untouched one", () => {
    graph();
    State.expandedNodes = new Set([3, 4]);

    highlightPath([1, 2]);

    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates.find((u) => u.id === "3_4").color.opacity).toBe(
      PATH_HIGHLIGHT_LEVELS.expandedOffPath.edgeOpacity,
    );
  });

  it("needs both ends expanded before an edge counts as part of the tree", () => {
    graph();
    State.expandedNodes = new Set([3]);

    highlightPath([1, 2]);

    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates.find((u) => u.id === "3_4").color.opacity).toBe(
      PATH_HIGHLIGHT_LEVELS.neverTouched.edgeOpacity,
    );
  });

  it("treats nothing as expanded when the set is empty", () => {
    graph();
    State.expandedNodes = new Set();

    highlightPath([1, 2]);

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    expect(nodeUpdates.find((u) => u.id === 3).opacity).toBe(
      PATH_HIGHLIGHT_LEVELS.neverTouched.opacity,
    );
  });

  it("marks the seed on the path with a thicker border than a plain node", () => {
    graph();
    highlightPath([1, 2], { dim: false });

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    expect(nodeUpdates.find((u) => u.id === 4).borderWidth).toBe(2);
  });

  it("does nothing without datasets or without a path", () => {
    graph();
    expect(() => highlightPath(null)).not.toThrow();

    State.nodesDS = null;
    expect(() => highlightPath([1, 2])).not.toThrow();
  });
});

describe("compare endpoints", () => {
  beforeEach(() => {
    State.nodesDS = { update: vi.fn(), getIds: () => [1, 2] };
    State.edgesDS = { update: vi.fn(), getIds: () => ["1_2"] };
    buildDefaultColorCache();
  });

  it("marks the two endpoints distinctly", () => {
    markCompareEndpoint(1, "first");
    markCompareEndpoint(2, "second");

    const first = State.nodesDS.update.mock.calls.at(-2)[0];
    const second = State.nodesDS.update.mock.calls.at(-1)[0];
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(first.color.border).not.toBe(second.color.border);
  });

  it("restores both endpoints when the comparison is cleared", () => {
    markCompareEndpoint(1, "first");
    markCompareEndpoint(2, "second");
    State.nodesDS.update.mockClear();

    clearCompareEndpoints();

    expect(State.nodesDS.update).toHaveBeenCalled();
  });

  it("clearing with nothing marked is a no-op, not an error", () => {
    State.nodesDS.update.mockClear();
    expect(() => clearCompareEndpoints()).not.toThrow();
  });

  it("ignores a node that is not in the graph", () => {
    expect(() => markCompareEndpoint(999, "first")).not.toThrow();
  });
});
