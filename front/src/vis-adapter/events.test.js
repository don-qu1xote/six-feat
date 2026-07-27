// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/events.test.js — attachNetworkEvents' click handler, focused on
// SF-WEB-47: Compare mode must fully take over node clicks while active
// (bypassing selectObject/setFocus entirely) and hand them straight back
// once it's off, with the pre-existing SF-WEB-28 click behavior unchanged.
// vis.Network itself is a plain {on(event, cb)} stub — no real vis-network
// involved, same style as highlight.test.js's DataSet stubs.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State, setGameMode } from "../state/state.js";

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
const highlightEdgePair     = vi.fn();
const clearHoverHighlight   = vi.fn();
vi.mock("./highlight.js", () => ({
  highlightNeighborhood: (...a) => highlightNeighborhood(...a),
  highlightEdgePair:     (...a) => highlightEdgePair(...a),
  restoreDefaultColors:  vi.fn(),
  clearHoverHighlight:   (...a) => clearHoverHighlight(...a),
  cancelPendingHover:    vi.fn(),
  clearSelectedNode:     vi.fn(),
  clearSelectedEdge:     vi.fn(),
}));

vi.mock("./physics.js", () => ({ nudgePhysics: vi.fn() }));

// hoverNode/blurNode (unlike click) write els.network.style.cursor
// directly — those two aren't exercised by any test here. [SF-WEB-73]
// addEventListener/getBoundingClientRect/appendChild — the custom
// mousemove-driven edge hover wiring (attachNetworkEvents calls
// els.network.addEventListener unconditionally when els.network exists).
// [SF-WEB-74] events.js's own _domHoverWired guard means addEventListener
// only actually fires on the FIRST attachNetworkEvents call across this
// whole file's run (whichever test happens to run first) — every later
// test's vi.clearAllMocks() wipes the mock's *call history* but the
// captured handler itself must survive that, so it's stashed in a plain
// object via vi.hoisted rather than re-read from addEventListener.mock.calls.
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
  isCompareModeActive:        () => compareModeActive,
  handleCompareModeNodeClick: (...a) => handleCompareModeNodeClick(...a),
  exitCompareMode:            (...a) => exitCompareMode(...a),
}));

import { attachNetworkEvents, _hoveredEdgeIdAt } from "./events.js";
import { setEdgeCache, clearEdgeCache } from "./edge-render.js";
import { els } from "../dom/dom.js";

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

// [SF-WEB-74] "неинтуитивно" — doubleClick used to ignore Compare mode
// entirely: a double-click mid-pick silently ran the normal expand flow
// (searchArtist) underneath an in-progress first/second pick instead of
// doing anything compare-related. Same rule the click handler's own
// isCompareModeActive() gate already applies.
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

