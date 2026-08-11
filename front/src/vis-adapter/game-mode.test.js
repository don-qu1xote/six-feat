import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./compare-mode.js", () => ({ exitCompareMode: vi.fn() }));

import { exitCompareMode } from "./compare-mode.js";
import { State, setGameMode, setNodes, setEdges } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  isGameModeActive,
  enterGameMode,
  exitGameMode,
  handleGameModeNodeClick,
  applyGameEngineOptions,
} from "./game-mode.js";

let home;

beforeEach(() => {
  exitCompareMode.mockClear();
  setGameMode(false);
  State.network = null;
  State.nodesDS = null;
  State.edgesDS = null;
  setNodes([{ id: 1 }]);
  setEdges([{ from: 1, to: 2 }]);
  home = document.createElement("div");
  els.network = document.createElement("div");
  home.appendChild(els.network);
});

describe("enterGameMode", () => {
  it("turns the mode on, stores the click router, and relocates #network", () => {
    const col = document.createElement("div");
    const router = vi.fn();
    enterGameMode({ container: col, onNodeClick: router });

    expect(isGameModeActive()).toBe(true);
    expect(State.game.clickRouter).toBe(router);
    expect(State.game.homeParent).toBe(home);
    expect(els.network.parentElement).toBe(col);
  });

  it("silences Compare mode — the two can't both own the click", () => {
    enterGameMode({ container: document.createElement("div"), onNodeClick: vi.fn() });
    expect(exitCompareMode).toHaveBeenCalledWith({ silent: true });
  });

  it("is a no-op without a container or without #network", () => {
    enterGameMode({ container: null, onNodeClick: vi.fn() });
    expect(isGameModeActive()).toBe(false);

    els.network = null;
    enterGameMode({ container: document.createElement("div"), onNodeClick: vi.fn() });
    expect(isGameModeActive()).toBe(false);
  });

  it("re-entering keeps the ORIGINAL home, not the game column", () => {
    enterGameMode({ container: document.createElement("div"), onNodeClick: vi.fn() });
    enterGameMode({ container: document.createElement("div"), onNodeClick: vi.fn() });
    expect(State.game.homeParent).toBe(home);
  });
});

describe("exitGameMode", () => {
  it("turns the mode off, clears the router, and hands #network back home", () => {
    const col = document.createElement("div");
    enterGameMode({ container: col, onNodeClick: vi.fn() });
    exitGameMode();

    expect(isGameModeActive()).toBe(false);
    expect(State.game.clickRouter).toBeNull();
    expect(State.game.homeParent).toBeNull();
    expect(els.network.parentElement).toBe(home);
  });

  it("empties the graph so the Explorer canvas doesn't inherit the chain", () => {
    const clear = vi.fn();
    State.nodesDS = { clear };
    State.edgesDS = { clear };
    enterGameMode({ container: document.createElement("div"), onNodeClick: vi.fn() });
    exitGameMode();

    expect(clear).toHaveBeenCalledTimes(2);
    expect(State.graphNodes).toEqual([]);
    expect(State.graphEdges).toEqual([]);
  });

  it("is a no-op when the mode was never entered", () => {
    exitGameMode();
    expect(els.network.parentElement).toBe(home);
    expect(State.graphNodes).toEqual([{ id: 1 }]);
  });
});

describe("handleGameModeNodeClick", () => {
  it("forwards the click to the installed router while active", () => {
    const router = vi.fn();
    enterGameMode({ container: document.createElement("div"), onNodeClick: router });
    handleGameModeNodeClick({ nodes: [7] });
    expect(router).toHaveBeenCalledWith({ nodes: [7] });
  });

  it("does nothing when the mode is off — the Explorer keeps its own click", () => {
    const router = vi.fn();
    enterGameMode({ container: document.createElement("div"), onNodeClick: router });
    exitGameMode();
    handleGameModeNodeClick({ nodes: [7] });
    expect(router).not.toHaveBeenCalled();
  });

  it("survives a mode with no router installed", () => {
    setGameMode(true, { clickRouter: null });
    expect(() => handleGameModeNodeClick({ nodes: [7] })).not.toThrow();
  });
});

describe("[SF-GAME-55] движок в игре не перерисовывается на ховер", () => {
  function fakeNet() {
    const calls = [];
    return { calls, setOptions: (o) => calls.push(o), on() {}, redraw() {} };
  }

  it("выключает interaction.hover при входе в режим", () => {
    const net = fakeNet();
    State.network = net;
    enterGameMode({ container: document.createElement("div"), onNodeClick: () => {} });
    expect(net.calls.some((o) => o?.interaction?.hover === false)).toBe(true);
  });

  it("накладывает ограничение заново на пересозданную сеть", () => {
    enterGameMode({ container: document.createElement("div"), onNodeClick: () => {} });
    const fresh = fakeNet();
    State.network = fresh;
    applyGameEngineOptions();
    expect(fresh.calls.some((o) => o?.interaction?.hover === false)).toBe(true);
  });

  it("вне режима ничего не трогает", () => {
    exitGameMode();
    const net = fakeNet();
    State.network = net;
    applyGameEngineOptions();
    expect(net.calls.length).toBe(0);
  });

  it("возвращает ховер Explorer'у на выходе", () => {
    enterGameMode({ container: document.createElement("div"), onNodeClick: () => {} });
    const net = fakeNet();
    State.network = net;
    exitGameMode();
    expect(net.calls.some((o) => o?.interaction?.hover === true)).toBe(true);
  });
});
