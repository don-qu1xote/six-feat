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
import { runFlyoutAnimation, nudgePhysics, mergeNetwork, pokeFastRenderMode, resetFastRenderMode } from "./physics.js";
import { LARGE_GRAPH_NODE_THRESHOLD } from "./visuals.js";
import { placeExpandedNodes } from "./layout.js";

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
  // [SF-WEB-62] "сделай анимацию экспандеда... плавнее" — the flyout used
  // pure ease-OUT (maximum velocity right at t=0 — an instant "snap" start,
  // only the landing was ever eased). Switched to ease-IN-out: a node's
  // progress well before the midpoint should now be well under half its
  // total distance travelled (a gentle ramp-up), unlike the old pure
  // ease-out curve which was already well past half by then.
  // [SF-WEB-63] "золотой стандарт по анимациям... как у больших сервисов" —
  // Material Design's own "standard" motion curve, cubic-bezier(0.4, 0, 0.2,
  // 1): a SHORT ease-in (not an instant full-speed snap) into a long, gentle
  // deceleration. Neither extreme SF-WEB-62 swung through: pure ease-out
  // (1-(1-t)^3) is already 57.8% of the way there by t=0.25 (a snap);
  // ease-in-out is only 6.25% of the way there at the same point (reported
  // as "provisaem" — sagging/laggish). This curve sits between the two —
  // clearly past a snap, nowhere near sluggish.
  it("uses a short-ease-in, long-decelerate curve — neither an instant snap nor a sluggish drag", () => {
    const ids = [1];
    const fromPos = new Map([[1, { x: 0, y: 0 }]]);
    const targets = new Map([[1, { x: 1000, y: 0 }]]);
    State.network = mockNetwork(ids);

    runFlyoutAnimation({ ids, fromPos, targets, durationMs: 1000, onDone: () => {} });
    flushFrame(0);
    flushFrame(250); // 25% through the flight's duration

    const x = State.network.body.nodes[1].x;
    expect(x).toBeGreaterThan(150);  // meaningfully past ease-in-out's ~62px — no sag
    expect(x).toBeLessThan(400);     // meaningfully short of pure ease-out's ~578px — no snap
  });

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

  // [SF-WEB-61] "придумай что-нибудь с плавностью и новыми анимациями" —
  // staggered bloom: multiple new leaves must NOT all reach their final
  // size/opacity on the same frame — later-inserted entranceTargets start
  // (and finish) their own bloom a little later, rippling in rather than
  // popping in unison.
  it("staggers multiple new nodes' bloom instead of blooming them all in unison", () => {
    const ids = [1, 2];
    const fromPos = new Map([[1, { x: 0, y: 0 }], [2, { x: 0, y: 0 }]]);
    const targets = new Map([[1, { x: 0, y: 0 }], [2, { x: 0, y: 0 }]]);
    const entranceTargets = new Map([
      [1, { size: 22, opacity: 1 }],
      [2, { size: 22, opacity: 1 }],
    ]);
    State.network = mockNetwork(ids);

    runFlyoutAnimation({ ids, fromPos, targets, durationMs: 500, entranceTargets, onDone: () => {} });

    flushFrame(0);
    flushFrame(10); // early — node 1 (no delay) has started blooming, node 2 (staggered) hasn't caught up yet

    const batch = State.nodesDS.update.mock.calls
      .map(([b]) => b)
      .filter(b => b.some(u => u.id === 1) && b.some(u => u.id === 2))
      .pop(); // latest batch (frame at ts=10), not the ts=0 one where nothing has bloomed yet
    expect(batch).toBeTruthy();
    const u1 = batch.find(u => u.id === 1);
    const u2 = batch.find(u => u.id === 2);
    expect(u1.size).toBeGreaterThan(u2.size);
    expect(u1.opacity).toBeGreaterThan(u2.opacity);
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

  // [SF-WEB-51] The flyout's final positions ARE the collision-solved engine
  // targets — nothing drifts them afterwards (physics is demoted). Under
  // reduced-motion the flyout is synchronous, so moveNode lands each node on
  // exactly the coordinate placeExpandedNodes computed for it.
  it("lands every node on exactly its collision-solved placeExpandedNodes target (no post-drift)", () => {
    // Independently compute what the engine will produce for this same State.
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

  // [SF-WEB-55/56] Native vis.js edges stay in the DataSet (hit-testing/
  // hover/selectEdge keep working) but their own color renders nothing —
  // the custom canvas layer (edge-render.js) is the only thing drawing
  // visible edge graphics now. Strengthened beyond a bare opacity:0 check —
  // the original SF-WEB-55 version only zeroed color.opacity, which
  // highlight.js's own hover/selection color writes (a SEPARATE, later
  // edgesDS.update() with its own {color:{color,opacity:1}}) could still
  // make visible again, producing exactly the "two edges" (native straight
  // line + our arc) visual bug reported against the live app.
  // suppressNativeEdgeColor() now also forces a fully-transparent color
  // string and zeroes the hover/highlight sub-objects too — belt and
  // suspenders against however vis.js actually resolves edge alpha
  // internally.
  it("adds every new edge fully invisible (opacity:0, transparent color, hover/highlight zeroed too)", () => {
    mergeNetwork({}, {});

    const addCall = State.edgesDS.add.mock.calls.find(([batch]) => Array.isArray(batch) && batch.length);
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
    // Guard against test pollution leaking into later files in this run.
    clearEdgeCache();
  });

  // [SF-WEB-62] "в файнд пафе рёбра при экспандеде пропали" — an edge that
  // was ALREADY in the DataSet before this mergeNetwork call (exactly what
  // initPathNetwork's own path-mode edges are: added with full native
  // visible color, no custom canvas layer involved) must ALSO get its
  // native color suppressed once THIS expand's edgeClass now covers it —
  // otherwise it's drawn twice (native line + our own curved one at a
  // different offset), which read as broken/missing in the live app.
  it("also suppresses the native color of an edge that already existed in the DataSet before this expand", () => {
    const preexistingEdgeId = `${State.currentSeedId}_${2}`; // seed<->poleId edge, already in edgesDS per this describe's own beforeEach
    State.edgesDS.getIds = () => [preexistingEdgeId];
    State.edgesDS.update = vi.fn();

    mergeNetwork({}, {});

    const suppressUpd = State.edgesDS.update.mock.calls
      .flatMap(([arg]) => Array.isArray(arg) ? arg : [arg])
      .find(u => u.id === preexistingEdgeId);
    expect(suppressUpd).toBeTruthy();
    expect(suppressUpd.color.opacity).toBe(0);
    expect(suppressUpd.color.color).toBe("rgba(0,0,0,0)");
  });

  // [SF-WEB-62] "сохранять подсветку пути при экспанде" — existingUpdates
  // resets EVERY node back to nodeVisual's plain resting look, which used
  // to silently drop an active path highlight even though
  // State.pathHighlight itself still held the path.
  it("re-applies the active path highlight after an expand instead of silently dropping it", async () => {
    const { COLOR } = await import("../state/state.js");
    State.pathHighlight = [State.currentSeedId, 2]; // seedId, poleId — both already in the graph

    mergeNetwork({}, {});

    const onPathUpd = State.nodesDS.update.mock.calls
      .flatMap(([arg]) => Array.isArray(arg) ? arg : [arg])
      .find(u => u.id === 2 && u.color?.border === COLOR.neon);
    expect(onPathUpd).toBeTruthy();

    State.pathHighlight = null;
  });

  // [SF-WEB-70] Same gap as pathHighlight above, never reported under that
  // name — existingUpdates resets EVERY existing node's color/border back
  // to nodeVisual's plain resting look, silently dropping a persistently
  // FOCUSED node's highlight (State.focusedNodeId, set by setFocus in
  // events.js — visually the same "hover-style" accent border/image
  // highlightNeighborhood always used, just held persistently rather than
  // reverted on blur) on any expand. This also drives the node's incident
  // edges' colour (getSelectedNodeEdgeIds()/_hoverNodeEdgeUpdates, read
  // live by edge-render.js) — a dropped node focus here plausibly reads as
  // "edge highlighting broken" too.
  it("re-applies the focused node's highlight after an expand instead of silently dropping it", async () => {
    // highlightNeighborhood's persistent-look write is rAF-debounced (SF-WEB-34)
    // — needs edgesDS.get for the node's incident-edge glow (_hoverNodeEdgeUpdates).
    State.edgesDS.get = () => null;
    State.focusedNodeId = 2; // poleId — already in the graph, per this describe's own beforeEach

    try {
      mergeNetwork({}, {});
      // Before the flush, existingUpdates already painted node 2's PLAIN
      // resting look (no circularImage shape — that's hover-only).
      const plainUpd = State.nodesDS.update.mock.calls
        .flatMap(([arg]) => Array.isArray(arg) ? arg : [arg])
        .find(u => u.id === 2);
      expect(plainUpd.shape).toBeUndefined();

      flushFrame(0);

      // highlightNeighborhood's hover-style update (_hoverNodeUpdateFor)
      // is the only one that sets shape:"circularImage" — its presence
      // AFTER the flush proves the focus was re-applied, not left dropped.
      const focusUpd = State.nodesDS.update.mock.calls
        .flatMap(([arg]) => Array.isArray(arg) ? arg : [arg])
        .find(u => u.id === 2 && u.shape === "circularImage");
      expect(focusUpd).toBeTruthy();
    } finally {
      State.focusedNodeId = null;
    }
  });
});

// [SF-WEB-61] "при каждом появлении новой экспандед ноды у нас отезжает
// экран... нужно делать фокус на новый экспандед а не оттдалять камеру" —
// the camera used to fit the WHOLE graph's targets (every pole/leaf ever
// placed) centered on the seed, so its zoom level only ever shrank as the
// graph grew across expands, regardless of where the just-expanded node
// actually was. It must now fit THIS expand's own new content (the hub +
// its brand-new children), not the graph's full historical extent.
describe("mergeNetwork — camera focuses on the just-expanded node's own new content (SF-WEB-61)", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true })); // reduced-motion: synchronous flyout
    State._expandAnimId = null;
    State.physicsTimer = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("centers the camera near the just-expanded node, not at the seed's (0,0), when far-off older content exists", () => {
    const seedId = 1, oldPole = 2, oldLeaf = 100, newPole = 3, newLeaf = 200;
    State.currentSeedId = seedId;
    // oldPole was expanded in a PRIOR call — already far from the seed, and
    // its position is what the old whole-graph-fit logic would have kept
    // basing the camera's scale on.
    State.expandedNodes = new Set([oldPole, newPole]);
    State.lastExpandedId = newPole;  // THIS call is expanding newPole
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
    State.nodesDS = { getIds: () => [seedId, oldPole, oldLeaf, newPole], add: vi.fn(), update: vi.fn() };
    State.edgesDS = { getIds: () => [`${seedId}_${oldPole}`, `${oldPole}_${oldLeaf}`, `${seedId}_${newPole}`], add: vi.fn(), update: vi.fn() };
    State.network = {
      body: { nodes: {} },
      setOptions: vi.fn(), moveNode: vi.fn(), moveTo: vi.fn(), redraw: vi.fn(),
    };

    const { targets } = placeExpandedNodes({});
    // Sanity: oldPole really is far from newPole in this layout — otherwise
    // the test wouldn't distinguish "fit everything" from "fit new content".
    const oldPos = targets.get(oldPole), newPos = targets.get(newPole);
    expect(Math.hypot(oldPos.x - newPos.x, oldPos.y - newPos.y)).toBeGreaterThan(100);

    mergeNetwork({}, {});

    const moveToCall = State.network.moveTo.mock.calls.at(-1)[0];
    const distToNew = Math.hypot(moveToCall.position.x - newPos.x, moveToCall.position.y - newPos.y);
    const distToOld = Math.hypot(moveToCall.position.x - oldPos.x, moveToCall.position.y - oldPos.y);
    expect(distToNew).toBeLessThan(distToOld);
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

// [SF-WEB-54] FAST RENDER MODE — pan/zoom on graphs bigger than
// LARGE_GRAPH_NODE_THRESHOLD swaps nodes to cheap "dot" shape while the
// interaction is active, restoring circularImage once it goes idle.
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

    const dotCalls = State.nodesDS.update.mock.calls.filter(([batch]) =>
      Array.isArray(batch) && batch.every(u => u.shape === "dot"));
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
    pokeFastRenderMode(); // still mid-interaction — pushes the idle timer out again
    vi.advanceTimersByTime(150);
    // 300ms of wall time since entry, but never 220ms uninterrupted — no exit yet.
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

    const dotCalls = State.nodesDS.update.mock.calls.filter(([batch]) =>
      Array.isArray(batch) && batch.every(u => u.shape === "dot"));
    expect(dotCalls.length).toBe(1);
  });
});
