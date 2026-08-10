import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  initNetwork,
  initPathNetwork,
  refreshNetwork,
  openGeniusPage,
  initGraphOnCanvas,
  resetCanvasToEmpty,
  clearGraphForPathSearch,
  _attachZoomThrottle,
} from "./render.js";
import { forceCloseSearchModal, hideArtistSidebar } from "../ui/index.js";
import { runHeroGraphTransition } from "../dom/transition.js";
import { stopCanvasDecorator } from "../dom/canvas-decorator.js";
import { clearCanvasState } from "../ui/canvas-states.js";
import { resetHoverState, invalidateColorCache } from "./highlight.js";
import { attachNetworkEvents } from "./events.js";
import { isGameModeActive } from "./game-mode.js";
import { updateEdgeRenderMode, runFlyoutAnimation, pokeFastRenderMode } from "./physics.js";
import { ensureTooltipCollisionGuard } from "./tooltips.js";
import { placeExpandedNodes } from "./layout.js";
import { setEdgeCache, clearEdgeCache } from "./edge-render.js";
import { setContourData, clearContourData } from "./bubble-contours.js";

vi.mock("../ui/index.js", () => ({
  forceCloseSearchModal: vi.fn(),
  hideArtistSidebar: vi.fn(),
}));
vi.mock("../dom/transition.js", () => ({
  runHeroGraphTransition: vi.fn((mutate) => mutate()),
}));
vi.mock("../dom/canvas-decorator.js", () => ({ stopCanvasDecorator: vi.fn() }));
vi.mock("../ui/canvas-states.js", () => ({ clearCanvasState: vi.fn() }));
vi.mock("./highlight.js", () => ({
  resetHoverState: vi.fn(),
  invalidateColorCache: vi.fn(),
}));
vi.mock("./events.js", () => ({ attachNetworkEvents: vi.fn() }));
vi.mock("./game-mode.js", () => ({ isGameModeActive: vi.fn(() => false) }));
vi.mock("./physics.js", () => ({
  updateEdgeRenderMode: vi.fn(),
  runFlyoutAnimation: vi.fn(),
  pokeFastRenderMode: vi.fn(),
  resetFastRenderMode: vi.fn(),
}));
vi.mock("./tooltips.js", () => ({ ensureTooltipCollisionGuard: vi.fn() }));
vi.mock("./layout.js", () => ({
  placeExpandedNodes: vi.fn(() => ({
    targets: new Map(),
    edgeClass: new Map(),
    sectorMembers: new Map(),
  })),
  LEAF_R: 30,
}));
vi.mock("./edge-render.js", () => ({
  setEdgeCache: vi.fn(),
  clearEdgeCache: vi.fn(),
  drawEdges: vi.fn(),
  suppressNativeEdgeColor: vi.fn((e) => e),
}));
vi.mock("./bubble-contours.js", () => ({
  setContourData: vi.fn(),
  clearContourData: vi.fn(),
  drawContours: vi.fn(),
}));
vi.mock("./visuals.js", () => ({
  nodeVisual: vi.fn((n) => ({ id: n.id, label: n.name })),
  edgeVisual: vi.fn((e) => ({ from: e.from, to: e.to })),
  networkOptions: vi.fn(() => ({ interaction: {} })),
  hexToRgba: vi.fn(() => "rgba(0,0,0,0.12)"),
  LARGE_GRAPH_NODE_THRESHOLD: 120,
  FAST_RENDER_EDGE_THRESHOLD: 300,
}));

class FakeDataSet {
  constructor(items = []) {
    this.items = [...items];
    this.updated = [];
  }
  clear() {
    this.items = [];
  }
  add(items) {
    this.items.push(...items);
  }
  get(id) {
    return this.items.find((i) => i.id === id) || null;
  }
  update(items) {
    this.updated.push(items);
  }
}

class FakeNetwork {
  constructor(container, data, options) {
    this.container = container;
    this.data = data;
    this.options = options;
    this.handlers = {};
    this.moveNode = vi.fn();
    this.fit = vi.fn();
    this.redraw = vi.fn();
    this.setOptions = vi.fn();
    this.getScale = vi.fn(() => 1);
    this.getPosition = vi.fn(() => ({ x: 0, y: 0 }));
  }
  on(event, handler) {
    (this.handlers[event] ||= []).push(handler);
  }
  emit(event, ...args) {
    (this.handlers[event] || []).forEach((h) => h(...args));
  }
}

function fakeCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    strokeStyle: "",
    lineWidth: 0,
  };
}

const nameById = new Map([
  [1, "Drake"],
  [2, "Future"],
]);

