import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
vi.mock("./toast.js", () => ({ showToast: vi.fn(), showRetryToast: vi.fn() }));
vi.mock("./canvas-controls.js", () => ({ updateStatus: vi.fn() }));
vi.mock("./sidebar.js", () => ({ showEdgeSidebarByPathEdgeId: vi.fn() }));
vi.mock("./loading.js", () => ({ showLoading: vi.fn() }));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { mergePathData, renderHopChain, runServerPath } from "./path-result.js";
import { showToast, showRetryToast } from "./toast.js";
import { showLoading } from "./loading.js";

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
  State.activeFilters = new Set(["featured", "producer", "writer"]);
  State.pathInFlight = false;
  State._pathAbortController = null;
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

describe("mergePathData", () => {
  it("adds all response nodes/edges to State when the graph was empty", () => {
    mergePathData(mockPathData());
    expect(State.graphNodes.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(State.graphEdges.map((e) => e.id)).toEqual(["1_2", "2_3"]);
  });

  it("picks the first path node as the pseudo-seed when there is no current seed", () => {
    mergePathData(mockPathData());
    expect(State.currentSeedId).toBe(1);
    const seed = State.graphNodes.find((n) => n.id === 1);
    expect(seed.isSeed).toBe(true);
    expect(State.graphNodes.find((n) => n.id === 2).isSeed).toBe(false);
  });

  it("does not duplicate nodes/edges already present in State", () => {
    State.graphNodes = [{ id: 1, name: "Drake", isSeed: true }];
    State.graphEdges = [{ id: "1_2", from: 1, to: 2 }];
    State.currentSeedId = 1;
    State.network = { getPositions: () => ({}) };

    mergePathData(mockPathData());

    expect(State.graphNodes.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(State.graphEdges.map((e) => e.id)).toEqual(["1_2", "2_3"]);
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
    renderHopChain(data.path, data.edges, data.nodes, {
      1: "Drake",
      2: "Future",
      3: "Metro Boomin",
    });

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
    expect(pill.getAttribute("role")).toBe("button");
  });

  it("clears the hop chain and does nothing for a path shorter than 2 nodes", () => {
    els.hopChain = document.createElement("div");
    els.hopChain.innerHTML = "<div>stale</div>";
    renderHopChain([1], [], [{ id: 1, name: "Drake" }], {});
    expect(els.hopChain.innerHTML).toBe("");
  });
});

describe("runServerPath", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the canvas-wide loading overlay while the request is in flight, and hides it when done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ nodes: [], edges: [], path: [] })),
    );
    els.hopChain = document.createElement("div");

    const promise = runServerPath("Drake", "Future");
    expect(showLoading).toHaveBeenCalledWith(true, null, undefined);

    await promise;
    expect(showLoading).toHaveBeenLastCalledWith(false);
  });

  it("passes opts.loadingMessage straight through to the overlay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ nodes: [], edges: [], path: [] })),
    );
    els.hopChain = document.createElement("div");

    await runServerPath("Drake", "Future", {
      loadingMessage: "Tracing a path from Drake to Future…",
    });
    expect(showLoading).toHaveBeenCalledWith(true, null, "Tracing a path from Drake to Future…");
  });

  it("shows a retry toast (not an embedded error card) when no path is found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ nodes: [], edges: [], path: [] })),
    );
    els.hopChain = document.createElement("div");

    await runServerPath("Drake", "Future");
    expect(showRetryToast).toHaveBeenCalledWith("No path found.", expect.any(Function));
    expect(showToast).not.toHaveBeenCalled();
  });

  it("shows a plain toast (not an embedded error card) for a non-transient API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: "resolve_failed", message: "'from': ambiguous match" }, 400),
        ),
    );
    els.hopChain = document.createElement("div");

    await runServerPath("Drke", "Future");
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("select an artist from the suggestions"),
    );
    expect(showRetryToast).not.toHaveBeenCalled();
  });

  it("renders the hop chain into the given chainEl on success, and never touches an error mechanism", async () => {
    const data = {
      nodes: [
        { id: 1, name: "Drake" },
        { id: 2, name: "Future" },
      ],
      edges: [],
      path: [1, 2],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(data)));
    const chainEl = document.createElement("div");

    await runServerPath("Drake", "Future", { chainEl });
    expect(chainEl.querySelectorAll(".hop-row")).toHaveLength(2);
    expect(showToast).not.toHaveBeenCalled();
    expect(showRetryToast).not.toHaveBeenCalled();
  });
});

