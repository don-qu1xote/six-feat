import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph.js", () => ({ replaceGraph: vi.fn() }));

import { replaceGraph } from "../graph.js";
import { State, setGameMode } from "../state/state.js";
import { els } from "../dom/dom.js";
import { isGameModeActive } from "../vis-adapter/game-mode.js";
import { mountBoard, unmountBoard, renderBoard, zoomBoard, fitBoard } from "./game-board.js";

const GAME = {
  start: "Drake",
  goal: "Adele",
  focus: "Drake",
  completed: false,
  nodes: [{ name: "Drake", parent: null }],
};

const clickNode = (params) => State.game.clickRouter(params);

beforeEach(() => {
  replaceGraph.mockClear();
  setGameMode(false);
  State.network = null;
  State.nodesDS = null;
  const home = document.createElement("div");
  els.network = document.createElement("div");
  home.appendChild(els.network);
});

describe("game mode (restriction) + #network relocation", () => {
  it("mountBoard turns on game mode, installs the click router, and moves #network into the column", () => {
    const col = document.createElement("div");
    mountBoard(col);
    expect(isGameModeActive()).toBe(true);
    expect(typeof State.game.clickRouter).toBe("function");
    expect(els.network.parentElement).toBe(col);
  });

  it("unmountBoard drops game mode and hands #network back home", () => {
    const home = els.network.parentElement;
    mountBoard(document.createElement("div"));
    unmountBoard();
    expect(isGameModeActive()).toBe(false);
    expect(State.game.clickRouter).toBeNull();
    expect(els.network.parentElement).toBe(home);
  });

  it("a second mount while already in game mode still returns #network home on exit", () => {
    const home = els.network.parentElement;
    mountBoard(document.createElement("div"));
    mountBoard(document.createElement("div"));
    unmountBoard();
    expect(els.network.parentElement).toBe(home);
  });
});

describe("renderBoard drives the real replaceGraph pipeline", () => {
  it("is a no-op unless mounted in game mode", () => {
    renderBoard(GAME, {}, null, {}, {});
    expect(replaceGraph).not.toHaveBeenCalled();
  });

  it("feeds an id-based graph: start seed + goal pole", () => {
    mountBoard(document.createElement("div"));
    renderBoard(GAME, {}, null, { Drake: 100, Adele: 900 }, {});
    expect(replaceGraph).toHaveBeenCalledTimes(1);
    const g = replaceGraph.mock.calls[0][0];
    expect(g.seedId).toBe(100);
    expect(g.nodes.some((n) => n.id === 100 && n.name === "Drake")).toBe(true);
    expect(g.nodes.some((n) => n.id === 900 && n.name === "Adele")).toBe(true);
  });

  it("[SF-GAME-42] НЕ кладёт ребро-прицел в DataSet — оно стягивало полюса", () => {
    mountBoard(document.createElement("div"));
    renderBoard(GAME, {}, null, { Drake: 100, Adele: 900 }, {});
    const g = replaceGraph.mock.calls[0][0];
    expect(g.nodes.some((n) => n.id === 900)).toBe(true);
    expect(
      g.edges.some((e) => (e.from === 100 && e.to === 900) || (e.from === 900 && e.to === 100)),
    ).toBe(false);
  });

  it("[SF-GAME-34 / ADR-0009] never invents an id — an unresolved name is simply not drawn", () => {
    mountBoard(document.createElement("div"));
    renderBoard(GAME, {}, null, { Drake: 100 }, {});
    const g = replaceGraph.mock.calls[0][0];
    expect(g.nodes.every((n) => n.id > 0)).toBe(true);
    expect(g.nodes.map((n) => n.id)).toEqual([100]);
    expect(g.edges).toEqual([]);
  });

  it("[SF-GAME-34] skips the frame entirely when nothing is resolved yet", () => {
    mountBoard(document.createElement("div"));
    renderBoard(GAME, {}, null, {}, {});
    expect(replaceGraph).not.toHaveBeenCalled();
  });

  it("adds the focus's real collaborators as dandelion nodes", () => {
    mountBoard(document.createElement("div"));
    const frontier = { loading: false, neighbours: [{ id: 200, name: "SZA", image: null }] };
    renderBoard(GAME, {}, frontier, { Drake: 100, Adele: 900 }, {});
    const g = replaceGraph.mock.calls[0][0];
    expect(g.nodes.some((n) => n.id === 200 && n.name === "SZA")).toBe(true);
    expect(g.edges.some((e) => e.from === 100 && e.to === 200)).toBe(true);
  });

  it("не рисует одуванчик, когда партия окончена", () => {
    const frontier = { loading: false, neighbours: [{ id: 200, name: "SZA", image: null }] };
    for (const done of [{ completed: true }, { gaveUp: true }]) {
      replaceGraph.mockClear();
      unmountBoard();
      mountBoard(document.createElement("div"));
      const over = {
        ...GAME,
        ...done,
        nodes: [
          { name: "Drake", parent: null },
          { name: "Adele", parent: "Drake" },
        ],
      };
      renderBoard(over, {}, frontier, { Drake: 100, Adele: 900 }, {});
      const g = replaceGraph.mock.calls[0][0];
      expect(g.nodes.some((n) => n.id === 200)).toBe(false);
      expect(g.nodes.map((n) => n.id).sort()).toEqual([100, 900]);
    }
  });
});