beforeEach(() => {
  vi.stubGlobal("vis", { DataSet: FakeDataSet, Network: FakeNetwork });
  document.body.innerHTML = `<div id="network"></div><div id="status"></div><div id="canvas-state"></div>`;
  els.network = document.getElementById("network");
  els.status = document.getElementById("status");
  els.canvasState = document.getElementById("canvas-state");

  State.graphNodes = [
    { id: 1, name: "Drake", isSeed: true },
    { id: 2, name: "Future", isSeed: false },
  ];
  State.graphEdges = [{ from: 1, to: 2 }];
  State.expandedNodes = new Set();
  State.currentSeedId = null;
  State.network = null;
  State.nodesDS = null;
  State.edgesDS = null;
  State.physicsTimer = null;
  State._graphCache = new Map();
  isGameModeActive.mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initNetwork", () => {
  it("builds the datasets and mounts the network on the canvas element", () => {
    initNetwork(1, nameById);

    expect(State.nodesDS.items).toHaveLength(2);
    expect(State.edgesDS.items).toHaveLength(1);
    expect(State.network.container).toBe(els.network);
  });

  it("pins the seed at the origin so the graph is centred on it", () => {
    initNetwork(1, nameById);
    expect(State.network.moveNode).toHaveBeenCalledWith(1, 0, 0);
  });

  it("skips the pinning step when there is no seed", () => {
    initNetwork(null, nameById);
    expect(State.network.moveNode).not.toHaveBeenCalled();
  });

  it("registers the three custom painters that draw under the graph", () => {
    initNetwork(1, nameById);
    expect(State.network.handlers.beforeDrawing).toHaveLength(3);
  });

  it("wires up events, tooltips and edge render mode", () => {
    initNetwork(1, nameById);

    expect(attachNetworkEvents).toHaveBeenCalledWith(nameById);
    expect(ensureTooltipCollisionGuard).toHaveBeenCalled();
    expect(updateEdgeRenderMode).toHaveBeenCalled();
    expect(setEdgeCache).toHaveBeenCalled();
    expect(setContourData).toHaveBeenCalled();
  });

  it("turns physics off — positions come from the layout, not simulation", () => {
    initNetwork(1, nameById);
    expect(State.network.setOptions).toHaveBeenCalledWith({ physics: { enabled: false } });
    expect(State.physicsTimer).toBeNull();
  });

  it("fits the viewport to the graph in explorer mode", () => {
    initNetwork(1, nameById);
    expect(State.network.fit).toHaveBeenCalled();
  });

  it("leaves the camera alone in game mode, which frames the board itself", () => {
    isGameModeActive.mockReturnValue(true);
    initNetwork(1, nameById);
    expect(State.network.fit).not.toHaveBeenCalled();
  });

  it("pins the seed at the origin and every laid-out node at its slot", () => {
    placeExpandedNodes.mockReturnValueOnce({
      targets: new Map([[2, { x: 50, y: 60 }]]),
      edgeClass: new Map(),
      sectorMembers: new Map(),
    });

    initNetwork(1, nameById);

    expect(State.nodesDS.items.find((n) => n.id === 2)).toMatchObject({
      x: 50,
      y: 60,
      fixed: { x: true, y: true },
    });
    expect(State.nodesDS.items.find((n) => n.id === 1)).toMatchObject({
      x: 0,
      y: 0,
      fixed: { x: true, y: true },
    });
  });

  it("leaves a node the layout had no slot for unpinned", () => {
    initNetwork(null, nameById);

    const unplaced = State.nodesDS.items.find((n) => n.id === 2);
    expect(unplaced.fixed).toBeUndefined();
    expect(unplaced.x).toBeUndefined();
  });
});

describe("initPathNetwork", () => {
  const targets = new Map([
    [1, { x: 0, y: 0 }],
    [2, { x: 100, y: 0 }],
  ]);

  it("starts every node at its previous position so the path can fly out", () => {
    const fromPos = new Map([[2, { x: 7, y: 9 }]]);
    initPathNetwork(nameById, targets, fromPos);

    expect(State.nodesDS.items.find((n) => n.id === 2)).toMatchObject({ x: 7, y: 9, fixed: false });
  });

  it("falls back to the origin for a node with no previous position", () => {
    initPathNetwork(nameById, targets, new Map());
    expect(State.nodesDS.items.find((n) => n.id === 1)).toMatchObject({ x: 0, y: 0 });
  });

  it("creates the network with physics already disabled", () => {
    initPathNetwork(nameById, targets, new Map());
    expect(State.network.options.physics).toEqual({ enabled: false });
  });

  it("animates the path nodes into place", () => {
    initPathNetwork(nameById, targets, new Map());

    expect(runFlyoutAnimation).toHaveBeenCalledTimes(1);
    expect(runFlyoutAnimation.mock.calls[0][0].ids).toEqual([1, 2]);
  });

  it("frames the path and freezes it once the flight finishes", () => {
    initPathNetwork(nameById, targets, new Map());
    runFlyoutAnimation.mock.calls[0][0].onDone();

    expect(State.network.fit).toHaveBeenCalledWith(expect.objectContaining({ nodes: [1, 2] }));
    expect(State.nodesDS.updated[0]).toEqual([
      { id: 1, fixed: { x: true, y: true } },
      { id: 2, fixed: { x: true, y: true } },
    ]);
  });

  it("does nothing on landing if the graph was torn down mid-flight", () => {
    initPathNetwork(nameById, targets, new Map());
    const { onDone } = runFlyoutAnimation.mock.calls[0][0];
    const network = State.network;
    State.network = null;

    expect(() => onDone()).not.toThrow();
    expect(network.fit).not.toHaveBeenCalled();
  });
});

