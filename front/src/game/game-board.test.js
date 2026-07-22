// ════════════════════════════════════════════════════════════════════════════
// game-board.test.js — the game driving the REAL graph engine, restricted.
// graph.js's replaceGraph (which needs vis + canvas) is mocked, so these cover
// the parts that make it a real reuse: entering/leaving game mode, relocating
// #network, the graph-response the game feeds the real pipeline, and the
// restricted click routing (State.gameClick → game moves).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../graph.js", () => ({ replaceGraph: vi.fn() }));

import { replaceGraph } from "../graph.js";
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { mountBoard, unmountBoard, renderBoard } from "./game-board.js";

const GAME = { start: "Drake", goal: "Adele", focus: "Drake", completed: false, nodes: [{ name: "Drake", parent: null }] };

beforeEach(() => {
  replaceGraph.mockClear();
  State.graphGameMode = false;
  State.gameClick = null;
  State.network = null;
  State.nodesDS = null;
  const home = document.createElement("div");
  els.network = document.createElement("div");
  home.appendChild(els.network);
});

describe("game mode (restriction) + #network relocation", () => {
  it("mountBoard turns on game mode, installs the click gate, and moves #network into the column", () => {
    const col = document.createElement("div");
    mountBoard(col);
    expect(State.graphGameMode).toBe(true);
    expect(typeof State.gameClick).toBe("function");
    expect(els.network.parentElement).toBe(col);
  });

  it("unmountBoard drops game mode and hands #network back home", () => {
    const home = els.network.parentElement;
    mountBoard(document.createElement("div"));
    unmountBoard();
    expect(State.graphGameMode).toBe(false);
    expect(State.gameClick).toBeNull();
    expect(els.network.parentElement).toBe(home);
  });
});

describe("renderBoard drives the real replaceGraph pipeline", () => {
  it("is a no-op unless mounted in game mode", () => {
    renderBoard(GAME, {}, null, {}, {});
    expect(replaceGraph).not.toHaveBeenCalled();
  });

  it("feeds an id-based graph: start seed + goal target + aim edge", () => {
    mountBoard(document.createElement("div"));
    renderBoard(GAME, {}, null, { Drake: 100, Adele: 900 }, {});
    expect(replaceGraph).toHaveBeenCalledTimes(1);
    const g = replaceGraph.mock.calls[0][0];
    expect(g.seed_id).toBe(100);
    expect(g.nodes.some(n => n.id === 100 && n.name === "Drake")).toBe(true);
    expect(g.nodes.some(n => n.id === 900 && n.name === "Adele")).toBe(true); // goal target
    expect(g.edges.some(e => e.from === 100 && e.to === 900)).toBe(true);      // aim edge
  });

  it("adds the focus's real collaborators as dandelion nodes", () => {
    mountBoard(document.createElement("div"));
    const frontier = { loading: false, neighbours: [{ id: 200, name: "SZA", image: null }] };
    renderBoard(GAME, {}, frontier, { Drake: 100, Adele: 900 }, {});
    const g = replaceGraph.mock.calls[0][0];
    expect(g.nodes.some(n => n.id === 200 && n.name === "SZA")).toBe(true);
    expect(g.edges.some(e => e.from === 100 && e.to === 200)).toBe(true);
  });
});

describe("restricted click routing (State.gameClick)", () => {
  it("routes a dandelion click to onPick, the goal target to onReachGoal, a web node to onFocus", () => {
    mountBoard(document.createElement("div"));
    const onPick = vi.fn(), onFocus = vi.fn(), onReachGoal = vi.fn();
    const frontier = { loading: false, neighbours: [{ id: 200, name: "SZA", image: null }] };
    renderBoard(GAME, {}, frontier, { Drake: 100, Adele: 900 }, { onPick, onFocus, onReachGoal });

    State.gameClick({ nodes: [200] });
    expect(onPick).toHaveBeenCalledWith({ id: 200, name: "SZA", image: null });

    State.gameClick({ nodes: [900] });
    expect(onReachGoal).toHaveBeenCalledTimes(1);

    State.gameClick({ nodes: [100] });
    expect(onFocus).toHaveBeenCalledWith("Drake");

    State.gameClick({ nodes: [] }); // nothing clicked → no-op, no throw
  });
});