describe("runServerPath — error and cancellation paths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    els.hopChain = document.createElement("div");
  });

  it("sends the active role filters with the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ nodes: [], edges: [], path: [] }));
    vi.stubGlobal("fetch", fetchMock);
    State.activeFilters = new Set(["featured", "producer"]);

    await runServerPath("Drake", "Future");

    expect(fetchMock.mock.calls[0][0]).toContain("roles=featured%2Cproducer");
    expect(fetchMock.mock.calls[0][0]).toContain("from=Drake");
  });

  it("clears the previous chain before searching again", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ path: [] })));
    els.hopChain.innerHTML = "<div>old</div>";

    await runServerPath("Drake", "Future");

    expect(els.hopChain.innerHTML).not.toContain("old");
  });

  it("aborts a search still in flight when a new one starts", async () => {
    const abort = vi.fn();
    State.pathInFlight = true;
    State._pathAbortController = { abort };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ path: [] })));

    await runServerPath("Drake", "Future");

    expect(abort).toHaveBeenCalled();
  });

  it("stays silent when the request is aborted", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));

    await runServerPath("Drake", "Future");

    expect(showToast).not.toHaveBeenCalled();
    expect(showRetryToast).not.toHaveBeenCalled();
  });

  // apiFetch нормализует любой отказ fetch в свою transient-ошибку, поэтому
  // упавшая сеть всегда приводит к предложению повторить.
  it("offers a retry when the network drops", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket hang up")));

    await runServerPath("Drake", "Future");

    expect(showRetryToast).toHaveBeenCalledWith(
      expect.stringContaining("Network error"),
      expect.any(Function),
    );
    expect(showToast).not.toHaveBeenCalled();
  });

  it("shows a plain toast when rendering the result blows up", async () => {
    const { highlightPath } = await import("../api/analytics-client.js");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          nodes: [{ id: 1, name: "Drake" }],
          edges: [],
          path: [1, 2],
        }),
      ),
    );
    highlightPath.mockImplementationOnce(() => {
      throw new Error("render blew up");
    });

    await runServerPath("Drake", "Future");

    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("render blew up"));
    expect(showRetryToast).not.toHaveBeenCalled();
  });

  it("offers a retry when Genius is temporarily unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "upstream" }, 503)));

    await runServerPath("Drake", "Future");

    expect(showRetryToast).toHaveBeenCalledWith(
      expect.stringContaining("temporarily unavailable"),
      expect.any(Function),
    );
  });

  it("falls back to a generic message when the backend sends none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 400)));

    await runServerPath("Drake", "Future");

    expect(showToast).toHaveBeenCalledWith("No path found between these artists.");
  });

  it("treats an unparseable body as a failure rather than crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new Error("not json");
        },
      }),
    );

    await runServerPath("Drake", "Future");

    expect(showToast).toHaveBeenCalled();
  });

  it("always releases the in-flight flag, success or failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    await runServerPath("Drake", "Future");

    expect(State.pathInFlight).toBe(false);
    expect(State._pathAbortController).toBeNull();
  });
});

