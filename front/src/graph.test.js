// ════════════════════════════════════════════════════════════════════════════
// graph.test.js — unit tests for buildNodeState/buildEdgeState/
//                 computeNodeDominantRoles/cacheNodeCollaborations
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from "vitest";
import { State, COLOR } from "./state/state.js";
import {
  buildNodeState,
  buildEdgeState,
  computeNodeDominantRoles,
  cacheNodeCollaborations,
} from "./graph.js";

beforeEach(() => {
  State.graphNodes = [];
  State.graphEdges = [];
});

describe("buildNodeState", () => {
  it("marks the seed node and gives it the signal accent", () => {
    const n = buildNodeState({ id: 1, name: "Drake" }, 1, new Set(), {});
    expect(n.isSeed).toBe(true);
    expect(n._accent).toBe(COLOR.signal);
    expect(n._dimBorder).toBe("rgba(94,230,197,0.45)");
  });

  it("gives non-seed nodes the primary role accent", () => {
    const n = buildNodeState({ id: 2, name: "Future" }, 1, new Set(), {});
    expect(n.isSeed).toBe(false);
    expect(n._accent).toBe("#8FA6C9");
    expect(n._dimBorder).toBe("#8FA6C940");
  });

  it("uses name, falling back to empty string", () => {
    expect(buildNodeState({ id: 1, name: "N" }, null, new Set()).name).toBe("N");
    expect(buildNodeState({ id: 1 }, null, new Set()).name).toBe("");
  });

  it("computes _isNew from existingIds, defaulting to true when absent", () => {
    const existing = new Set([1]);
    expect(buildNodeState({ id: 1 }, null, existing)._isNew).toBe(false);
    expect(buildNodeState({ id: 2 }, null, existing)._isNew).toBe(true);
    expect(buildNodeState({ id: 3 }, null, null)._isNew).toBe(true);
  });

  it("defaults imageUrl/geniusUrl/genres when absent", () => {
    const n = buildNodeState({ id: 1 }, null, new Set());
    expect(n.imageUrl).toBe("");
    expect(n.geniusUrl).toBe(null);
    expect(n.genres).toEqual([]);
  });

  it("[SF-WEB-16] normalizes Genius's real default-image URL to an empty imageUrl", () => {
    const n = buildNodeState(
      { id: 1, name: "No Photo Artist", image: "https://assets.genius.com/images/default_cover_image.png?1783625229" },
      null, new Set(),
    );
    expect(n.imageUrl).toBe("");
  });

  it("[SF-WEB-16] keeps a real photo URL untouched", () => {
    const n = buildNodeState(
      { id: 1, name: "Real Photo Artist", image: "https://images.genius.com/real.jpg" },
      null, new Set(),
    );
    expect(n.imageUrl).toBe("https://images.genius.com/real.jpg");
  });
});

describe("buildEdgeState", () => {
  it("computes id as the sorted from/to pair regardless of input order", () => {
    expect(buildEdgeState({ from: 5, to: 2 }).id).toBe("2_5");
    expect(buildEdgeState({ from: 2, to: 5 }).id).toBe("2_5");
  });

  it("defaults weight to 1 when zero/absent, otherwise keeps it", () => {
    expect(buildEdgeState({ from: 1, to: 2 }).weight).toBe(1);
    expect(buildEdgeState({ from: 1, to: 2, weight: 0 }).weight).toBe(1);
    expect(buildEdgeState({ from: 1, to: 2, weight: 7 }).weight).toBe(7);
  });

  it("defaults collaboration_count/collaborations/songs", () => {
    const e = buildEdgeState({ from: 1, to: 2 });
    expect(e.collaboration_count).toBe(null);
    expect(e.collaborations).toEqual([]);
    expect(e.songs).toEqual([]);
  });

  it("derives dominantRole from e.dominant_role (case-insensitive)", () => {
    expect(buildEdgeState({ from: 1, to: 2, dominant_role: "Producer" }).dominantRole).toBe("producer");
  });

  it("picks the highest-priority role across collaborations (featured beats writer)", () => {
    const e = buildEdgeState({
      from: 1, to: 2,
      collaborations: [{ roles: ["writer"] }, { roles: ["featured"] }],
    });
    expect(e.dominantRole).toBe("featured");
  });

  it("falls back to primary when no role signal is present", () => {
    expect(buildEdgeState({ from: 1, to: 2 }).dominantRole).toBe("primary");
  });
});

