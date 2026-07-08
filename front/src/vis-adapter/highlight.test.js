// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/highlight.test.js — unit tests for buildDefaultColorCache/
//                                  invalidateColorCache (vis-adapter/highlight.js),
//                                  driven against a mock graph + DataSet stubs.
//                                  No real vis.Network/vis-network involved:
//                                  State.nodesDS/edgesDS are plain {update}
//                                  stubs and State.graphNodes/graphEdges are
//                                  hand-built mock graph data.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";
import { State, COLOR, DIM_LEVELS } from "../state/state.js";
import { seedShadow } from "./visuals.js";
import {
  buildDefaultColorCache,
  invalidateColorCache,
  applyDimState,
  resetHoverState,
} from "./highlight.js";

function mockDataSet() {
  return { update: vi.fn() };
}

beforeEach(() => {
  invalidateColorCache();
  resetHoverState();
  State.graphNodes = [
    { id: 1, isSeed: true },
    { id: 2, isSeed: false, _dimBorder: "#111111" },
  ];
  State.graphEdges = [{ id: "1_2", from: 1, to: 2, dominantRole: "featured" }];
  State.nodesDS = mockDataSet();
  State.edgesDS = mockDataSet();
  State.expandedNodes = new Set();
});

describe("buildDefaultColorCache + applyDimState('default')", () => {
  it("caches each node's default border/shadow and each edge's role color", () => {
    buildDefaultColorCache();
    applyDimState("default", {});

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const byId = Object.fromEntries(nodeUpdates.map(u => [u.id, u]));

    // Seed node: no explicit _dimBorder -> falls back to the muted-primary
    // rgba, and gets the seed glow.
    expect(byId[1].color.border).toBe("rgba(143,166,201,0.25)");
    expect(byId[1].shadow).toEqual(seedShadow());
    expect(byId[1].opacity).toBe(DIM_LEVELS.off);

    // Non-seed node: explicit _dimBorder used verbatim, no shadow.
    expect(byId[2].color.border).toBe("#111111");
    expect(byId[2].shadow).toEqual({ enabled: false });

    const [edgeUpdates] = State.edgesDS.update.mock.calls[0];
    expect(edgeUpdates).toEqual([
      { id: "1_2", color: { color: COLOR.signal, opacity: 0.45 } },
    ]);
  });

  it("reuses the cached colors on a later default-apply even if the graph changed underneath it", () => {
    buildDefaultColorCache();

    // Mutate the graph without rebuilding the cache.
    State.graphNodes[1]._dimBorder = "#222222";

    applyDimState("default", {});
    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const node2 = nodeUpdates.find(u => u.id === 2);
    expect(node2.color.border).toBe("#111111"); // stale cached value, not "#222222"
  });
});

describe("invalidateColorCache", () => {
  it("forces the next default-apply to rebuild from current graph state", () => {
    buildDefaultColorCache();
    State.graphNodes[1]._dimBorder = "#222222";

    invalidateColorCache();
    applyDimState("default", {});

    const [nodeUpdates] = State.nodesDS.update.mock.calls[0];
    const node2 = nodeUpdates.find(u => u.id === 2);
    expect(node2.color.border).toBe("#222222"); // rebuilt, reflects the change
  });

  it("is safe to call before any cache has ever been built", () => {
    expect(() => invalidateColorCache()).not.toThrow();
  });
});