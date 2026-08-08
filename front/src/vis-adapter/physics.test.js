import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State } from "../state/state.js";
import {
  runFlyoutAnimation,
  nudgePhysics,
  mergeNetwork,
  pokeFastRenderMode,
  resetFastRenderMode,
  scheduleFreeze,
  updateEdgeRenderMode,
  _fitToExpandedCluster,
} from "./physics.js";
import { LARGE_GRAPH_NODE_THRESHOLD } from "./visuals.js";
import { placeExpandedNodes } from "./layout.js";

function mockNetwork(ids) {
  const nodes = {};
  for (const id of ids) nodes[id] = { x: 0, y: 0 };
  return {
    body: { nodes },
    redraw: vi.fn(),
    moveNode: vi.fn((id, x, y) => {
      nodes[id] = { x, y };
    }),
  };
}

let rafCallbacks;
function flushFrame(ts) {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  cbs.forEach((cb) => cb(ts));
}

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (cb) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  State.nodesDS = { update: vi.fn() };
  State._expandAnimId = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runFlyoutAnimation", () => {
  it("uses a short-ease-in, long-decelerate curve — neither an instant snap nor a sluggish drag", () => {
    const ids = [1];
    const fromPos = new Map([[1, { x: 0, y: 0 }]]);
    const targets = new Map([[1, { x: 1000, y: 0 }]]);
    State.network = mockNetwork(ids);

    runFlyoutAnimation({ ids, fromPos, targets, durationMs: 1000, onDone: () => {} });
    flushFrame(0);
    flushFrame(250);
    const x = State.network.body.nodes[1].x;
    expect(x).toBeGreaterThan(150);
    expect(x).toBeLessThan(400);
  });

  it("calls onDone exactly once and lands nodes exactly on targets", () => {
    const ids = [1, 2];
    const fromPos = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 10, y: 10 }],
    ]);
    const targets = new Map([
      [1, { x: 100, y: 50 }],
      [2, { x: -20, y: 30 }],
    ]);
    State.network = mockNetwork(ids);

    const onDone = vi.fn();
    runFlyoutAnimation({ ids, fromPos, targets, durationMs: 100, onDone });

    expect(rafCallbacks.length).toBe(1);
    flushFrame(0);
    flushFrame(50);
    flushFrame(100);

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(rafCallbacks.length).toBe(0);
    expect(State.network.body.nodes[1]).toEqual({ x: 100, y: 50 });
    expect(State.network.body.nodes[2]).toEqual({ x: -20, y: 30 });
  });

  it("prefers-reduced-motion places nodes on targets immediately, skipping RAF", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

    const ids = [1];
    const fromPos = new Map([[1, { x: 0, y: 0 }]]);
    const targets = new Map([[1, { x: 77, y: -13 }]]);
    State.network = mockNetwork(ids);

    const onDone = vi.fn();
    const result = runFlyoutAnimation({ ids, fromPos, targets, durationMs: 420, onDone });

    expect(result).toBeNull();
    expect(rafCallbacks.length).toBe(0);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(State.network.moveNode).toHaveBeenCalledWith(1, 77, -13);
  });

  it("drives entranceTargets (new-node soft appear) to their final size/opacity", () => {
    const ids = [1];
    const fromPos = new Map([[1, { x: 0, y: 0 }]]);
    const targets = new Map([[1, { x: 0, y: 0 }]]);
    const entranceTargets = new Map([[1, { size: 22, opacity: 1 }]]);
    State.network = mockNetwork(ids);

    runFlyoutAnimation({
      ids,
      fromPos,
      targets,
      durationMs: 100,
      entranceTargets,
      onDone: () => {},
    });

    flushFrame(0);
    flushFrame(300);
    const finalUpdate = State.nodesDS.update.mock.calls
      .map(([batch]) => batch.find((u) => u.id === 1))
      .filter(Boolean)
      .pop();
    expect(finalUpdate).toEqual({ id: 1, size: 22, opacity: 1 });
  });

  it("staggers multiple new nodes' bloom instead of blooming them all in unison", () => {
    const ids = [1, 2];
    const fromPos = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 0, y: 0 }],
    ]);
    const targets = new Map([
      [1, { x: 0, y: 0 }],
      [2, { x: 0, y: 0 }],
    ]);
    const entranceTargets = new Map([
      [1, { size: 22, opacity: 1 }],
      [2, { size: 22, opacity: 1 }],
    ]);
    State.network = mockNetwork(ids);

    runFlyoutAnimation({
      ids,
      fromPos,
      targets,
      durationMs: 500,
      entranceTargets,
      onDone: () => {},
    });

    flushFrame(0);
    flushFrame(10);
    const batch = State.nodesDS.update.mock.calls
      .map(([b]) => b)
      .filter((b) => b.some((u) => u.id === 1) && b.some((u) => u.id === 2))
      .pop();
    expect(batch).toBeTruthy();
    const u1 = batch.find((u) => u.id === 1);
    const u2 = batch.find((u) => u.id === 2);
    expect(u1.size).toBeGreaterThan(u2.size);
    expect(u1.opacity).toBeGreaterThan(u2.opacity);
  });
});

