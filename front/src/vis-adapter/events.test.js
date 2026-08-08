import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State, setGameMode } from "../state/state.js";

const showArtistSidebar = vi.fn();
const showEdgeSidebar = vi.fn();
const hideArtistSidebar = vi.fn();
const showToast = vi.fn();
vi.mock("../ui/index.js", () => ({
  showArtistSidebar: (...a) => showArtistSidebar(...a),
  showEdgeSidebar: (...a) => showEdgeSidebar(...a),
  hideArtistSidebar: (...a) => hideArtistSidebar(...a),
  showToast: (...a) => showToast(...a),
}));

vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));

const highlightNeighborhood = vi.fn();
const highlightEdgePair = vi.fn();
const clearHoverHighlight = vi.fn();
vi.mock("./highlight.js", () => ({
  highlightNeighborhood: (...a) => highlightNeighborhood(...a),
  highlightEdgePair: (...a) => highlightEdgePair(...a),
  restoreDefaultColors: vi.fn(),
  clearHoverHighlight: (...a) => clearHoverHighlight(...a),
  cancelPendingHover: vi.fn(),
  clearSelectedNode: vi.fn(),
  clearSelectedEdge: vi.fn(),
}));

vi.mock("./physics.js", () => ({ nudgePhysics: vi.fn(), pokeFastRenderMode: vi.fn() }));

const domRefs = vi.hoisted(() => ({ moveHandler: null, leaveHandler: null }));
vi.mock("../dom/dom.js", () => ({
  els: {
    network: {
      style: {},
      addEventListener: vi.fn((evt, cb) => {
        if (evt === "mousemove") domRefs.moveHandler = cb;
        if (evt === "mouseleave") domRefs.leaveHandler = cb;
      }),
      removeEventListener: vi.fn(),
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      appendChild: vi.fn(),
    },
  },
}));

let compareModeActive = false;
const handleCompareModeNodeClick = vi.fn();
const exitCompareMode = vi.fn();
vi.mock("./compare-mode.js", () => ({
  isCompareModeActive: () => compareModeActive,
  handleCompareModeNodeClick: (...a) => handleCompareModeNodeClick(...a),
  exitCompareMode: (...a) => exitCompareMode(...a),
}));

import { attachNetworkEvents, _hoveredEdgeIdAt } from "./events.js";
import { setEdgeCache, clearEdgeCache } from "./edge-render.js";
import { els } from "../dom/dom.js";

function makeNet() {
  const handlers = {};
  return {
    on: (evt, cb) => {
      handlers[evt] = cb;
    },
    _handlers: handlers,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  compareModeActive = false;
  State.graphNodes = [
    { id: 1, name: "Alpha" },
    { id: 2, name: "Beta" },
  ];
  State.focusedNodeId = null;
  State.selectedEdgeId = null;
  State._clickTimer = null;
  State._lastClickNode = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("attachNetworkEvents click — Compare mode active", () => {
  it("routes a node click to handleCompareModeNodeClick instead of selectObject/setFocus", () => {
    compareModeActive = true;
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});

    net._handlers.click({ nodes: [1], edges: [] });
    vi.advanceTimersByTime(300);

    expect(handleCompareModeNodeClick).toHaveBeenCalledWith(1);
    expect(showArtistSidebar).not.toHaveBeenCalled();
    expect(highlightNeighborhood).not.toHaveBeenCalled();
  });

  it("exits Compare mode on an edge click instead of ignoring it", () => {
    compareModeActive = true;
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});

    net._handlers.click({ nodes: [], edges: ["1_2"] });

    expect(handleCompareModeNodeClick).not.toHaveBeenCalled();
    expect(showEdgeSidebar).not.toHaveBeenCalled();
    expect(exitCompareMode).toHaveBeenCalledTimes(1);
  });

  it("exits Compare mode on an empty-canvas click instead of ignoring it", () => {
    compareModeActive = true;
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});

    net._handlers.click({ nodes: [], edges: [] });

    expect(hideArtistSidebar).not.toHaveBeenCalled();
    expect(exitCompareMode).toHaveBeenCalledTimes(1);
  });
});

describe("attachNetworkEvents doubleClick — Compare mode (SF-WEB-74)", () => {
  it("exits Compare mode instead of expanding when a pick is in progress", () => {
    compareModeActive = true;
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});

    net._handlers.doubleClick({ nodes: [1] });

    expect(exitCompareMode).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("still expands normally when Compare mode is off (unchanged)", async () => {
    const { searchArtist } = await import("../api/api.js");
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});

    net._handlers.doubleClick({ nodes: [1] });

    expect(exitCompareMode).not.toHaveBeenCalled();
    expect(searchArtist).toHaveBeenCalledWith("Alpha", true, true);
  });
});