// [SF-GAME-49] Игровой режим ограничивает не только клик, но и ХОВЕР.
// highlightNeighborhood переписывает у каждого узла shape/image/color/
// borderWidth/shadow — на игровой доске это и читалось как «граф дёргается
// при движении мышки»: узлы меняли размер под курсором, аватарки мигали от
// перезаписи image, а парный clearHoverHighlight стирал раскраску ролей до
// следующего renderBoard. Замер на живой странице: 8 полных перекрасок
// DataSet за один проход мыши через веер.
describe("attachNetworkEvents hover — game mode (SF-GAME-49)", () => {
  afterEach(() => { setGameMode(false); });

  it("не запускает конвейер подсветки Explorer'а, пока режим включён", () => {
    const net = makeNet();
    State.network = net;
    attachNetworkEvents({});
    setGameMode(true, { clickRouter: null, homeParent: null });

    net._handlers.hoverNode({ node: 1 });
    net._handlers.blurNode({ node: 1 });

    expect(highlightNeighborhood).not.toHaveBeenCalled();
    expect(clearHoverHighlight).not.toHaveBeenCalled();
    // Курсор — единственное, что ховер меняет в игре напрямую; кольцо
    // рисует game-board.js на оверлее, без записей в DataSet.
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

// [SF-WEB-73] "подсветка не совпадает с тултипом" — found LIVE on a dense
// hub (65+ direct edges): vis.js's native hoverEdge event and its own
// built-in (title-based) tooltip stayed internally inconsistent with EACH
// OTHER, reproducibly, hovering the exact same pixel — both rely on
// edges.smooth "continuous", a DIFFERENT curve than the one actually drawn
// (edge-render.js's hub-bowed quadratic). hoverEdge/blurEdge are replaced
// entirely by _hoveredEdgeIdAt (curve-aware, same curve drawEdges paints)
// — a pure function (State.network + explicit DOM pointer in) testable
// without a real canvas/mousemove. This also folds in SF-WEB-71's "no
// separate edge-count threshold" — there never was one here to begin with.
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
    State.graphEdges = Array.from({ length: 500 }, (_, i) => ({ id: `e${i}`, from: 1, to: 3 + i, weight: 1 }));
    State.graphEdges.push({ id: edgeId, from: 1, to: 2, weight: 1 });
    setEdgeCache(new Map([[edgeId, { from: 1, to: 2, kind: "intra" }]]));
    const positions = { 1: { x: 0, y: 0 }, 2: { x: 100, y: 0 } };
    State.network = {
      getPositions: () => positions,
      getNodeAt: () => undefined,
      // DOMtoCanvas here is the identity — the test feeds "world" coords directly.
      DOMtoCanvas: (p) => p,
    };
    // Node 1's own position — always exactly on its incident edge's curve
    // regardless of bow, same reasoning as edge-render.test.js's nearestEdgeAt case.
    expect(_hoveredEdgeIdAt(positions[1])).toBe(edgeId);
  });
});

// [SF-WEB-74] "подсветка нод зависит от зума (на сильном zoom-out большого
// графа не подсвечиваем) — сделай то же для рёбер". render.js's own
// _attachZoomThrottle disables vis.js's native interaction.hover at
// bigGraph+scale<0.5, which used to silence hoverEdge for free (it went
// through the same native mechanism as hoverNode). SF-WEB-73 moved edge
// hover onto a DOM mousemove listener that bypasses interaction.hover
// entirely, so the same threshold needs an explicit check here — this
// drives the real mousemove → rAF-flush path end to end (attachNetworkEvents
// wires the listener; the stubbed rAF below runs the flush synchronously).
describe("_flushHoverEdgeFrame — zoom-based hover suppression (SF-WEB-74)", () => {
  beforeEach(() => {
    State.graphEdges = [];
    clearEdgeCache();
    vi.stubGlobal("requestAnimationFrame", (cb) => { cb(); return 1; });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // _customHoveredEdgeId is module-level state in events.js, not reset by
    // vi.clearAllMocks() — without this, the NEXT test's "same edge id
    // still hovered" would look like a no-op change and skip
    // highlightEdgePair entirely, same as a real mouseleave would reset it.
    domRefs.leaveHandler?.();
  });

  function wireAndMove() {
    attachNetworkEvents({});
    domRefs.moveHandler({ clientX: 0, clientY: 0 });
  }

  it("suppresses edge hover-highlight and the tooltip on a big graph zoomed far out — same threshold node-hover already uses", () => {
    State.graphEdges = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, from: 1, to: 2 + i, weight: 1 }));
    const edgeId = "1_2";
    setEdgeCache(new Map([[edgeId, { from: 1, to: 2, kind: "intra" }]]));
    const positions = { 1: { x: 0, y: 0 }, 2: { x: 100, y: 0 } };
    State.network = {
      on: () => {},
      getPositions: () => positions,
      getNodeAt: () => undefined,
      DOMtoCanvas: (p) => p,
      getScale: () => 0.3, // < 0.5 — same as render.js's native-hover cutoff
    };

    wireAndMove();

    expect(highlightEdgePair).not.toHaveBeenCalled();
    expect(els.network.style.cursor).toBe("default");
    expect(els.network.appendChild).not.toHaveBeenCalled(); // no tooltip
  });

  it("still highlights/tooltips the same graph once zoomed back in past the cutoff", () => {
    State.graphEdges = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, from: 1, to: 2 + i, weight: 1 }));
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
