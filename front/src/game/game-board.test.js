import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph.js", () => ({ replaceGraph: vi.fn() }));

import { replaceGraph } from "../graph.js";
import { State, setGameMode } from "../state/state.js";
import { els } from "../dom/dom.js";
import { isGameModeActive } from "../vis-adapter/game-mode.js";
import { mountBoard, unmountBoard, renderBoard } from "./game-board.js";

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
    expect(g.seed_id).toBe(100);
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
