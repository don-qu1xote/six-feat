import { describe, it, expect, beforeEach } from "vitest";
import { State } from "../state/state.js";
import { nodeVisual, seedShadow, nodeShadowFor } from "./visuals.js";
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