describe("refreshNetwork", () => {
  beforeEach(() => {
    initNetwork(1, nameById);
    State.network.moveNode.mockClear();
    State.network.fit.mockClear();
  });

  it("replaces the dataset contents rather than appending to them", () => {
    refreshNetwork(1, nameById, {});
    expect(State.nodesDS.items).toHaveLength(2);
    expect(State.edgesDS.items).toHaveLength(1);
  });

  it("re-centres the seed and repositions the rest", () => {
    placeExpandedNodes.mockReturnValueOnce({
      targets: new Map([[2, { x: 40, y: 50 }]]),
      edgeClass: new Map(),
      sectorMembers: new Map(),
    });

    refreshNetwork(1, nameById, {});

    expect(State.network.moveNode).toHaveBeenCalledWith(1, 0, 0);
    expect(State.network.moveNode).toHaveBeenCalledWith(2, 40, 50);
  });

  it("keeps the existing seed when called without one", () => {
    State.currentSeedId = 1;
    refreshNetwork(null, nameById, {});
    expect(State.currentSeedId).toBe(1);
    expect(State.network.moveNode).toHaveBeenCalledWith(1, 0, 0);
  });

  it("clears stale hover state so the old graph's highlight does not linger", () => {
    refreshNetwork(1, nameById, {});
    expect(resetHoverState).toHaveBeenCalled();
  });

  it("refits in explorer mode but not in game mode", () => {
    refreshNetwork(1, nameById, {});
    expect(State.network.fit).toHaveBeenCalled();

    State.network.fit.mockClear();
    isGameModeActive.mockReturnValue(true);
    refreshNetwork(1, nameById, {});
    expect(State.network.fit).not.toHaveBeenCalled();
  });
});

describe("zoom throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    State.network = new FakeNetwork();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when there is no network yet", () => {
    State.network = null;
    expect(() => _attachZoomThrottle()).not.toThrow();
  });

  it("pokes fast-render mode on every zoom", () => {
    _attachZoomThrottle();
    State.network.emit("zoom");
    expect(pokeFastRenderMode).toHaveBeenCalled();
  });

  it("skips the throttled redraw for small graphs", () => {
    State.graphEdges = new Array(50).fill({ from: 1, to: 2 });
    _attachZoomThrottle();
    State.network.emit("zoom");

    vi.advanceTimersByTime(100);
    expect(State.network.redraw).not.toHaveBeenCalled();
  });

  it("coalesces a burst of zooms into a single redraw on a big graph", () => {
    State.graphEdges = new Array(200).fill({ from: 1, to: 2 });
    _attachZoomThrottle();

    State.network.emit("zoom");
    State.network.emit("zoom");
    State.network.emit("zoom");
    vi.advanceTimersByTime(60);

    expect(State.network.redraw).toHaveBeenCalledTimes(1);
  });

  it("drops hover handling when a huge graph is zoomed far out", () => {
    State.graphEdges = new Array(400).fill({ from: 1, to: 2 });
    _attachZoomThrottle();
    State.network.getScale.mockReturnValue(0.3);

    State.network.emit("zoom");

    expect(State.network.setOptions).toHaveBeenCalledWith({ interaction: { hover: false } });
  });

  it("restores hover once the user zooms back in", () => {
    State.graphEdges = new Array(400).fill({ from: 1, to: 2 });
    _attachZoomThrottle();
    State.network.getScale.mockReturnValue(0.9);

    State.network.emit("zoom");

    expect(State.network.setOptions).toHaveBeenCalledWith({ interaction: { hover: true } });
  });

  it("never touches hover settings on a small graph, whatever the zoom", () => {
    State.graphEdges = new Array(10).fill({ from: 1, to: 2 });
    _attachZoomThrottle();
    State.network.getScale.mockReturnValue(0.1);

    State.network.emit("zoom");

    expect(State.network.setOptions).not.toHaveBeenCalled();
  });
});

