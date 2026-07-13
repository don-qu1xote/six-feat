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
import { runFlyoutAnimation, nudgePhysics } from "./physics.js";
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