describe("attachNetworkEvents hover — game mode (SF-GAME-49)", () => {
  afterEach(() => {
    setGameMode(false);
  });

  it("не запускает конвейер подсветки Explorer'а, пока режим включён", () => {
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});
    setGameMode(true, { clickRouter: null, homeParent: null });

    net._handlers.hoverNode({ node: 1 });
    net._handlers.blurNode({ node: 1 });

    expect(highlightNeighborhood).not.toHaveBeenCalled();
    expect(clearHoverHighlight).not.toHaveBeenCalled();
    expect(els.network.style.cursor).toBe("default");
  });

  it("вне игрового режима подсветка работает как раньше", () => {
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});

    net._handlers.hoverNode({ node: 1 });
    expect(highlightNeighborhood).toHaveBeenCalledWith(1);
  });
});

describe("attachNetworkEvents click — Compare mode inactive (SF-WEB-28 unchanged)", () => {
  it("a node click still debounces into selectObject('node', id) → setFocus + showArtistSidebar", () => {
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});

    net._handlers.click({ nodes: [1], edges: [] });
    expect(showArtistSidebar).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);

    expect(handleCompareModeNodeClick).not.toHaveBeenCalled();
    expect(State.focusedNodeId).toBe(1);
    expect(highlightNeighborhood).toHaveBeenCalledWith(1);
    expect(showArtistSidebar).toHaveBeenCalledWith(1);
  });

  it("an edge click still goes straight to showEdgeSidebar (no debounce)", () => {
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});

    net._handlers.click({ nodes: [], edges: ["1_2"] });
    expect(showEdgeSidebar).toHaveBeenCalledWith("1_2", {});
    expect(handleCompareModeNodeClick).not.toHaveBeenCalled();
  });

  it("an empty-canvas click still clears focus", () => {
    State.focusedNodeId = 1;
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});

    net._handlers.click({ nodes: [], edges: [] });
    expect(hideArtistSidebar).toHaveBeenCalled();
    expect(State.focusedNodeId).toBeNull();
  });
});

describe("_hoveredEdgeIdAt (SF-WEB-73)", () => {
  beforeEach(() => {
    State.graphEdges = [];
    clearEdgeCache();
  });

  it("returns undefined (defer to native hoverNode) when a node sits under the pointer", () => {
    State.network = { getNodeAt: () => 7, DOMtoCanvas: () => ({ x: 0, y: 0 }) };
    expect(_hoveredEdgeIdAt({ x: 10, y: 10 })).toBeUndefined();
  });

  it("returns null when State.network doesn't support the needed hit-test methods", () => {
    State.network = {};
    expect(_hoveredEdgeIdAt({ x: 10, y: 10 })).toBeNull();
  });

  it("finds the cached edge whose drawn curve passes through the pointer's world position even on a graph with hundreds of edges", () => {
    const edgeId = "1_2";
    State.graphEdges = Array.from({ length: 500 }, (_, i) => ({
      id: `e${i}`,
      from: 1,
      to: 3 + i,
      weight: 1,
    }));
    State.graphEdges.push({ id: edgeId, from: 1, to: 2, weight: 1 });
    setEdgeCache(new Map([[edgeId, { from: 1, to: 2, kind: "intra" }]]));
    const positions = { 1: { x: 0, y: 0 }, 2: { x: 100, y: 0 } };
    State.network = {
      getPositions: () => positions,
      getNodeAt: () => undefined,
      DOMtoCanvas: (p) => p,
    };
    expect(_hoveredEdgeIdAt(positions[1])).toBe(edgeId);
  });
});

