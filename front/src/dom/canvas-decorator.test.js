import { describe, it, expect, beforeAll } from "vitest";
import { els } from "./dom.js";
import {
  setupCanvasDecorator,
  startCanvasDecorator,
  stopCanvasDecorator,
} from "./canvas-decorator.js";

let svg;

beforeAll(() => {
  els.canvasDecorator = document.createElement("div");
  setupCanvasDecorator();
  svg = els.canvasDecorator.querySelector("svg");
});

describe("setupCanvasDecorator", () => {
  it("builds one svg containing the dot starfield plus the dandelion nodes/edges", () => {
    expect(svg).toBeTruthy();
    expect(svg.getAttribute("viewBox")).toBe("0 0 1000 1000");

    const dots = svg.querySelectorAll(".decor-dot");
    const nodes = svg.querySelectorAll(".decor-node");
    const edges = svg.querySelectorAll(".decor-edge");
    expect(dots.length).toBeGreaterThan(0);
    expect(nodes.length).toBeGreaterThan(0);
    expect(edges.length).toBe(nodes.length);
    expect(svg.querySelectorAll("circle").length).toBe(dots.length + nodes.length);
  });

  it("every dandelion edge starts at the implied seed center and ends on its node's own position", () => {
    const nodesByPos = new Map(
      [...svg.querySelectorAll(".decor-node")].map((n) => [
        `${n.getAttribute("cx")},${n.getAttribute("cy")}`,
        n,
      ]),
    );
    for (const edge of svg.querySelectorAll(".decor-edge")) {
      expect(edge.getAttribute("x1")).toBe("500");
      expect(edge.getAttribute("y1")).toBe("500");
      const endKey = `${edge.getAttribute("x2")},${edge.getAttribute("y2")}`;
      expect(nodesByPos.has(endKey), "edge endpoint doesn't match any dandelion node").toBe(true);
    }
  });

  it("dandelion nodes are static (no drift animation timing) — only ambient dots get one", () => {
    for (const node of svg.querySelectorAll(".decor-node")) {
      expect(node.style.animationDuration).toBe("");
      expect(node.style.animationDelay).toBe("");
    }
    for (const dot of svg.querySelectorAll(".decor-dot")) {
      expect(dot.style.animationDuration).not.toBe("");
      expect(dot.style.animationDelay).not.toBe("");
    }
  });

  it("is idempotent — a second call does not build a second svg", () => {
    setupCanvasDecorator();
    expect(els.canvasDecorator.querySelectorAll("svg").length).toBe(1);
  });

  it("does nothing if the decorator mount point isn't in the DOM", () => {
    const saved = els.canvasDecorator;
    els.canvasDecorator = null;
    expect(() => setupCanvasDecorator()).not.toThrow();
    els.canvasDecorator = saved;
  });
});

describe("startCanvasDecorator / stopCanvasDecorator", () => {
  it("toggles .is-hidden on the mount point", () => {
    els.canvasDecorator.classList.add("is-hidden");
    startCanvasDecorator();
    expect(els.canvasDecorator.classList.contains("is-hidden")).toBe(false);

    stopCanvasDecorator();
    expect(els.canvasDecorator.classList.contains("is-hidden")).toBe(true);
  });

  it("is a no-op when there's no mount point", () => {
    const saved = els.canvasDecorator;
    els.canvasDecorator = null;
    expect(() => {
      startCanvasDecorator();
      stopCanvasDecorator();
    }).not.toThrow();
    els.canvasDecorator = saved;
  });
});