describe("computeNodeDominantRoles", () => {
  it("always assigns 'featured' to the seed node", () => {
    State.graphNodes = [{ id: 1, isSeed: true }];
    State.graphEdges = [{ from: 1, to: 2, dominantRole: "writer", weight: 9 }];
    computeNodeDominantRoles();
    expect(State.graphNodes[0]._dominantRole).toBe("featured");
  });

  it("assigns the role with the highest accumulated weight to non-seed nodes", () => {
    State.graphNodes = [{ id: 10, isSeed: false }];
    State.graphEdges = [
      { from: 10, to: 20, dominantRole: "producer", weight: 5 },
      { from: 10, to: 30, dominantRole: "writer", weight: 2 },
    ];
    computeNodeDominantRoles();
    expect(State.graphNodes[0]._dominantRole).toBe("producer");
  });

  it("defaults to 'primary' for a node with no incident edges", () => {
    State.graphNodes = [{ id: 99, isSeed: false }];
    State.graphEdges = [];
    computeNodeDominantRoles();
    expect(State.graphNodes[0]._dominantRole).toBe("primary");
  });
});

describe("cacheNodeCollaborations", () => {
  it("sorts _topTracks by popularity descending, then caps at 5", () => {
    State.graphNodes = [{ id: 1, isSeed: false }];
    State.graphEdges = [{
      from: 1, to: 2, weight: 1,
      collaborations: [
        { song: "Low",  popularity: 10 },
        { song: "High", popularity: 9000 },
        { song: "Mid",  popularity: 500 },
        { song: "C1",   popularity: 1 },
        { song: "C2",   popularity: 0 },
        { song: "C3",   popularity: 0 },
      ],
    }];
    cacheNodeCollaborations();
    const node = State.graphNodes[0];
    expect(node._topTracks).toHaveLength(5);
    expect(node._topTracks.map(t => t.song)).toEqual(["High", "Mid", "Low", "C1", "C2"]);
  });

  it("preserves incidence order for equal popularity (stable sort), including when the field is absent", () => {
    State.graphNodes = [{ id: 1, isSeed: false }];
    State.graphEdges = [{
      from: 1, to: 2, weight: 1,
      collaborations: [
        { song: "Low" },
        { song: "High" },
        { song: "Mid" },
        { song: "C1" },
        { song: "C2" },
        { song: "C3" },
      ],
    }];
    cacheNodeCollaborations();
    const node = State.graphNodes[0];
    expect(node._topTracks).toHaveLength(5);
    expect(node._topTracks.map(t => t.song)).toEqual(["Low", "High", "Mid", "C1", "C2"]);
  });

  it("aggregates lowercase roles across all incident edges into _rolesSet", () => {
    State.graphNodes = [{ id: 1, isSeed: false }];
    State.graphEdges = [
      { from: 1, to: 2, weight: 1, collaborations: [{ roles: ["Featured"] }] },
      { from: 3, to: 1, weight: 1, collaborations: [{ roles: ["WRITER"] }] },
    ];
    cacheNodeCollaborations();
    expect(State.graphNodes[0]._rolesSet).toEqual(new Set(["featured", "writer"]));
  });

  it("sums _totalCollabs using collaboration_count, falling back to weight", () => {
    State.graphNodes = [{ id: 1, isSeed: false }];
    State.graphEdges = [
      { from: 1, to: 2, collaboration_count: 4, weight: 1 },
      { from: 1, to: 3, weight: 2 },       // no collaboration_count -> falls back to weight
      { from: 1, to: 4 },                  // neither -> falls back to 1
    ];
    cacheNodeCollaborations();
    expect(State.graphNodes[0]._totalCollabs).toBe(4 + 2 + 1);
  });

  it("gives a node with no incident edges empty stats", () => {
    State.graphNodes = [{ id: 42, isSeed: false }];
    State.graphEdges = [];
    cacheNodeCollaborations();
    const node = State.graphNodes[0];
    expect(node._topTracks).toEqual([]);
    expect(node._rolesSet).toEqual(new Set());
    expect(node._totalCollabs).toBe(0);
  });
});