describe("_flushHoverEdgeFrame — zoom-based hover suppression (SF-WEB-74)", () => {
  beforeEach(() => {
    State.graphEdges = [];
    clearEdgeCache();
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      cb();
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    domRefs.leaveHandler?.();
  });

  function wireAndMove() {
    attachNetworkEvents({});
    domRefs.moveHandler({ clientX: 0, clientY: 0 });
  }

  it("suppresses edge hover-highlight and the tooltip on a big graph zoomed far out — same threshold node-hover already uses", () => {
    State.graphEdges = Array.from({ length: 200 }, (_, i) => ({
      id: `e${i}`,
      from: 1,
      to: 2 + i,
      weight: 1,
    }));
    const edgeId = "1_2";
    setEdgeCache(new Map([[edgeId, { from: 1, to: 2, kind: "intra" }]]));
    const positions = { 1: { x: 0, y: 0 }, 2: { x: 100, y: 0 } };
    State.network = {
      on: () => {},
      getPositions: () => positions,
      getNodeAt: () => undefined,
      DOMtoCanvas: (p) => p,
      getScale: () => 0.3,
    };

    wireAndMove();

    expect(highlightEdgePair).not.toHaveBeenCalled();
    expect(els.network.style.cursor).toBe("default");
    expect(els.network.appendChild).not.toHaveBeenCalled();
  });

  it("still highlights/tooltips the same graph once zoomed back in past the cutoff", () => {
    State.graphEdges = Array.from({ length: 200 }, (_, i) => ({
      id: `e${i}`,
      from: 1,
      to: 2 + i,
      weight: 1,
    }));
    const edgeId = "1_2";
    setEdgeCache(new Map([[edgeId, { from: 1, to: 2, kind: "intra" }]]));
    const positions = { 1: { x: 0, y: 0 }, 2: { x: 100, y: 0 } };
    State.network = {
      on: () => {},
      getPositions: () => positions,
      getNodeAt: () => undefined,
      DOMtoCanvas: (p) => p,
      getScale: () => 0.9,
    };

    wireAndMove();

    expect(highlightEdgePair).toHaveBeenCalledWith(edgeId);
  });

  it("leaves a small graph's edge hover unaffected even at extreme zoom-out (threshold is edge-count-gated, like node-hover's)", () => {
    State.graphEdges = [{ id: "1_2", from: 1, to: 2, weight: 1 }];
    const edgeId = "1_2";
    setEdgeCache(new Map([[edgeId, { from: 1, to: 2, kind: "intra" }]]));
    const positions = { 1: { x: 0, y: 0 }, 2: { x: 100, y: 0 } };
    State.network = {
      on: () => {},
      getPositions: () => positions,
      getNodeAt: () => undefined,
      DOMtoCanvas: (p) => p,
      getScale: () => 0.1,
    };

    wireAndMove();

    expect(highlightEdgePair).toHaveBeenCalledWith(edgeId);
  });
});

describe("click routing — seed switch, node select, edge select", () => {
  let net;

  beforeEach(() => {
    net = makeNet();
    State.network = net;
    State.graphNodes = [
      { id: 1, name: "Alpha", isSeed: true },
      { id: 2, name: "Beta", isSeed: false },
    ];
    setGameMode(false);
    attachNetworkEvents({ 1: "Alpha", 2: "Beta" });
  });

  it("selects a node after the double-click grace period", () => {
    net._handlers.click({ nodes: [2], edges: [] });
    expect(showArtistSidebar).not.toHaveBeenCalled();

    vi.advanceTimersByTime(260);

    expect(showArtistSidebar).toHaveBeenCalledWith(2);
    expect(State.focusedNodeId).toBe(2);
  });

  it("re-seeds the graph on ctrl/cmd-click of a non-seed node", async () => {
    const { searchArtist } = await import("../api/api.js");

    net._handlers.click({ nodes: [2], edges: [], event: { ctrlKey: true } });
    vi.advanceTimersByTime(300);

    expect(searchArtist).toHaveBeenCalledWith("Beta", false, true);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Beta"), 1800, true);
    expect(showArtistSidebar).not.toHaveBeenCalled();
  });

  it("ignores ctrl-click on the seed, which is already the seed", async () => {
    const { searchArtist } = await import("../api/api.js");

    net._handlers.click({ nodes: [1], edges: [], event: { metaKey: true } });
    vi.advanceTimersByTime(300);

    expect(searchArtist).not.toHaveBeenCalled();
  });

  it("clears the focus when clicking empty canvas", () => {
    State.focusedNodeId = 2;

    net._handlers.click({ nodes: [], edges: [] });

    expect(State.focusedNodeId).toBeNull();
    expect(hideArtistSidebar).toHaveBeenCalled();
  });

  it("opens the edge sidebar when an edge is clicked", () => {
    net._handlers.click({ nodes: [], edges: ["1_2"] });

    expect(showEdgeSidebar).toHaveBeenCalledWith("1_2", { 1: "Alpha", 2: "Beta" });
  });

  it("routes clicks to the game handler while a round is on", () => {
    setGameMode(true);
    State.game.clickRouter = vi.fn();

    net._handlers.click({ nodes: [2], edges: [] });
    vi.advanceTimersByTime(300);

    expect(showArtistSidebar).not.toHaveBeenCalled();
    setGameMode(false);
  });
});