describe("restricted click routing (State.game.clickRouter)", () => {
  it("routes a dandelion click to onPick, the goal target to onReachGoal, a web node to onFocus", () => {
    mountBoard(document.createElement("div"));
    const onPick = vi.fn(),
      onFocus = vi.fn(),
      onReachGoal = vi.fn();
    const frontier = { loading: false, neighbours: [{ id: 200, name: "SZA", image: null }] };
    renderBoard(GAME, {}, frontier, { Drake: 100, Adele: 900 }, { onPick, onFocus, onReachGoal });

    clickNode({ nodes: [200] });
    expect(onPick).toHaveBeenCalledWith({ id: 200, name: "SZA", image: null });

    clickNode({ nodes: [900] });
    expect(onReachGoal).toHaveBeenCalledTimes(1);

    clickNode({ nodes: [100] });
    expect(onFocus).toHaveBeenCalledWith("Drake");

    clickNode({ nodes: [] });
  });
});

describe("buildGraph — what ends up on the board", () => {
  const IDS = { Drake: 1, Adele: 2, Future: 3, Sia: 4 };
  let col;

  beforeEach(() => {
    col = document.createElement("div");
    mountBoard(col);
  });

  const rendered = () => replaceGraph.mock.calls.at(-1)[0];

  it("adds the goal as its own target node while it is not yet in the web", () => {
    renderBoard({ ...GAME }, {}, null, IDS, {});

    const names = rendered().nodes.map((n) => n.name);
    expect(names).toContain("Adele");
    expect(rendered().seed).toBe("Drake");
    expect(rendered().seedId).toBe(1);
  });

  it("does not duplicate the goal once it is part of the chain", () => {
    renderBoard(
      { ...GAME, nodes: [{ name: "Drake" }, { name: "Adele", parent: "Drake" }] },
      {},
      null,
      IDS,
      {},
    );

    expect(rendered().nodes.filter((n) => n.name === "Adele")).toHaveLength(1);
  });

  it("skips a node the backend could not give an id for", () => {
    renderBoard({ ...GAME, nodes: [{ name: "Drake" }, { name: "Unknown" }] }, {}, null, IDS, {});

    expect(rendered().nodes.map((n) => n.name)).not.toContain("Unknown");
  });

  it("attaches artist photos when they are known", () => {
    renderBoard({ ...GAME }, { Drake: "http://img/d.jpg" }, null, IDS, {});

    expect(rendered().nodes.find((n) => n.name === "Drake").image).toBe("http://img/d.jpg");
  });

  it("offers the frontier neighbours as pickable nodes", () => {
    renderBoard({ ...GAME }, {}, { neighbours: [{ id: 3, name: "Future" }] }, IDS, {});

    expect(rendered().nodes.map((n) => n.name)).toContain("Future");
  });

  it("caps the frontier so the board stays readable", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, name: `N${i}` }));
    renderBoard({ ...GAME }, {}, { neighbours: many }, IDS, {});

    expect(rendered().nodes.filter((n) => n.name.startsWith("N"))).toHaveLength(8);
  });

  it("never offers an artist already in the chain as a fresh pick", () => {
    renderBoard({ ...GAME }, {}, { neighbours: [{ id: 1, name: "drake" }] }, IDS, {});

    expect(rendered().nodes.filter((n) => n.name === "drake")).toHaveLength(0);
  });

  it("never offers the goal itself as an ordinary neighbour", () => {
    renderBoard({ ...GAME }, {}, { neighbours: [{ id: 2, name: "adele" }] }, IDS, {});

    expect(rendered().nodes.filter((n) => n.name === "adele")).toHaveLength(0);
  });

  it("hides the frontier once the round is over", () => {
    for (const over of [{ completed: true }, { gaveUp: true }]) {
      replaceGraph.mockClear();
      unmountBoard();
      mountBoard(col);
      renderBoard({ ...GAME, ...over }, {}, { neighbours: [{ id: 3, name: "Future" }] }, IDS, {});

      expect(rendered().nodes.map((n) => n.name)).not.toContain("Future");
    }
  });

  it("shows no frontier while it is still loading or unavailable", () => {
    for (const frontier of [
      { loading: true, neighbours: [{ id: 3, name: "Future" }] },
      { unavailable: true, neighbours: [{ id: 3, name: "Future" }] },
      { neighbours: null },
    ]) {
      replaceGraph.mockClear();
      unmountBoard();
      mountBoard(col);
      renderBoard({ ...GAME }, {}, frontier, IDS, {});

      expect(rendered().nodes.map((n) => n.name)).not.toContain("Future");
    }
  });

  it("links each frontier pick to the artist currently in focus", () => {
    renderBoard(
      { ...GAME, focus: "Drake" },
      {},
      { neighbours: [{ id: 3, name: "Future" }] },
      IDS,
      {},
    );

    expect(rendered().edges).toContainEqual({ from: 1, to: 3 });
  });

  it("renders nothing when not a single node could be resolved", () => {
    replaceGraph.mockClear();
    renderBoard({ ...GAME, start: "X", goal: "Y", nodes: [{ name: "X" }] }, {}, null, {}, {});

    expect(replaceGraph).not.toHaveBeenCalled();
  });

  it("clears its cached game when told to render nothing", () => {
    renderBoard({ ...GAME }, {}, null, IDS, {});
    replaceGraph.mockClear();

    renderBoard(null, {}, null, IDS, {});

    expect(replaceGraph).not.toHaveBeenCalled();
  });
});