describe("ring guides painter", () => {
  const paint = (ctx) => State.network.handlers.beforeDrawing[1](ctx);

  it("draws a ring around each hub node", () => {
    State.expandedNodes = new Set([2]);
    initNetwork(1, nameById);
    State.nodesDS = new FakeDataSet([{ id: 1 }, { id: 2 }]);

    const ctx = fakeCtx();
    paint(ctx);

    // Сид плюс раскрытый узел — два кольца.
    expect(ctx.arc).toHaveBeenCalledTimes(2);
    expect(ctx.save).toHaveBeenCalled();
    expect(ctx.restore).toHaveBeenCalled();
  });

  it("draws nothing when no node has been expanded and there is no seed", () => {
    initNetwork(null, nameById);
    State.nodesDS = new FakeDataSet([{ id: 1 }, { id: 2 }]);

    const ctx = fakeCtx();
    paint(ctx);

    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it("skips the guides entirely on a large graph, where they would be noise", () => {
    initNetwork(1, nameById);
    State.graphNodes = new Array(200).fill({ id: 1, name: "x" });
    State.nodesDS = new FakeDataSet([{ id: 1 }]);

    const ctx = fakeCtx();
    paint(ctx);

    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it("draws nothing when the graph is empty", () => {
    initNetwork(1, nameById);
    State.graphNodes = [];

    const ctx = fakeCtx();
    paint(ctx);

    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it("skips a hub that is not in the dataset", () => {
    initNetwork(1, nameById);
    State.nodesDS = new FakeDataSet([]);

    const ctx = fakeCtx();
    paint(ctx);

    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it("survives vis refusing to report a position mid-render", () => {
    initNetwork(1, nameById);
    State.nodesDS = new FakeDataSet([{ id: 1 }]);
    State.network.getPosition = vi.fn(() => {
      throw new Error("node not found");
    });

    const ctx = fakeCtx();
    expect(() => paint(ctx)).not.toThrow();
    expect(ctx.arc).not.toHaveBeenCalled();
    expect(ctx.restore).toHaveBeenCalled();
  });
});

describe("openGeniusPage", () => {
  beforeEach(() => {
    vi.stubGlobal("open", vi.fn());
  });

  it("opens the artist's own Genius URL when the backend gave one", () => {
    State.graphNodes = [
      { id: 1, name: "Drake", geniusUrl: "https://genius.com/artists/drake-real" },
    ];
    openGeniusPage(1);

    expect(window.open).toHaveBeenCalledWith(
      "https://genius.com/artists/drake-real",
      "_blank",
      "noopener",
    );
  });

  it("falls back to a slug built from the name when there is no URL", () => {
    State.graphNodes = [{ id: 1, name: "A Tribe Called Quest" }];
    openGeniusPage(1);

    expect(window.open).toHaveBeenCalledWith(
      "https://genius.com/artists/a-tribe-called-quest",
      "_blank",
      "noopener",
    );
  });

  it("slugifies spaces first, then percent-encodes what is left", () => {
    State.graphNodes = [{ id: 1, name: "Sigur Rós" }];
    openGeniusPage(1);

    expect(window.open.mock.calls[0][0]).toBe("https://genius.com/artists/sigur-r%C3%B3s");
  });

  it("does nothing for a node that is not in the graph", () => {
    openGeniusPage(999);
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe("initGraphOnCanvas", () => {
  it("swaps the hero for the graph inside a single animated transition", () => {
    initGraphOnCanvas();

    expect(runHeroGraphTransition).toHaveBeenCalledTimes(1);
    expect(forceCloseSearchModal).toHaveBeenCalled();
    expect(els.status.hidden).toBe(false);
  });

  it("stops the idle canvas decoration and clears the empty state", () => {
    initGraphOnCanvas();

    expect(stopCanvasDecorator).toHaveBeenCalled();
    expect(clearCanvasState).toHaveBeenCalledWith(els.canvasState);
  });
});

describe("resetting the canvas", () => {
  it("drops the cached graphs when returning to an empty canvas", () => {
    State._graphCache.set("drake", {});
    resetCanvasToEmpty();

    expect(State._graphCache.size).toBe(0);
    expect(invalidateColorCache).toHaveBeenCalled();
    expect(hideArtistSidebar).toHaveBeenCalled();
  });

  it("keeps the cached graphs when only clearing for a path search", () => {
    State._graphCache.set("drake", {});
    clearGraphForPathSearch();

    expect(State._graphCache.size).toBe(1);
    expect(invalidateColorCache).toHaveBeenCalled();
  });

  it("clears every render-side cache in both cases", () => {
    clearGraphForPathSearch();

    expect(clearEdgeCache).toHaveBeenCalled();
    expect(clearContourData).toHaveBeenCalled();
    expect(resetHoverState).toHaveBeenCalled();
  });
});
