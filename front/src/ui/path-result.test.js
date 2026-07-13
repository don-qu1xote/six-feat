// ════════════════════════════════════════════════════════════════════════════
// path-result.test.js — unit tests for mergePathData/renderHopChain
//                        (ui/path-result.js), driven on mock API-shaped data.
//
// graph.js and vis-adapter/index.js are mocked so these tests exercise only
// path-result.js's own merge/render logic (which nodes/edges get added, seed
// selection, network init-vs-merge branching, hop-chain HTML) rather than
// re-testing graph.js's builders (covered separately in graph.test.js) or
// the real vis.Network/canvas machinery.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph.js", () => ({
  buildNodeState: vi.fn((n, seedId) => ({
    id: n.id,
    name: n.name || n.label || "",
    imageUrl: n.image || "",
    isSeed: n.id === seedId,
  })),
  buildEdgeState: vi.fn((e) => ({
    id: `${Math.min(e.from, e.to)}_${Math.max(e.from, e.to)}`,
    from: e.from,
    to: e.to,
    weight: e.weight || 1,
    songs: e.songs || [],
    dominantRole: e.dominant_role || "primary",
  })),
  cacheNodeCollaborations: vi.fn(),
  computeNodeDominantRoles: vi.fn(),
  refreshNodeDimBorders: vi.fn(),
}));

vi.mock("../vis-adapter/index.js", () => ({
  initGraphOnCanvas: vi.fn(),
  initNetwork: vi.fn(),
  initPathNetwork: vi.fn(),
  mergeNetwork: vi.fn(),
  computeNodeSizes: vi.fn(),
  placePathNodes: vi.fn(() => ({ targets: new Map(), fromPos: new Map() })),
  clearGraphForPathSearch: vi.fn(),
  highlightEdgePair: vi.fn(),
}));

vi.mock("../api/analytics-client.js", () => ({ highlightPath: vi.fn() }));
vi.mock("./toast.js", () => ({ showToast: vi.fn() }));
vi.mock("./canvas-controls.js", () => ({ updateStatus: vi.fn() }));
vi.mock("./sidebar.js", () => ({ showEdgeSidebarByPathEdgeId: vi.fn() }));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { mergePathData, renderHopChain } from "./path-result.js";

// ─── mock API-shaped path response, mirroring GET /api/v1/graph/path ───────
function mockPathData(overrides = {}) {
  return {
    nodes: [
      { id: 1, name: "Drake" },
      { id: 2, name: "Future" },
      { id: 3, name: "Metro Boomin" },
    ],
    edges: [
      { from: 1, to: 2, weight: 3, songs: ["Jumpman"], dominant_role: "featured" },
      { from: 2, to: 3, weight: 1, songs: ["Draco"], dominant_role: "producer" },
    ],
    path: [1, 2, 3],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  State.graphNodes = [];
  State.graphEdges = [];
  State.network = null;
  State.currentSeedId = null;
  State.hasRendered = true;
  State._bfsAdj = null;
  State._bfsGraphHash = "";
});

describe("mergePathData", () => {
  it("adds all response nodes/edges to State when the graph was empty", () => {
    mergePathData(mockPathData());
    expect(State.graphNodes.map(n => n.id)).toEqual([1, 2, 3]);
    expect(State.graphEdges.map(e => e.id)).toEqual(["1_2", "2_3"]);
  });

  it("picks the first path node as the pseudo-seed when there is no current seed", () => {
    mergePathData(mockPathData());
    expect(State.currentSeedId).toBe(1);
    const seed = State.graphNodes.find(n => n.id === 1);
    expect(seed.isSeed).toBe(true);
    expect(State.graphNodes.find(n => n.id === 2).isSeed).toBe(false);
  });

  it("does not duplicate nodes/edges already present in State", () => {
    State.graphNodes = [{ id: 1, name: "Drake", isSeed: true }];
    State.graphEdges = [{ id: "1_2", from: 1, to: 2 }];
    State.currentSeedId = 1;
    State.network = { getPositions: () => ({}) };

    mergePathData(mockPathData());

    expect(State.graphNodes.map(n => n.id)).toEqual([1, 2, 3]);
    expect(State.graphEdges.map(e => e.id)).toEqual(["1_2", "2_3"]);
  });

  it("refreshes the BFS cache hash when the edge set changes", () => {
    State._bfsGraphHash = "stale";
    mergePathData(mockPathData());
    expect(State._bfsAdj).toBe(null);
    expect(State._bfsGraphHash).not.toBe("stale");
  });
});

describe("renderHopChain", () => {
  it("renders a hop-row per path node plus a connector between each pair", () => {
    els.hopChain = document.createElement("div");
    const data = mockPathData();
    renderHopChain(data.path, data.edges, data.nodes, { 1: "Drake", 2: "Future", 3: "Metro Boomin" });

    const rows = els.hopChain.querySelectorAll(".hop-row");
    const connectors = els.hopChain.querySelectorAll(".hop-connector");
    expect(rows).toHaveLength(3);
    expect(connectors).toHaveLength(2);
    expect(els.hopChain.innerHTML).toContain("Drake");
    expect(els.hopChain.innerHTML).toContain("Future");
  });

  it("shows the connecting songs on the hop between two nodes", () => {
    els.hopChain = document.createElement("div");
    const data = mockPathData();
    renderHopChain(data.path, data.edges, data.nodes, {});
    expect(els.hopChain.innerHTML).toContain("Jumpman");
    expect(els.hopChain.innerHTML).toContain("Draco");
  });

  it("wires click/keydown activation on every hop-songs / connector pill", () => {
    els.hopChain = document.createElement("div");
    const data = mockPathData();
    renderHopChain(data.path, data.edges, data.nodes, {});

    const pill = els.hopChain.querySelector('[data-edge-id="1_2"]');
    expect(pill).not.toBeNull();
    pill.dispatchEvent(new window.Event("click", { bubbles: true }));
    // highlightEdgePair/showEdgeSidebarByPathEdgeId are mocked; just assert no throw
    // and that the element is actually interactive.
    expect(pill.getAttribute("role")).toBe("button");
  });

  it("clears the hop chain and does nothing for a path shorter than 2 nodes", () => {
    els.hopChain = document.createElement("div");
    els.hopChain.innerHTML = "<div>stale</div>";
    renderHopChain([1], [], [{ id: 1, name: "Drake" }], {});
    expect(els.hopChain.innerHTML).toBe("");
  });
});