describe("doubleClick", () => {
  let net;

  beforeEach(() => {
    net = makeNet();
    State.network = net;
    State.graphNodes = [{ id: 2, name: "Beta" }];
    attachNetworkEvents({});
  });

  it("expands the artist and cancels the pending single-click selection", async () => {
    const { searchArtist } = await import("../api/api.js");

    net._handlers.click({ nodes: [2], edges: [] });
    net._handlers.doubleClick({ nodes: [2] });
    vi.advanceTimersByTime(300);

    expect(searchArtist).toHaveBeenCalledWith("Beta", true, true);
    expect(State._clickedNodeId).toBe(2);
    expect(showArtistSidebar).not.toHaveBeenCalled();
  });

  it("does nothing on empty canvas", async () => {
    const { searchArtist } = await import("../api/api.js");
    net._handlers.doubleClick({ nodes: [] });
    expect(searchArtist).not.toHaveBeenCalled();
  });

  it("ignores a node that is not in the graph", async () => {
    const { searchArtist } = await import("../api/api.js");
    net._handlers.doubleClick({ nodes: [999] });
    expect(searchArtist).not.toHaveBeenCalled();
  });

  it("leaves compare mode instead of expanding", async () => {
    const { searchArtist } = await import("../api/api.js");
    compareModeActive = true;

    net._handlers.doubleClick({ nodes: [2] });

    expect(exitCompareMode).toHaveBeenCalled();
    expect(searchArtist).not.toHaveBeenCalled();
  });
});

describe("hover highlighting", () => {
  let net;

  beforeEach(() => {
    net = makeNet();
    State.network = net;
    State._isDragging = false;
    setGameMode(false);
    attachNetworkEvents({});
  });

  it("highlights the neighbourhood on hover and clears it on blur", () => {
    net._handlers.hoverNode({ node: 1 });
    expect(highlightNeighborhood).toHaveBeenCalledWith(1);
    expect(els.network.style.cursor).toBe("pointer");

    net._handlers.blurNode({ node: 1 });
    expect(clearHoverHighlight).toHaveBeenCalledWith(1);
    expect(els.network.style.cursor).toBe("default");
  });

  it("leaves an explicit selection alone while hovering", () => {
    State.focusedNodeId = 5;

    net._handlers.hoverNode({ node: 1 });
    net._handlers.blurNode({ node: 1 });

    expect(highlightNeighborhood).not.toHaveBeenCalled();
    expect(clearHoverHighlight).not.toHaveBeenCalled();
  });

  it("does not fight the drag in progress", () => {
    State._isDragging = true;

    net._handlers.hoverNode({ node: 1 });

    expect(highlightNeighborhood).not.toHaveBeenCalled();
  });

  it("skips hover highlighting entirely in game mode", () => {
    setGameMode(true);

    net._handlers.hoverNode({ node: 1 });
    net._handlers.blurNode({ node: 1 });

    expect(highlightNeighborhood).not.toHaveBeenCalled();
    expect(clearHoverHighlight).not.toHaveBeenCalled();
    setGameMode(false);
  });
});

describe("dragging", () => {
  let net;

  beforeEach(() => {
    net = makeNet();
    State.network = { ...net, setOptions: vi.fn() };
    State.network.on = net.on;
    State._isDragging = false;
    attachNetworkEvents({});
  });

  it("freezes physics while a node is dragged", () => {
    net._handlers.dragStart({ nodes: [1] });

    expect(State._isDragging).toBe(true);
    expect(State.network.setOptions).toHaveBeenCalledWith({ physics: { enabled: false } });
  });

  it("treats a canvas pan as no drag at all", () => {
    net._handlers.dragStart({ nodes: [] });
    expect(State._isDragging).toBe(false);
  });

  it("nudges physics once a dragged node is dropped", async () => {
    const { nudgePhysics } = await import("./physics.js");
    net._handlers.dragStart({ nodes: [1] });

    net._handlers.dragEnd({ nodes: [1] });

    expect(State._isDragging).toBe(false);
    expect(nudgePhysics).toHaveBeenCalled();
  });

  it("ignores a dragEnd that never began", async () => {
    const { nudgePhysics } = await import("./physics.js");
    net._handlers.dragEnd({ nodes: [1] });
    expect(nudgePhysics).not.toHaveBeenCalled();
  });

  it("keeps the fast render mode awake while dragging", () => {
    expect(() => net._handlers.dragging()).not.toThrow();
  });
});
