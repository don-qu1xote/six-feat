import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../vis-adapter/index.js", () => ({
  restoreDefaultColors: vi.fn(),
  highlightPath: vi.fn(),
}));

import { State } from "../state/state.js";
import { getBfsAdj, bfsPath } from "./analytics-client.js";

beforeEach(() => {
  State.graphNodes = [];
  State.graphEdges = [];
  State._bfsAdj = null;
});

describe("getBfsAdj", () => {
  it("builds an undirected adjacency list from graphEdges", () => {
    State.graphEdges = [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ];
    const adj = getBfsAdj();
    expect(adj.get(1)).toEqual([2]);
    expect(adj.get(2)).toEqual([1, 3]);
    expect(adj.get(3)).toEqual([2]);
  });

  it("includes both endpoints of every edge even if one only ever appears as 'to'", () => {
    State.graphEdges = [{ from: 5, to: 9 }];
    const adj = getBfsAdj();
    expect([...adj.keys()].sort()).toEqual([5, 9]);
  });

  it("caches the adjacency map on State._bfsAdj until it is invalidated", () => {
    State.graphEdges = [{ from: 1, to: 2 }];
    const first = getBfsAdj();

    State.graphEdges = [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ];
    const second = getBfsAdj();

    expect(second).toBe(first);
    expect(second.has(3)).toBe(false);
  });

  it("rebuilds the adjacency once State._bfsAdj is invalidated (nulled)", () => {
    State.graphEdges = [{ from: 1, to: 2 }];
    const first = getBfsAdj();

    State.graphEdges = [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
    ];
    State._bfsAdj = null;
    const second = getBfsAdj();

    expect(second).not.toBe(first);
    expect(second.get(3)).toEqual([2]);
  });
});

describe("bfsPath", () => {
  beforeEach(() => {
    State.graphEdges = [
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 4 },
      { from: 1, to: 5 },
      { from: 6, to: 7 },
    ];
  });

  it("finds the shortest path between two connected nodes", () => {
    expect(bfsPath(1, 4)).toEqual([1, 2, 3, 4]);
  });

  it("finds a path regardless of query direction", () => {
    expect(bfsPath(4, 1)).toEqual([4, 3, 2, 1]);
  });

  it("returns a single-element path for a trivial same-node query", () => {
    expect(bfsPath(1, 1)).toEqual([1]);
  });

  it("returns null when the two nodes belong to disconnected components", () => {
    expect(bfsPath(1, 6)).toBeNull();
  });

  it("returns null when either node is absent from the graph", () => {
    expect(bfsPath(1, 999)).toBeNull();
    expect(bfsPath(999, 1)).toBeNull();
  });
});