describe("node clicks route to the right callback", () => {
  const IDS = { Drake: 1, Adele: 2, Future: 3 };
  let cbs;

  beforeEach(() => {
    cbs = { onPick: vi.fn(), onFocus: vi.fn(), onReachGoal: vi.fn() };
    mountBoard(document.createElement("div"));
    renderBoard({ ...GAME }, {}, { neighbours: [{ id: 3, name: "Future" }] }, IDS, cbs);
  });

  it("claims the goal when the goal target is clicked", () => {
    clickNode({ nodes: [2] });
    expect(cbs.onReachGoal).toHaveBeenCalled();
  });

  it("picks a frontier neighbour", () => {
    clickNode({ nodes: [3] });
    expect(cbs.onPick).toHaveBeenCalledWith(expect.objectContaining({ name: "Future" }));
  });

  it("refocuses an artist already in the chain", () => {
    clickNode({ nodes: [1] });
    expect(cbs.onFocus).toHaveBeenCalledWith("Drake");
  });

  it("ignores a click on empty canvas", () => {
    clickNode({ nodes: [] });
    clickNode({});
    clickNode(undefined);

    expect(cbs.onPick).not.toHaveBeenCalled();
    expect(cbs.onFocus).not.toHaveBeenCalled();
  });

  it("ignores a click on a node the board does not know", () => {
    clickNode({ nodes: [999] });
    expect(cbs.onFocus).not.toHaveBeenCalled();
  });
});

describe("layout and camera", () => {
  const IDS = { Drake: 1, Adele: 2 };

  beforeEach(() => {
    mountBoard(document.createElement("div"));
  });

  it("positions and pins every node it laid out", () => {
    State.nodesDS = { length: 0, update: vi.fn() };
    renderBoard({ ...GAME }, {}, null, IDS, {});

    expect(State.nodesDS.update).toHaveBeenCalled();
    // Первый update — раскладка, второй уже перекрашивание ролей.
    const updates = State.nodesDS.update.mock.calls[0][0];
    expect(updates[0]).toMatchObject({ fixed: true, physics: false });
  });

  it("also nudges the live network so the pinned positions take effect", () => {
    State.nodesDS = { length: 0, update: vi.fn() };
    State.network = { moveNode: vi.fn(), on: vi.fn(), fit: vi.fn() };

    renderBoard({ ...GAME }, {}, null, IDS, {});

    expect(State.network.moveNode).toHaveBeenCalled();
  });

  it("survives a dataset that rejects the update", () => {
    State.nodesDS = {
      length: 0,
      update: () => {
        throw new Error("nope");
      },
    };

    expect(() => renderBoard({ ...GAME }, {}, null, IDS, {})).not.toThrow();
  });

  it("skips positioning entirely when there is no dataset yet", () => {
    State.nodesDS = null;
    expect(() => renderBoard({ ...GAME }, {}, null, IDS, {})).not.toThrow();
  });

  it("gives up quietly when the graph itself refuses to render", () => {
    replaceGraph.mockImplementationOnce(() => {
      throw new Error("render failed");
    });

    expect(() => renderBoard({ ...GAME }, {}, null, IDS, {})).not.toThrow();
  });
});