describe("nudgePhysics — shorter live-physics settle window on large graphs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    State.network = { setOptions: vi.fn() };
    State.physicsTimer = null;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("caps the settle window below the caller's requested duration once the graph is large", () => {
    State.graphNodes = Array.from({ length: LARGE_GRAPH_NODE_THRESHOLD + 1 }, (_, i) => ({
      id: i,
    }));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    nudgePhysics(1500);

    const [, delay] = setTimeoutSpy.mock.calls.at(-1);
    expect(delay).toBeLessThan(1500);
  });

  it("keeps the caller's requested settle window unchanged on a normal-sized graph", () => {
    State.graphNodes = Array.from({ length: LARGE_GRAPH_NODE_THRESHOLD }, (_, i) => ({ id: i }));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    nudgePhysics(1500);

    const [, delay] = setTimeoutSpy.mock.calls.at(-1);
    expect(delay).toBe(1500);
  });

  it("still turns physics back off once the shortened window elapses", () => {
    State.graphNodes = Array.from({ length: LARGE_GRAPH_NODE_THRESHOLD + 1 }, (_, i) => ({
      id: i,
    }));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    nudgePhysics(1500);
    const [, delay] = setTimeoutSpy.mock.calls.at(-1);
    vi.advanceTimersByTime(delay);

    expect(State.network.setOptions).toHaveBeenCalledWith({ physics: { enabled: false } });
  });
});

