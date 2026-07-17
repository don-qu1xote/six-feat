// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/events.test.js — attachNetworkEvents' click handler, focused on
// SF-WEB-47: Compare mode must fully take over node clicks while active
// (bypassing selectObject/setFocus entirely) and hand them straight back
// once it's off, with the pre-existing SF-WEB-28 click behavior unchanged.
// vis.Network itself is a plain {on(event, cb)} stub — no real vis-network
// involved, same style as highlight.test.js's DataSet stubs.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State } from "../state/state.js";

const showArtistSidebar = vi.fn();
const showEdgeSidebar   = vi.fn();
const hideArtistSidebar = vi.fn();
const showToast         = vi.fn();
vi.mock("../ui/index.js", () => ({
  showArtistSidebar: (...a) => showArtistSidebar(...a),
  showEdgeSidebar:   (...a) => showEdgeSidebar(...a),
  hideArtistSidebar: (...a) => hideArtistSidebar(...a),
  showToast:         (...a) => showToast(...a),
}));

vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));

const highlightNeighborhood = vi.fn();
vi.mock("./highlight.js", () => ({
  highlightNeighborhood: (...a) => highlightNeighborhood(...a),
  highlightEdgePair:     vi.fn(),
  restoreDefaultColors:  vi.fn(),
  clearHoverHighlight:   vi.fn(),
  cancelPendingHover:    vi.fn(),
  clearSelectedNode:     vi.fn(),
  clearSelectedEdge:     vi.fn(),
}));

vi.mock("./physics.js", () => ({ nudgePhysics: vi.fn() }));

let compareModeActive = false;
const handleCompareModeNodeClick = vi.fn();
const exitCompareMode = vi.fn();
vi.mock("./compare-mode.js", () => ({
  isCompareModeActive:        () => compareModeActive,
  handleCompareModeNodeClick: (...a) => handleCompareModeNodeClick(...a),
  exitCompareMode:            (...a) => exitCompareMode(...a),
}));

import { attachNetworkEvents } from "./events.js";

function makeNet() {
  const handlers = {};
  return { on: (evt, cb) => { handlers[evt] = cb; }, _handlers: handlers };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  compareModeActive = false;
  State.graphNodes = [{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }];
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

  // [fix] Was a silent no-op — reported as feeling "stuck" in the mode
  // with no visible way out. An edge/empty-canvas click isn't a valid pick
  // target, so it now exits the mode instead of doing nothing.
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

    expect(hideArtistSidebar).not.toHaveBeenCalled(); // clearFocus() not reached
    expect(exitCompareMode).toHaveBeenCalledTimes(1);
  });
});

describe("attachNetworkEvents click — Compare mode inactive (SF-WEB-28 unchanged)", () => {
  it("a node click still debounces into selectObject('node', id) → setFocus + showArtistSidebar", () => {
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});

    net._handlers.click({ nodes: [1], edges: [] });
    expect(showArtistSidebar).not.toHaveBeenCalled(); // debounced, not yet
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