describe("zoomBoard / fitBoard", () => {
  it("scales the camera by the given factor", () => {
    State.network = { getScale: () => 2, moveTo: vi.fn() };

    zoomBoard(1.5);

    expect(State.network.moveTo).toHaveBeenCalledWith(expect.objectContaining({ scale: 3 }));
  });

  it("does nothing without a rendered network", () => {
    State.network = null;
    expect(() => zoomBoard(1.5)).not.toThrow();
    expect(() => fitBoard()).not.toThrow();
  });

  it("swallows a camera error rather than breaking the round", () => {
    State.network = {
      getScale: () => 1,
      moveTo: () => {
        throw new Error("nope");
      },
      fit: () => {
        throw new Error("nope");
      },
    };

    expect(() => zoomBoard(2)).not.toThrow();
    expect(() => fitBoard()).not.toThrow();
  });

  it("fits the board to the viewport when asked", () => {
    State.network = { fit: vi.fn() };
    fitBoard();
    expect(State.network.fit).toHaveBeenCalled();
  });
});

describe("ring guides and aim line", () => {
  const IDS = { Drake: 1, Adele: 2 };

  function fakeCtx() {
    return {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      strokeStyle: "",
      lineWidth: 0,
    };
  }

  function networkWithHook() {
    const handlers = {};
    return {
      on: (evt, cb) => {
        (handlers[evt] ||= []).push(cb);
      },
      handlers,
      fit: vi.fn(),
      moveNode: vi.fn(),
      getPositions: vi.fn(() => ({ 1: { x: 0, y: 0 }, 2: { x: 50, y: 50 } })),
      DOMtoCanvas: vi.fn(({ x, y }) => ({ x, y })),
      canvas: { frame: { canvas: { clientWidth: 800, clientHeight: 600 } } },
    };
  }

  beforeEach(() => {
    mountBoard(document.createElement("div"));
    State.nodesDS = { length: 0, update: vi.fn() };
  });

  const paint = (net, ctx) => net.handlers.beforeDrawing.forEach((h) => h(ctx));

  it("rings the goal while it is not yet part of the chain", () => {
    const net = networkWithHook();
    State.network = net;
    renderBoard({ ...GAME }, {}, null, IDS, {});

    const ctx = fakeCtx();
    paint(net, ctx);

    expect(ctx.arc).toHaveBeenCalled();
  });

  it("stops ringing the goal once it has been reached", () => {
    const net = networkWithHook();
    State.network = net;
    renderBoard(
      { ...GAME, nodes: [{ name: "Drake" }, { name: "Adele", parent: "Drake" }] },
      {},
      null,
      IDS,
      {},
    );

    const ctx = fakeCtx();
    paint(net, ctx);

    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it("draws an aim line from the focused artist toward the goal", () => {
    const net = networkWithHook();
    State.network = net;
    renderBoard({ ...GAME, focus: "Drake" }, {}, null, IDS, {});

    const ctx = fakeCtx();
    paint(net, ctx);

    expect(ctx.moveTo).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalled();
  });

  it("draws no aim line when nothing is focused", () => {
    const net = networkWithHook();
    State.network = net;
    renderBoard({ ...GAME, focus: null }, {}, null, IDS, {});

    const ctx = fakeCtx();
    paint(net, ctx);

    expect(ctx.moveTo).not.toHaveBeenCalled();
  });

  it("survives vis refusing to report positions mid-paint", () => {
    const net = networkWithHook();
    net.getPositions = () => {
      throw new Error("not ready");
    };
    State.network = net;
    renderBoard({ ...GAME }, {}, null, IDS, {});

    const ctx = fakeCtx();
    expect(() => paint(net, ctx)).not.toThrow();
  });

  it("paints nothing before a round has been rendered", () => {
    const net = networkWithHook();
    State.network = net;
    renderBoard({ ...GAME }, {}, null, IDS, {});
    renderBoard(null, {}, null, IDS, {});

    const ctx = fakeCtx();
    paint(net, ctx);

    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it("registers its painter only once per network", () => {
    const net = networkWithHook();
    State.network = net;

    renderBoard({ ...GAME }, {}, null, IDS, {});
    const first = net.handlers.beforeDrawing.length;
    renderBoard(
      { ...GAME, nodes: [{ name: "Drake" }, { name: "Future" }] },
      {},
      null,
      { ...IDS, Future: 3 },
      {},
    );

    expect(net.handlers.beforeDrawing).toHaveLength(first);
  });

  it("refits the camera when the board drifts out of view", () => {
    const net = networkWithHook();
    net.DOMtoCanvas = vi.fn(({ x }) => ({ x: x === 0 ? 5000 : 5100, y: x === 0 ? 5000 : 5100 }));
    State.network = net;

    renderBoard({ ...GAME }, {}, null, IDS, {});
    net.fit.mockClear();
    renderBoard({ ...GAME }, {}, null, IDS, {});

    expect(net.fit).toHaveBeenCalled();
  });
});