describe("mergeNetwork — expand lands nodes exactly on targets, no live physics", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    State._expandAnimId = null;
    State.physicsTimer = null;

    const seedId = 1,
      poleId = 2,
      leafA = 100,
      leafB = 101;
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleId]);
    State.graphNodes = [
      { id: seedId, isSeed: true, _isNew: false },
      { id: poleId, isSeed: false, _isNew: false },
      { id: leafA, isSeed: false, _isNew: true },
      { id: leafB, isSeed: false, _isNew: true },
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleId}`, from: seedId, to: poleId, weight: 1 },
      { id: `${poleId}_${leafA}`, from: poleId, to: leafA, weight: 1 },
      { id: `${poleId}_${leafB}`, from: poleId, to: leafB, weight: 1 },
    ];

    State.nodesDS = {
      getIds: () => [seedId, poleId],
      add: vi.fn(),
      update: vi.fn(),
    };
    State.edgesDS = {
      getIds: () => [],
      add: vi.fn(),
      update: vi.fn(),
    };
    State.network = {
      body: { nodes: {} },
      setOptions: vi.fn(),
      moveNode: vi.fn(),
      moveTo: vi.fn(),
      redraw: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never re-enables live physics (no {physics:{enabled:true,...}} call) after the flyout", () => {
    mergeNetwork({}, {});

    const enabledTrueCalls = State.network.setOptions.mock.calls.filter(
      ([opts]) => opts?.physics?.enabled === true,
    );
    expect(enabledTrueCalls).toHaveLength(0);
  });

  it("explicitly turns physics off once the flyout completes", () => {
    mergeNetwork({}, {});

    expect(State.network.setOptions).toHaveBeenCalledWith({ physics: { enabled: false } });
  });

  it("fixes every node in the graph at its landed position, including nodes untouched by this expand", () => {
    mergeNetwork({}, {});

    const fixCall = State.nodesDS.update.mock.calls
      .map(([batch]) => batch)
      .find(
        (batch) =>
          Array.isArray(batch) &&
          batch.length === 4 &&
          batch.every((u) => u.fixed && u.fixed.x === true && u.fixed.y === true),
      );
    expect(fixCall).toBeTruthy();
    const fixedIds = fixCall.map((u) => u.id).sort((a, b) => a - b);
    expect(fixedIds).toEqual([1, 2, 100, 101]);
  });

  it("does not schedule any settle/freeze timer for the expand case", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mergeNetwork({}, {});
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("lands every node on exactly its collision-solved placeExpandedNodes target (no post-drift)", () => {
    const { targets: expected } = placeExpandedNodes({});

    const moveCalls = new Map();
    State.network.moveNode = vi.fn((id, x, y) => moveCalls.set(id, { x, y }));

    mergeNetwork({}, {});

    for (const [id, pos] of expected) {
      expect(moveCalls.get(id), `node ${id} never placed`).toBeTruthy();
      expect(moveCalls.get(id).x).toBeCloseTo(pos.x, 6);
      expect(moveCalls.get(id).y).toBeCloseTo(pos.y, 6);
    }
  });

  it("adds every new edge fully invisible (opacity:0, transparent color, hover/highlight zeroed too)", () => {
    mergeNetwork({}, {});

    const addCall = State.edgesDS.add.mock.calls.find(
      ([batch]) => Array.isArray(batch) && batch.length,
    );
    expect(addCall).toBeTruthy();
    for (const edgeItem of addCall[0]) {
      expect(edgeItem.color.opacity).toBe(0);
      expect(edgeItem.color.color).toBe("rgba(0,0,0,0)");
      expect(edgeItem.color.hover.opacity).toBe(0);
      expect(edgeItem.color.highlight.opacity).toBe(0);
    }
  });

  it("populates the edge-render.js cache with every edge, classified", async () => {
    const { _edgeCacheSize, clearEdgeCache } = await import("./edge-render.js");
    clearEdgeCache();
    mergeNetwork({}, {});
    expect(_edgeCacheSize()).toBe(State.graphEdges.length);
    clearEdgeCache();
  });

  it("also suppresses the native color of an edge that already existed in the DataSet before this expand", () => {
    const preexistingEdgeId = `${State.currentSeedId}_${2}`;
    State.edgesDS.getIds = () => [preexistingEdgeId];
    State.edgesDS.update = vi.fn();

    mergeNetwork({}, {});

    const suppressUpd = State.edgesDS.update.mock.calls
      .flatMap(([arg]) => (Array.isArray(arg) ? arg : [arg]))
      .find((u) => u.id === preexistingEdgeId);
    expect(suppressUpd).toBeTruthy();
    expect(suppressUpd.color.opacity).toBe(0);
    expect(suppressUpd.color.color).toBe("rgba(0,0,0,0)");
  });

  it("re-applies the active path highlight after an expand instead of silently dropping it", async () => {
    const { COLOR } = await import("../state/state.js");
    State.pathHighlight = [State.currentSeedId, 2];
    mergeNetwork({}, {});

    const onPathUpd = State.nodesDS.update.mock.calls
      .flatMap(([arg]) => (Array.isArray(arg) ? arg : [arg]))
      .find((u) => u.id === 2 && u.color?.border === COLOR.neon);
    expect(onPathUpd).toBeTruthy();

    State.pathHighlight = null;
  });

  it("re-applies the focused node's highlight after an expand instead of silently dropping it", async () => {
    State.edgesDS.get = () => null;
    State.focusedNodeId = 2;
    try {
      mergeNetwork({}, {});
      const plainUpd = State.nodesDS.update.mock.calls
        .flatMap(([arg]) => (Array.isArray(arg) ? arg : [arg]))
        .find((u) => u.id === 2);
      expect(plainUpd.shape).toBeUndefined();

      flushFrame(0);

      const focusUpd = State.nodesDS.update.mock.calls
        .flatMap(([arg]) => (Array.isArray(arg) ? arg : [arg]))
        .find((u) => u.id === 2 && u.shape === "circularImage");
      expect(focusUpd).toBeTruthy();
    } finally {
      State.focusedNodeId = null;
    }
  });
});

describe("mergeNetwork — camera focuses on the just-expanded node's own new content (SF-WEB-61)", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    State._expandAnimId = null;
    State.physicsTimer = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("centers the camera near the just-expanded node, not at the seed's (0,0), when far-off older content exists", () => {
    const seedId = 1,
      oldPole = 2,
      oldLeaf = 100,
      newPole = 3,
      newLeaf = 200;
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([oldPole, newPole]);
    State.lastExpandedId = newPole;
    State.graphNodes = [
      { id: seedId, isSeed: true, _isNew: false },
      { id: oldPole, isSeed: false, _isNew: false },
      { id: oldLeaf, isSeed: false, _isNew: false },
      { id: newPole, isSeed: false, _isNew: false },
      { id: newLeaf, isSeed: false, _isNew: true },
    ];
    State.graphEdges = [
      { id: `${seedId}_${oldPole}`, from: seedId, to: oldPole, weight: 1 },
      { id: `${oldPole}_${oldLeaf}`, from: oldPole, to: oldLeaf, weight: 1 },
      { id: `${seedId}_${newPole}`, from: seedId, to: newPole, weight: 1 },
      { id: `${newPole}_${newLeaf}`, from: newPole, to: newLeaf, weight: 1 },
    ];
    State.nodesDS = {
      getIds: () => [seedId, oldPole, oldLeaf, newPole],
      add: vi.fn(),
      update: vi.fn(),
    };
    State.edgesDS = {
      getIds: () => [`${seedId}_${oldPole}`, `${oldPole}_${oldLeaf}`, `${seedId}_${newPole}`],
      add: vi.fn(),
      update: vi.fn(),
    };
    State.network = {
      body: { nodes: {} },
      setOptions: vi.fn(),
      moveNode: vi.fn(),
      moveTo: vi.fn(),
      redraw: vi.fn(),
    };

    const { targets } = placeExpandedNodes({});
    const oldPos = targets.get(oldPole),
      newPos = targets.get(newPole);
    expect(Math.hypot(oldPos.x - newPos.x, oldPos.y - newPos.y)).toBeGreaterThan(100);

    mergeNetwork({}, {});

    const moveToCall = State.network.moveTo.mock.calls.at(-1)[0];
    const distToNew = Math.hypot(
      moveToCall.position.x - newPos.x,
      moveToCall.position.y - newPos.y,
    );
    const distToOld = Math.hypot(
      moveToCall.position.x - oldPos.x,
      moveToCall.position.y - oldPos.y,
    );
    expect(distToNew).toBeLessThan(distToOld);
  });
});

describe("mergeNetwork — flyout duration comes from MOTION.flight, not a hardcoded literal", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    State._expandAnimId = null;
    State.physicsTimer = null;

    const seedId = 1,
      poleId = 2,
      leafA = 100;
    State.currentSeedId = seedId;
    State.expandedNodes = new Set([poleId]);
    State.graphNodes = [
      { id: seedId, isSeed: true, _isNew: false },
      { id: poleId, isSeed: false, _isNew: false },
      { id: leafA, isSeed: false, _isNew: true },
    ];
    State.graphEdges = [
      { id: `${seedId}_${poleId}`, from: seedId, to: poleId, weight: 1 },
      { id: `${poleId}_${leafA}`, from: poleId, to: leafA, weight: 1 },
    ];
    State.nodesDS = { getIds: () => [seedId, poleId], add: vi.fn(), update: vi.fn() };
    State.edgesDS = { getIds: () => [], add: vi.fn(), update: vi.fn() };
    State.network = {
      body: { nodes: {} },
      setOptions: vi.fn(),
      moveNode: vi.fn(),
      moveTo: vi.fn(),
      redraw: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty("--duration-flight");
  });

  it("finishes (fires onDone's fixAll) within a token-shrunk duration the old hardcoded 420ms never would have", () => {
    document.documentElement.style.setProperty("--duration-flight", "50ms");
    mergeNetwork({}, {});

    flushFrame(0);
    flushFrame(60);
    const fixCall = State.nodesDS.update.mock.calls
      .map(([batch]) => batch)
      .find((batch) => Array.isArray(batch) && batch.length && batch.every((u) => u.fixed));
    expect(fixCall).toBeTruthy();
  });
});

describe("pokeFastRenderMode / resetFastRenderMode", () => {
  function bigGraphNodes(n) {
    return Array.from({ length: n }, (_, i) => ({ id: i, name: `n${i}`, isSeed: i === 0 }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    State.nodesDS = { update: vi.fn() };
    resetFastRenderMode();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFastRenderMode();
  });

  it("does nothing on graphs at or below LARGE_GRAPH_NODE_THRESHOLD", () => {
    State.graphNodes = bigGraphNodes(LARGE_GRAPH_NODE_THRESHOLD);
    State.network = {};
    pokeFastRenderMode();
    expect(State.nodesDS.update).not.toHaveBeenCalled();
  });

  it("swaps every node to shape:dot exactly once on entry, even across repeated pokes", () => {
    State.graphNodes = bigGraphNodes(LARGE_GRAPH_NODE_THRESHOLD + 10);
    State.network = {};
    pokeFastRenderMode();
    pokeFastRenderMode();
    pokeFastRenderMode();

    const dotCalls = State.nodesDS.update.mock.calls.filter(
      ([batch]) => Array.isArray(batch) && batch.every((u) => u.shape === "dot"),
    );
    expect(dotCalls.length).toBe(1);
    expect(dotCalls[0][0].length).toBe(LARGE_GRAPH_NODE_THRESHOLD + 10);
  });

  it("restores full circularImage fields (not just shape) after the idle delay", () => {
    State.graphNodes = bigGraphNodes(LARGE_GRAPH_NODE_THRESHOLD + 5);
    State.network = {};
    pokeFastRenderMode();
    State.nodesDS.update.mockClear();

    vi.advanceTimersByTime(500);

    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);
    const restored = State.nodesDS.update.mock.calls[0][0];
    expect(restored.length).toBe(LARGE_GRAPH_NODE_THRESHOLD + 5);
    for (const u of restored) {
      expect(u.shape).toBe("circularImage");
      expect(typeof u.image).toBe("string");
      expect(typeof u.brokenImage).toBe("string");
    }
  });

  it("each poke during an ongoing interaction pushes the exit further out", () => {
    State.graphNodes = bigGraphNodes(LARGE_GRAPH_NODE_THRESHOLD + 5);
    State.network = {};
    pokeFastRenderMode();
    State.nodesDS.update.mockClear();

    vi.advanceTimersByTime(150);
    pokeFastRenderMode();
    vi.advanceTimersByTime(150);
    expect(State.nodesDS.update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);
  });

  it("resetFastRenderMode lets a fresh graph re-enter fast mode immediately", () => {
    State.graphNodes = bigGraphNodes(LARGE_GRAPH_NODE_THRESHOLD + 5);
    State.network = {};
    pokeFastRenderMode();
    State.nodesDS.update.mockClear();

    resetFastRenderMode();
    pokeFastRenderMode();

    const dotCalls = State.nodesDS.update.mock.calls.filter(
      ([batch]) => Array.isArray(batch) && batch.every((u) => u.shape === "dot"),
    );
    expect(dotCalls.length).toBe(1);
  });
});

describe("scheduleFreeze", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    State.physicsTimer = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns physics off once the settle window elapses", () => {
    State.network = { setOptions: vi.fn() };

    scheduleFreeze(500);
    expect(State.network.setOptions).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect(State.network.setOptions).toHaveBeenCalledWith({ physics: { enabled: false } });
    expect(State.physicsTimer).toBeNull();
  });

  it("restarts the window when called again, rather than freezing early", () => {
    State.network = { setOptions: vi.fn() };

    scheduleFreeze(500);
    vi.advanceTimersByTime(400);
    scheduleFreeze(500);
    vi.advanceTimersByTime(400);

    expect(State.network.setOptions).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(State.network.setOptions).toHaveBeenCalled();
  });

  it("does not blow up when the graph was torn down before it fired", () => {
    State.network = { setOptions: vi.fn() };
    scheduleFreeze(100);
    State.network = null;

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
  });
});

describe("updateEdgeRenderMode", () => {
  it("keeps edges smooth", () => {
    State.network = { setOptions: vi.fn() };

    updateEdgeRenderMode();

    expect(State.network.setOptions).toHaveBeenCalledWith({
      edges: { smooth: expect.objectContaining({ enabled: true }) },
    });
  });

  it("does nothing without a rendered network", () => {
    State.network = null;
    expect(() => updateEdgeRenderMode()).not.toThrow();
  });
});

describe("_fitToExpandedCluster", () => {
  beforeEach(() => {
    State.expandedNodes = new Set();
  });

  it("frames the most recently expanded node and its neighbours", () => {
    State.expandedNodes = new Set([1, 2]);
    State.network = { getConnectedNodes: vi.fn(() => [3, 4]), fit: vi.fn() };

    _fitToExpandedCluster();

    expect(State.network.getConnectedNodes).toHaveBeenCalledWith(2);
    expect(State.network.fit).toHaveBeenCalledWith(expect.objectContaining({ nodes: [2, 3, 4] }));
  });

  it("caps how many nodes it tries to frame", () => {
    State.expandedNodes = new Set([1]);
    State.network = {
      getConnectedNodes: vi.fn(() => Array.from({ length: 100 }, (_, i) => i + 10)),
      fit: vi.fn(),
    };

    _fitToExpandedCluster();

    expect(State.network.fit.mock.calls[0][0].nodes).toHaveLength(40);
  });

  it("does nothing when nothing has been expanded", () => {
    State.network = { getConnectedNodes: vi.fn(), fit: vi.fn() };

    _fitToExpandedCluster();

    expect(State.network.fit).not.toHaveBeenCalled();
  });

  it("does nothing without a rendered network", () => {
    State.expandedNodes = new Set([1]);
    State.network = null;

    expect(() => _fitToExpandedCluster()).not.toThrow();
  });

  it("swallows a camera error rather than breaking the expansion", () => {
    State.expandedNodes = new Set([1]);
    State.network = {
      getConnectedNodes: () => [2],
      fit: () => {
        throw new Error("nope");
      },
    };

    expect(() => _fitToExpandedCluster()).not.toThrow();
  });
});
