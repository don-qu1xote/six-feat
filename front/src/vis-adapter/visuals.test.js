import { describe, it, expect, beforeEach } from "vitest";
import { State } from "../state/state.js";
import { nodeVisual, seedShadow, nodeShadowFor, edgeVisual, edgeDashPattern } from "./visuals.js";
import { buildNodeTooltip } from "./tooltips.js";

beforeEach(() => {
  State.graphNodes = [];
  State.expandedNodes = new Set();
});

describe("nodeVisual", () => {
  it("does not include label or font — vis.js gets no node caption", () => {
    const v = nodeVisual({ id: 1, name: "Kendrick Lamar", isSeed: true, computedRadius: 22 });
    expect(v).not.toHaveProperty("label");
    expect(v).not.toHaveProperty("font");
  });

  it("keeps opacity fixed (never used to express glow) and never loses circularImage", () => {
    const seed = nodeVisual({ id: 1, name: "Seed", isSeed: true, computedRadius: 22 });
    const leaf = nodeVisual({ id: 2, name: "Leaf", computedRadius: 22 });
    const expired = nodeVisual({ id: 3, name: "Old", isExpired: true, computedRadius: 22 });
    for (const v of [seed, leaf, expired]) {
      expect(v.shape).toBe("circularImage");
      expect(v.image).toBeTruthy();
      expect(v.brokenImage).toBeTruthy();
    }
    expect(seed.opacity).toBe(1.0);
    expect(leaf.opacity).toBe(1.0);
    expect(expired.opacity).toBe(0.6);
  });

  it("gives every non-expired node a role-token-colored glow, disabled only for expired nodes", () => {
    const leaf = nodeVisual({ id: 1, name: "Leaf", computedRadius: 22 });
    expect(leaf.shadow.enabled).toBe(true);
    expect(leaf.shadow.color).toContain(leaf._accent.replace("#", ""));

    const expired = nodeVisual({ id: 2, name: "Old", isExpired: true, computedRadius: 22 });
    expect(expired.shadow.enabled).toBe(false);
  });

  it("gives the seed a distinctly more pronounced hero-glow than a regular leaf", () => {
    const seed = nodeVisual({ id: 1, name: "Seed", isSeed: true, computedRadius: 22 });
    const leaf = nodeVisual({ id: 2, name: "Leaf", computedRadius: 22 });
    expect(seed.shadow.enabled).toBe(true);
    expect(seed.shadow.size).toBeGreaterThan(leaf.shadow.size);
    expect(seed.shadow).toEqual(seedShadow());
  });

  it("gives an expanded node a stronger glow than a plain leaf, via the same shared formula highlight.js reuses", () => {
    State.expandedNodes = new Set([1]);
    const expanded = nodeVisual({ id: 1, name: "Hub", computedRadius: 22 });
    const leaf = nodeVisual({ id: 2, name: "Leaf", computedRadius: 22 });
    expect(expanded.shadow.size).toBeGreaterThan(leaf.shadow.size);
    expect(nodeShadowFor({ id: 1 })).toEqual(expanded.shadow);
  });
});

describe("buildNodeTooltip", () => {
  it("still contains the artist's name", () => {
    const el = buildNodeTooltip({ id: 1, name: "Kendrick Lamar", totalWeight: 3 });
    expect(el.innerHTML).toContain("Kendrick Lamar");
  });
});

// [SF-WEB-77] Роль ребра и его пунктир — серверные величины (dominant_role,
// edge_style). Раньше роль выводилась заново из collaborations, а dashes был
// захардкожен в false, то есть серверный edge_style не читал никто.
describe("edgeVisual takes role and style from the edge state", () => {
  it("uses the server's role even when collaborations imply another one", () => {
    const v = edgeVisual(
      {
        id: "1_2",
        from: 1,
        to: 2,
        weight: 1,
        dominantRole: "writer",
        edgeStyle: "dotted",
        collaborations: [{ roles: ["featured"] }],
      },
      { 1: "A", 2: "B" },
    );

    expect(v._role).toBe("writer");
  });

  it("falls back to primary only when the edge state carries no role", () => {
    const v = edgeVisual({ id: "1_2", from: 1, to: 2, weight: 1 }, { 1: "A", 2: "B" });

    expect(v._role).toBe("primary");
  });

  it("maps the server style string onto a dash pattern", () => {
    expect(edgeDashPattern("solid")).toBe(false);
    expect(edgeDashPattern("dashed")).toEqual([8, 6]);
    expect(edgeDashPattern("dotted")).toEqual([2, 6]);
  });

  it("treats an unknown or missing style as solid", () => {
    expect(edgeDashPattern(undefined)).toBe(false);
    expect(edgeDashPattern("wavy")).toBe(false);
  });
});