describe("renderHopChain — connectors", () => {
  beforeEach(() => {
    els.hopChain = document.createElement("div");
    State.graphNodes = [];
    State.graphEdges = [];
  });

  const nodes = [
    { id: 1, name: "Drake" },
    { id: 2, name: "Future" },
  ];

  it("labels the connector with the track count and role", () => {
    renderHopChain(
      [1, 2],
      [{ from: 1, to: 2, weight: 3, dominant_role: "producer", songs: ["A", "B"] }],
      nodes,
      {},
    );

    const connector = els.hopChain.querySelector(".hop-connector");
    expect(connector.getAttribute("title")).toContain("producer");
    expect(connector.getAttribute("title")).toContain("3 tracks");
  });

  it("says 'collab' rather than 'primary' in the connector label", () => {
    renderHopChain([1, 2], [{ from: 1, to: 2, weight: 1, dominant_role: "primary" }], nodes, {});

    expect(els.hopChain.querySelector(".hop-connector").getAttribute("title")).toContain("collab");
  });

  it("uses the singular for a single shared track", () => {
    renderHopChain([1, 2], [{ from: 1, to: 2, weight: 1 }], nodes, {});

    const title = els.hopChain.querySelector(".hop-connector").getAttribute("title");
    expect(title).toContain("1 track");
    expect(title).not.toContain("1 tracks");
  });

  it("lists at most three song titles", () => {
    renderHopChain(
      [1, 2],
      [{ from: 1, to: 2, weight: 5, songs: ["A", "B", "C", "D", "E"] }],
      nodes,
      {},
    );

    const songs = els.hopChain.querySelector(".hop-songs").textContent;
    expect(songs).toContain("A");
    expect(songs).not.toContain("D");
  });

  it("reads titles out of collaboration objects too", () => {
    renderHopChain(
      [1, 2],
      [
        {
          from: 1,
          to: 2,
          weight: 1,
          collaborations: [{ song: "Jumpman" }, { title: "Draco" }, {}],
        },
      ],
      nodes,
      {},
    );

    const songs = els.hopChain.querySelector(".hop-songs").textContent;
    expect(songs).toContain("Jumpman");
    expect(songs).toContain("Draco");
    expect(songs).toContain("Untitled");
  });

  it("falls back to the id when a node has no name anywhere", () => {
    renderHopChain([1, 9], [], nodes, {});
    expect(els.hopChain.textContent).toContain("9");
  });

  it("prefers the supplied name map over a bare id", () => {
    renderHopChain([1, 9], [], nodes, { 9: "Mystery" });
    expect(els.hopChain.textContent).toContain("Mystery");
  });

  it("opens the edge sidebar from a connector, by click or Enter", async () => {
    const { highlightEdgePair } = await import("../vis-adapter/index.js");
    const { showEdgeSidebarByPathEdgeId } = await import("./sidebar.js");
    renderHopChain([1, 2], [{ id: "e1", from: 1, to: 2, weight: 1 }], nodes, {});

    els.hopChain.querySelector(".hop-connector").click();
    expect(highlightEdgePair).toHaveBeenCalledWith("e1");
    expect(showEdgeSidebarByPathEdgeId).toHaveBeenCalled();

    highlightEdgePair.mockClear();
    els.hopChain
      .querySelector(".hop-connector")
      .dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(highlightEdgePair).toHaveBeenCalled();

    highlightEdgePair.mockClear();
    els.hopChain
      .querySelector(".hop-connector")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(highlightEdgePair).not.toHaveBeenCalled();
  });

  it("falls back to a synthetic edge id when the edge has none", async () => {
    const { highlightEdgePair } = await import("../vis-adapter/index.js");
    renderHopChain([1, 2], [{ from: 1, to: 2, weight: 1 }], nodes, {});

    els.hopChain.querySelector(".hop-connector").click();

    expect(highlightEdgePair).toHaveBeenCalledWith("1_2");
  });

  it("reuses an edge already in the graph when the response omits it", async () => {
    State.graphEdges = [{ id: "known", from: 1, to: 2, weight: 7 }];
    renderHopChain([1, 2], [], nodes, {});

    expect(els.hopChain.querySelector(".hop-connector").getAttribute("title")).toContain(
      "7 tracks",
    );
  });
});
