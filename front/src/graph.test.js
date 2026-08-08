import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./ui/index.js", () => ({ renderGraphA11yList: vi.fn() }));
vi.mock("./ui/sidebar.js", () => ({ hideArtistSidebar: vi.fn() }));
vi.mock("./ui/canvas-controls.js", () => ({
  updateStatus: vi.fn(),
  updateTruncationBanner: vi.fn(),
}));
vi.mock("./vis-adapter/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initGraphOnCanvas: vi.fn(),
    initNetwork: vi.fn(),
    refreshNetwork: vi.fn(),
    mergeNetwork: vi.fn(),
    invalidateColorCache: vi.fn(),
  };
});

import { State, COLOR } from "./state/state.js";
import { els } from "./dom/dom.js";
import {
  buildNodeState,
  buildEdgeState,
  edgeKey,
  mergeGraph,
  mergeDeepenResult,
  replaceGraph,
  computeNodeDominantRoles,
  cacheNodeCollaborations,
  refreshNodeDimBorders,
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
      {
        id: 1,
        name: "No Photo Artist",
        image: "https://assets.genius.com/images/default_cover_image.png?1783625229",
      },
      null,
      new Set(),
    );
    expect(n.imageUrl).toBe("");
  });

  it("[SF-WEB-16] keeps a real photo URL untouched", () => {
    const n = buildNodeState(
      { id: 1, name: "Real Photo Artist", image: "https://images.genius.com/real.jpg" },
      null,
      new Set(),
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
    expect(buildEdgeState({ from: 1, to: 2, dominant_role: "Producer" }).dominantRole).toBe(
      "producer",
    );
  });

  it("picks the highest-priority role across collaborations (featured beats writer)", () => {
    const e = buildEdgeState({
      from: 1,
      to: 2,
      collaborations: [{ roles: ["writer"] }, { roles: ["featured"] }],
    });
    expect(e.dominantRole).toBe("featured");
  });

  it("falls back to primary when no role signal is present", () => {
    expect(buildEdgeState({ from: 1, to: 2 }).dominantRole).toBe("primary");
  });
});

describe("edgeKey", () => {
  it("is order-independent, same as the string 'lo_hi' key it replaces", () => {
    expect(edgeKey(5, 2)).toBe(edgeKey(2, 5));
  });

  it("returns a numeric composite key for realistic (well-in-range) Genius artist ids", () => {
    const k = edgeKey(1234, 987654);
    expect(typeof k).toBe("number");
    expect(Number.isSafeInteger(k)).toBe(true);
  });

  it("never collides between distinct pairs, and never overflows past Number.MAX_SAFE_INTEGER", () => {
    const pairs = [
      [1, 2],
      [2, 3],
      [1, 3],
      [100, 200],
      [999999, 1],
    ];
    const keys = pairs.map(([a, b]) => edgeKey(a, b));
    expect(new Set(keys).size).toBe(pairs.length);
    for (const k of keys) expect(Number.isSafeInteger(k)).toBe(true);
  });

  it("falls back to the original string key when an id is outside the safe composite range", () => {
    const huge = 100_000_000;
    expect(edgeKey(1, huge)).toBe("1_100000000");
    expect(edgeKey(huge, 1)).toBe("1_100000000");
  });
});

describe("replaceGraph — SF-WEB-62", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    State.graphNodes = [];
    State.graphEdges = [];
    State.expandedNodes = new Set();
    State.currentSeedId = null;
    State.network = null;
    State.hasRendered = true;
    els.heroInput = document.createElement("input");
  });

  it("clears _isNew on every node from a full graph load, so a later expand of any of them isn't dropped by mergeNetwork's node-update buckets", () => {
    replaceGraph({
      seed_id: 1,
      nodes: [
        { id: 1, name: "Seed" },
        { id: 2, name: "Direct neighbor" },
        { id: 3, name: "Another neighbor" },
      ],
      edges: [
        { from: 1, to: 2, weight: 1 },
        { from: 1, to: 3, weight: 1 },
      ],
    });

    expect(State.graphNodes.every((n) => n._isNew === false)).toBe(true);
  });
});

