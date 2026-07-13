// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/visuals.test.js — SF-WEB-18: node labels removed from the
//                                 graph itself. nodeVisual() must not emit
//                                 label/font; the artist's name still lives
//                                 in the tooltip (buildNodeTooltip).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from "vitest";
import { State } from "../state/state.js";
import { nodeVisual } from "./visuals.js";
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
});

describe("buildNodeTooltip", () => {
  it("still contains the artist's name", () => {
    const el = buildNodeTooltip({ id: 1, name: "Kendrick Lamar", totalWeight: 3 });
    expect(el.innerHTML).toContain("Kendrick Lamar");
  });
});