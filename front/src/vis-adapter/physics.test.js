// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/physics.test.js — SF-WEB-09: runFlyoutAnimation smooth-expand
//                                 unit tests. Drives the RAF loop manually via
//                                 a stubbed requestAnimationFrame — no real
//                                 vis.Network involved, State.network is a
//                                 minimal { body.nodes, moveNode, redraw } stub
//                                 matching the shape runFlyoutAnimation reads.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State } from "../state/state.js";
import { runFlyoutAnimation, nudgePhysics, mergeNetwork } from "./physics.js";
import { LARGE_GRAPH_NODE_THRESHOLD } from "./visuals.js";

function mockNetwork(ids) {
  const nodes = {};
  for (const id of ids) nodes[id] = { x: 0, y: 0 };
  return {
    body: { nodes },
    redraw: vi.fn(),
    moveNode: vi.fn((id, x, y) => { nodes[id] = { x, y }; }),
  };
}

let rafCallbacks;
function flushFrame(ts) {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  cbs.forEach(cb => cb(ts));
}

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", cb => { rafCallbacks.push(cb); return rafCallbacks.length; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  State.nodesDS = { update: vi.fn() };
  State._expandAnimId = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runFlyoutAnimation", () => {
  it("calls onDone exactly once and lands nodes exactly on targets", () => {
    const ids = [1, 2];
    const fromPos = new Map([[1, { x: 0, y: 0 }], [2, { x: 10, y: 10 }]]);
    const targets = new Map([[1, { x: 100, y: 50 }], [2, { x: -20, y: 30 }]]);
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

    runFlyoutAnimation({ ids, fromPos, targets, durationMs: 100, entranceTargets, onDone: () => {} });

    flushFrame(0);
    flushFrame(300); // past both durationMs and ENTRANCE_MS in one frame

    const finalUpdate = State.nodesDS.update.mock.calls
      .map(([batch]) => batch.find(u => u.id === 1))
      .filter(Boolean)
      .pop();
    expect(finalUpdate).toEqual({ id: 1, size: 22, opacity: 1 });
  });
});

// SF-WEB-07
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
    State.graphNodes = Array.from({ length: LARGE_GRAPH_NODE_THRESHOLD + 1 }, (_, i) => ({ id: i }));
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
    State.graphNodes = Array.from({ length: LARGE_GRAPH_NODE_THRESHOLD + 1 }, (_, i) => ({ id: i }));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    nudgePhysics(1500);
    const [, delay] = setTimeoutSpy.mock.calls.at(-1);
    vi.advanceTimersByTime(delay);

    expect(State.network.setOptions).toHaveBeenCalledWith({ physics: { enabled: false } });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-29] mergeNetwork's post-flyout phase no longer re-enables live
// physics for expand — layout.js's targets are already a correct,
// non-overlapping dandelion+Euler-zone layout, so every node is fixed
// exactly where the flyout landed it, with no barnesHut settle window in
// between that could shift it off-target.
// ════════════════════════════════════════════════════════════════════════════
describe("mergeNetwork — expand lands nodes exactly on targets, no live physics", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true })); // reduced-motion: synchronous flyout, no RAF loop to flush
    State._expandAnimId = null;
    State.physicsTimer = null;

    const seedId = 1, poleId = 2, leafA = 100, leafB = 101;
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
      body: { nodes: {} }, // absent per-id entries -> _fastMoveNode falls back to moveNode
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

    const enabledTrueCalls = State.network.setOptions.mock.calls
      .filter(([opts]) => opts?.physics?.enabled === true);
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
      .find(batch =>
        Array.isArray(batch) &&
        batch.length === 4 &&
        batch.every(u => u.fixed && u.fixed.x === true && u.fixed.y === true)
      );
    expect(fixCall).toBeTruthy();
    const fixedIds = fixCall.map(u => u.id).sort((a, b) => a - b);
    expect(fixedIds).toEqual([1, 2, 100, 101]);
  });

  it("does not schedule any settle/freeze timer for the expand case", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mergeNetwork({}, {});
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

// [SF-WEB-47 motion] mergeNetwork's flyout used to hardcode durationMs:420 —
// now MOTION.flight, read live from --duration-flight. Proven behaviorally
// (not just by inspecting the source): shrink the token to something the
// old hardcoded 420ms would never finish within, and confirm the flyout
// completes anyway.
describe("mergeNetwork — flyout duration comes from MOTION.flight, not a hardcoded literal", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false })); // real RAF flyout, not the reduced-motion shortcut
    State._expandAnimId = null;
    State.physicsTimer = null;

    const seedId = 1, poleId = 2, leafA = 100;
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
      setOptions: vi.fn(), moveNode: vi.fn(), moveTo: vi.fn(), redraw: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty("--duration-flight");
  });

  it("finishes (fires onDone's fixAll) within a token-shrunk duration the old hardcoded 420ms never would have", () => {
    document.documentElement.style.setProperty("--duration-flight", "50ms");
    mergeNetwork({}, {});

    flushFrame(0);   // t0
    flushFrame(60);  // elapsed=60ms > the 50ms token -> pct clamps to 1, flyout completes;
                      // with the old hardcoded 420ms this would only be 14% through.
    const fixCall = State.nodesDS.update.mock.calls
      .map(([batch]) => batch)
      .find(batch => Array.isArray(batch) && batch.length && batch.every(u => u.fixed));
    expect(fixCall).toBeTruthy();
  });
});