describe("mergeGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    State.graphNodes = [];
    State.graphEdges = [];
    State.expandedNodes = new Set();
    State.currentSeedId = 1;
    State._clickedNodeId = null;
    State.network = null;
    State.hasRendered = true;
    els.heroInput = document.createElement("input");
  });

  it("adds only genuinely-new nodes/edges — identical final set to the old filter+map approach", () => {
    State.graphNodes = [buildNodeState({ id: 1, name: "Seed" }, 1, new Set())];
    State.graphEdges = [];

    mergeGraph({
      seed_id: 1,
      nodes: [
        { id: 1, name: "Seed" },
        { id: 2, name: "New Artist" },
      ],
      edges: [{ from: 1, to: 2, weight: 3 }],
    });

    expect(State.graphNodes.map((n) => n.id)).toEqual([1, 2]);
    expect(State.graphEdges).toHaveLength(1);
    expect(State.graphEdges[0].id).toBe("1_2");
  });

  it("dedups an edge already present regardless of from/to order", () => {
    State.graphNodes = [
      buildNodeState({ id: 1, name: "A" }, 1, new Set()),
      buildNodeState({ id: 2, name: "B" }, 1, new Set()),
    ];
    State.graphEdges = [buildEdgeState({ from: 2, to: 1, weight: 5 })];

    mergeGraph({
      seed_id: 1,
      nodes: [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ],
      edges: [{ from: 1, to: 2, weight: 5 }],
    });

    expect(State.graphEdges).toHaveLength(1);
  });

  it("marks the expanded node and does not disturb unrelated existing nodes/edges", () => {
    State.graphNodes = [
      buildNodeState({ id: 1, name: "Seed" }, 1, new Set()),
      buildNodeState({ id: 2, name: "Other" }, 1, new Set()),
    ];
    State.graphEdges = [buildEdgeState({ from: 1, to: 2, weight: 1 })];

    mergeGraph({ seed_id: 2, nodes: [{ id: 2, name: "Other" }], edges: [] });

    expect(State.expandedNodes.has(2)).toBe(true);
    expect(State.graphNodes.map((n) => n.id)).toEqual([1, 2]);
    expect(State.graphEdges).toHaveLength(1);
  });

  it("with nodes AND edges partially overlapping in the same call, the final set has every existing entry plus every new one, no duplicates", () => {
    State.graphNodes = [
      buildNodeState({ id: 1, name: "Seed" }, 1, new Set()),
      buildNodeState({ id: 2, name: "B" }, 1, new Set()),
      buildNodeState({ id: 3, name: "C" }, 1, new Set()),
    ];
    State.graphEdges = [buildEdgeState({ from: 1, to: 2, weight: 1 })];

    mergeGraph({
      seed_id: 3,
      nodes: [
        { id: 1, name: "Seed" },
        { id: 2, name: "B" },
        { id: 4, name: "D" },
        { id: 5, name: "E" },
      ],
      edges: [
        { from: 2, to: 1, weight: 1 },
        { from: 2, to: 4, weight: 2 },
        { from: 4, to: 5, weight: 3 },
      ],
    });

    expect(State.graphNodes.map((n) => n.id)).toEqual([1, 2, 3, 4, 5]);
    expect(State.graphEdges.map((e) => e.id)).toEqual(["1_2", "2_4", "4_5"]);
    expect(State.graphEdges[0].weight).toBe(1);
  });

  describe("_expandParent", () => {
    it("is the seed when the expanded node has a direct edge to it", () => {
      State.graphNodes = [
        buildNodeState({ id: 1, name: "Seed" }, 1, new Set()),
        buildNodeState({ id: 2, name: "Pole" }, 1, new Set()),
      ];
      State.graphEdges = [buildEdgeState({ from: 1, to: 2, weight: 1 })];

      mergeGraph({ seed_id: 2, nodes: [{ id: 2, name: "Pole" }], edges: [] });

      const pole = State.graphNodes.find((n) => n.id === 2);
      expect(pole._expandParent).toBe(1);
    });

    it("is the already-expanded pole the node is connected to, not the seed, for a nested (2nd-degree) expand", () => {
      State.graphNodes = [
        buildNodeState({ id: 1, name: "Seed" }, 1, new Set()),
        buildNodeState({ id: 2, name: "PoleA" }, 1, new Set()),
        buildNodeState({ id: 3, name: "LeafOfA" }, 1, new Set()),
      ];
      State.graphEdges = [
        buildEdgeState({ from: 1, to: 2, weight: 1 }),
        buildEdgeState({ from: 2, to: 3, weight: 1 }),
      ];
      State.expandedNodes = new Set([2]);
      mergeGraph({ seed_id: 3, nodes: [{ id: 3, name: "LeafOfA" }], edges: [] });

      const nested = State.graphNodes.find((n) => n.id === 3);
      expect(nested._expandParent).toBe(2);
    });

    it("never overwrites an already-recorded parent on a later re-expand", () => {
      State.graphNodes = [
        buildNodeState({ id: 1, name: "Seed" }, 1, new Set()),
        buildNodeState({ id: 2, name: "Pole" }, 1, new Set()),
      ];
      State.graphNodes[1]._expandParent = 999;
      State.graphEdges = [buildEdgeState({ from: 1, to: 2, weight: 1 })];

      mergeGraph({ seed_id: 2, nodes: [{ id: 2, name: "Pole" }], edges: [] });

      expect(State.graphNodes.find((n) => n.id === 2)._expandParent).toBe(999);
    });
  });
});

