import { describe, it, expect, vi, beforeEach } from "vitest";
import { State } from "../state/state.js";
import { setTheme } from "./theme.js";

function mockDataSet(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    get: (id) => byId.get(id),
    getIds: () => [...byId.keys()],
    update: vi.fn((updates) => {
      for (const u of Array.isArray(updates) ? updates : [updates]) {
        byId.set(u.id, { ...(byId.get(u.id) || { id: u.id }), ...u });
      }
    }),
  };
}

describe("setTheme — recolors in place without touching physics/layout (SF-WEB-13)", () => {
  let moveNodeSpy;
  let positions;

  beforeEach(() => {
    positions = { 1: { x: 12, y: -34 }, 2: { x: 56, y: 78 } };
    moveNodeSpy = vi.fn();

    State.graphNodes = [
      {
        id: 1,
        name: "Seed Artist",
        isSeed: true,
        imageUrl: "",
        _dominantRole: "featured",
        _accent: "#5EE6C5",
        _dimBorder: "rgba(94,230,197,0.45)",
      },
      {
        id: 2,
        name: "Photo Artist",
        isSeed: false,
        imageUrl: "https://genius.example/photo.jpg",
        _dominantRole: "primary",
        _accent: "#8FA6C9",
        _dimBorder: "#8FA6C940",
      },
    ];
    State.graphEdges = [{ id: "1_2", from: 1, to: 2, weight: 3, dominantRole: "primary" }];
    State.expandedNodes = new Set();
    State.selectedEdgeId = null;

    State.nodesDS = mockDataSet(State.graphNodes.map((n) => ({ id: n.id })));
    State.edgesDS = mockDataSet(State.graphEdges.map((e) => ({ id: e.id })));
    State.network = {
      getPositions: () => positions,
      moveNode: moveNodeSpy,
      setOptions: vi.fn(),
    };
  });

  it("leaves network.getPositions() and moveNode untouched", () => {
    const before = State.network.getPositions();
    setTheme("light");
    const after = State.network.getPositions();

    expect(after).toEqual(before);
    expect(moveNodeSpy).not.toHaveBeenCalled();
  });

  it("updates node and edge colour fields via update(), not a rebuild", () => {
    setTheme("light");

    expect(State.nodesDS.update).toHaveBeenCalledTimes(1);
    const nodeUpdates = State.nodesDS.update.mock.calls[0][0];
    const seedUpdate = nodeUpdates.find((u) => u.id === 1);
    expect(seedUpdate.color.border).toBeTruthy();
    expect(seedUpdate._accent).toBeTruthy();
    expect(seedUpdate.shadow).toBeDefined();

    expect(State.edgesDS.update).toHaveBeenCalledTimes(1);
    const edgeUpdates = State.edgesDS.update.mock.calls[0][0];
    const edgeUpdate = edgeUpdates.find((u) => u.id === "1_2");
    expect(edgeUpdate.color.color).toBeTruthy();
    expect(edgeUpdate.color.opacity).toBe(0.4);
    expect(edgeUpdate._brightColor).toBeTruthy();
  });

  it("recolors a placeholder node's image but leaves a Genius-photo node's image untouched", () => {
    setTheme("light");

    const nodeUpdates = State.nodesDS.update.mock.calls[0][0];
    const seedUpdate = nodeUpdates.find((u) => u.id === 1);
    const photoUpdate = nodeUpdates.find((u) => u.id === 2);
    expect(seedUpdate.image).toContain("data:image/svg+xml");
    expect(photoUpdate.image).toBeUndefined();
    expect(photoUpdate.brokenImage).toBeUndefined();
  });
});