describe("[SF-YM-03] mergeDeepenResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    State.graphNodes = [];
    State.graphEdges = [];
    State.network = null;
    State.edgesDS = null;
  });

  it("adds a genuinely-new node and edge", () => {
    State.graphNodes = [buildNodeState({ id: 1, name: "Seed" }, 1, new Set())];
    State.graphEdges = [];

    const result = mergeDeepenResult({
      seed_id: 1,
      nodes: [{ id: 2, name: "Producer Pete" }],
      edges: [{ from: 1, to: 2, dominant_role: "producer", collaborations: [] }],
    });

    expect(State.graphNodes.map((n) => n.id)).toEqual([1, 2]);
    expect(State.graphEdges).toHaveLength(1);
    expect(State.graphEdges[0].id).toBe("1_2");
    expect(result).toEqual({ addedNodes: 1, addedEdges: 1, mergedEdges: 0 });
  });

  it("does not draw a second edge for a pair already present — merges collaborations instead", () => {
    State.graphNodes = [
      buildNodeState({ id: 1, name: "Seed" }, 1, new Set()),
      buildNodeState({ id: 2, name: "Existing" }, 1, new Set()),
    ];
    State.graphEdges = [
      buildEdgeState({
        from: 1,
        to: 2,
        weight: 1,
        dominant_role: "writer",
        collaborations: [{ song: "Track A", popularity: 10, roles: ["writer"] }],
      }),
    ];

    const result = mergeDeepenResult({
      seed_id: 1,
      nodes: [{ id: 2, name: "Existing" }],
      edges: [
        {
          from: 2,
          to: 1,
          dominant_role: "producer",
          collaborations: [{ song: "", popularity: 0, roles: ["producer"] }],
        },
      ],
    });

    expect(State.graphEdges).toHaveLength(1);
    expect(result).toEqual({ addedNodes: 0, addedEdges: 0, mergedEdges: 1 });

    const merged = State.graphEdges[0];
    expect(merged.collaborations).toHaveLength(2);
    expect(merged.dominantRole).toBe("producer");
  });

  it("does not add a node that already exists", () => {
    State.graphNodes = [
      buildNodeState({ id: 1, name: "Seed" }, 1, new Set()),
      buildNodeState({ id: 2, name: "Existing" }, 1, new Set()),
    ];
    State.graphEdges = [];

    const result = mergeDeepenResult({
      seed_id: 1,
      nodes: [{ id: 2, name: "Existing" }],
      edges: [],
    });

    expect(State.graphNodes).toHaveLength(2);
    expect(result.addedNodes).toBe(0);
  });

  it("dedups regardless of from/to order", () => {
    State.graphNodes = [
      buildNodeState({ id: 1, name: "Seed" }, 1, new Set()),
      buildNodeState({ id: 2, name: "Existing" }, 1, new Set()),
    ];
    State.graphEdges = [buildEdgeState({ from: 2, to: 1, weight: 1, collaborations: [] })];

    const result = mergeDeepenResult({
      seed_id: 1,
      nodes: [],
      edges: [{ from: 1, to: 2, dominant_role: "producer", collaborations: [] }],
    });

    expect(State.graphEdges).toHaveLength(1);
    expect(result.addedEdges).toBe(0);
    expect(result.mergedEdges).toBe(1);
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
    State.graphEdges = [
      {
        from: 1,
        to: 2,
        weight: 1,
        collaborations: [
          { song: "Low", popularity: 10 },
          { song: "High", popularity: 9000 },
          { song: "Mid", popularity: 500 },
          { song: "C1", popularity: 1 },
          { song: "C2", popularity: 0 },
          { song: "C3", popularity: 0 },
        ],
      },
    ];
    cacheNodeCollaborations();
    const node = State.graphNodes[0];
    expect(node._topTracks).toHaveLength(5);
    expect(node._topTracks.map((t) => t.song)).toEqual(["High", "Mid", "Low", "C1", "C2"]);
  });

  it("preserves incidence order for equal popularity (stable sort), including when the field is absent", () => {
    State.graphNodes = [{ id: 1, isSeed: false }];
    State.graphEdges = [
      {
        from: 1,
        to: 2,
        weight: 1,
        collaborations: [
          { song: "Low" },
          { song: "High" },
          { song: "Mid" },
          { song: "C1" },
          { song: "C2" },
          { song: "C3" },
        ],
      },
    ];
    cacheNodeCollaborations();
    const node = State.graphNodes[0];
    expect(node._topTracks).toHaveLength(5);
    expect(node._topTracks.map((t) => t.song)).toEqual(["Low", "High", "Mid", "C1", "C2"]);
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
      { from: 1, to: 3, weight: 2 },
      { from: 1, to: 4 },
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

describe("computeNodeDominantRoles", () => {
  beforeEach(() => {
    State.graphNodes = [
      { id: 1, name: "Seed", isSeed: true },
      { id: 2, name: "Beta", isSeed: false },
      { id: 3, name: "Gamma", isSeed: false },
    ];
  });

  it("gives the seed a fixed role rather than deriving one", () => {
    State.graphEdges = [{ from: 1, to: 2, dominantRole: "producer", weight: 9 }];

    computeNodeDominantRoles();

    expect(State.graphNodes[0]._dominantRole).toBe("featured");
  });

  it("picks the role carrying the most weight for a non-seed node", () => {
    State.graphEdges = [
      { from: 2, to: 1, dominantRole: "producer", weight: 5 },
      { from: 2, to: 3, dominantRole: "writer", weight: 2 },
    ];

    computeNodeDominantRoles();

    expect(State.graphNodes[1]._dominantRole).toBe("producer");
  });

  it("counts an edge from both of its ends", () => {
    State.graphEdges = [{ from: 2, to: 3, dominantRole: "writer", weight: 4 }];

    computeNodeDominantRoles();

    expect(State.graphNodes[1]._dominantRole).toBe("writer");
    expect(State.graphNodes[2]._dominantRole).toBe("writer");
  });

  it("treats a roleless edge as primary and a weightless one as weight 1", () => {
    State.graphEdges = [{ from: 2, to: 3 }];

    computeNodeDominantRoles();

    expect(State.graphNodes[1]._dominantRole).toBe("primary");
  });

  it("defaults an isolated node to primary", () => {
    State.graphEdges = [];

    computeNodeDominantRoles();

    expect(State.graphNodes[1]._dominantRole).toBe("primary");
  });

  it("ignores edges pointing at nodes outside the graph", () => {
    State.graphEdges = [{ from: 2, to: 999, dominantRole: "writer", weight: 3 }];

    expect(() => computeNodeDominantRoles()).not.toThrow();
    expect(State.graphNodes[1]._dominantRole).toBe("writer");
  });
});

describe("cacheNodeCollaborations", () => {
  beforeEach(() => {
    State.graphNodes = [
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
    ];
  });

  it("collects the tracks on every incident edge", () => {
    State.graphEdges = [
      {
        from: 1,
        to: 2,
        weight: 2,
        collaborations: [
          { song: "A", roles: ["featured"] },
          { song: "B", roles: ["writer"] },
        ],
      },
    ];

    cacheNodeCollaborations();

    expect(State.graphNodes[0]._topTracks.map((t) => t.song).sort()).toEqual(["A", "B"]);
    expect([...State.graphNodes[0]._rolesSet].sort()).toEqual(["featured", "writer"]);
  });

  it("keeps at most five tracks per node", () => {
    State.graphEdges = [
      {
        from: 1,
        to: 2,
        weight: 9,
        collaborations: Array.from({ length: 9 }, (_, i) => ({ song: `S${i}`, roles: [] })),
      },
    ];

    cacheNodeCollaborations();

    expect(State.graphNodes[0]._topTracks).toHaveLength(5);
  });

  it("prefers the backend's collaboration count over the raw weight", () => {
    State.graphEdges = [{ from: 1, to: 2, weight: 2, collaboration_count: 7 }];

    cacheNodeCollaborations();

    expect(State.graphNodes[0]._totalCollabs).toBe(7);
  });

  it("falls back to the weight, then to one, when no count is given", () => {
    State.graphEdges = [
      { from: 1, to: 2, weight: 3 },
      { from: 2, to: 1 },
    ];

    cacheNodeCollaborations();

    expect(State.graphNodes[0]._totalCollabs).toBe(4);
  });

  it("leaves an isolated node with empty caches, not undefined ones", () => {
    State.graphEdges = [];

    cacheNodeCollaborations();

    expect(State.graphNodes[0]._topTracks).toEqual([]);
    expect(State.graphNodes[0]._rolesSet.size).toBe(0);
    expect(State.graphNodes[0]._totalCollabs).toBe(0);
  });

  it("tolerates an edge with no collaborations array", () => {
    State.graphEdges = [{ from: 1, to: 2, weight: 1 }];

    expect(() => cacheNodeCollaborations()).not.toThrow();
    expect(State.graphNodes[0]._topTracks).toEqual([]);
  });
});

describe("refreshNodeDimBorders", () => {
  it("accents the seed with the signal colour", () => {
    State.graphNodes = [{ id: 1, isSeed: true, _dominantRole: "producer" }];

    refreshNodeDimBorders();

    expect(State.graphNodes[0]._accent).toBe(COLOR.signal);
    expect(State.graphNodes[0]._dimBorder).toContain("rgba(94,230,197");
  });

  it("accents other nodes by their dominant role, with a translucent border", () => {
    State.graphNodes = [{ id: 2, isSeed: false, _dominantRole: "producer" }];

    refreshNodeDimBorders();

    expect(State.graphNodes[0]._accent).toBeTruthy();
    expect(State.graphNodes[0]._dimBorder).toBe(`${State.graphNodes[0]._accent}40`);
  });

  it("falls back to the primary style when a node has no role yet", () => {
    State.graphNodes = [{ id: 2, isSeed: false }];

    expect(() => refreshNodeDimBorders()).not.toThrow();
    expect(State.graphNodes[0]._accent).toBeTruthy();
  });
});
