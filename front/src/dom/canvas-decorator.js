// ════════════════════════════════════════════════════════════════════════════
// canvas-decorator.js — ТЗ-D8: idle starfield shown while #network is empty.
//
// [SF-WEB-50] Now draws a faint "dandelion" — a handful of static nodes
// wired back to an implied center by thin lines, the same radial motif the
// real graph's own dandelion-ring layout (vis-adapter/layout.js) uses —
// atmosphere that echoes the product instead of a generic starfield, still
// delicate/non-distracting (low opacity, decorative only, never touches
// real graph/artist data). Everything else is unchanged: pure CSS-driven
// (no rAF loop, no canvas 2d context), a handful of small drifting circles
// animated via the `decor-drift` keyframe (canvas.css). Cheap enough to
// leave mounted permanently; we only toggle its opacity via .is-hidden.
// ════════════════════════════════════════════════════════════════════════════
import { els } from "./dom.js";

const DOT_COUNT = 46;
// [SF-WEB-50] How many of the dots above become stable "graph nodes" wired
// to the implied center, instead of ambient drifting dust — a small
// minority, so the dandelion reads as a subtle structure sitting IN a
// starfield, not the whole field turning into a wireframe.
const NODE_COUNT = 9;
const SVG_NS = "http://www.w3.org/2000/svg";

let _built = false;

function rand(min, max) { return min + Math.random() * (max - min); }

/**
 * Build the starfield once. Idempotent — safe to call multiple times.
 */
export function setupCanvasDecorator() {
  if (_built || !els.canvasDecorator) return;
  _built = true;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");

  const positions = Array.from({ length: DOT_COUNT }, () => ({ cx: rand(0, 1000), cy: rand(0, 1000) }));

  // [SF-WEB-50] A random subset becomes dandelion "nodes" — picked before
  // any DOM exists so the edges (drawn first, so dots paint on top) know
  // where their far endpoint lands.
  const nodeIndexes = new Set();
  while (nodeIndexes.size < Math.min(NODE_COUNT, positions.length)) {
    nodeIndexes.add(Math.floor(rand(0, positions.length)));
  }

  // Implied seed at the viewBox center — never rendered as its own element
  // beyond the lines converging on it, echoing how the real layout treats
  // (0,0) as the seed's fixed anchor.
  const seedX = 500, seedY = 500;
  for (const i of nodeIndexes) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", seedX);
    line.setAttribute("y1", seedY);
    line.setAttribute("x2", positions[i].cx.toFixed(1));
    line.setAttribute("y2", positions[i].cy.toFixed(1));
    line.setAttribute("class", "decor-edge");
    svg.appendChild(line);
  }

  positions.forEach(({ cx, cy }, i) => {
    const dot = document.createElementNS(SVG_NS, "circle");
    const isNode = nodeIndexes.has(i);
    dot.setAttribute("cx", cx.toFixed(1));
    dot.setAttribute("cy", cy.toFixed(1));
    if (isNode) {
      // Dandelion nodes stay put — CSS's decor-drift animates via
      // `transform`, which would visibly detach an animated node from its
      // fixed-attribute line endpoint above. Slightly larger/brighter so
      // they read as deliberate structure, not more ambient dust.
      dot.setAttribute("r", "4.2");
      dot.setAttribute("class", "decor-node");
    } else {
      const r = rand(1, 3.2);
      dot.setAttribute("r", r.toFixed(2));
      dot.setAttribute("class", "decor-dot");
      dot.style.setProperty("--decor-o", rand(0.18, 0.6).toFixed(2));
      dot.style.animationDuration = `${rand(5, 13).toFixed(1)}s`;
      dot.style.animationDelay = `-${rand(0, 10).toFixed(1)}s`;
    }
    svg.appendChild(dot);
  });

  els.canvasDecorator.appendChild(svg);
}

/**
 * Fade the starfield in (canvas empty / search modal open).
 */
export function startCanvasDecorator() {
  els.canvasDecorator?.classList.remove("is-hidden");
}

/**
 * Fade the starfield out (a graph now occupies the canvas).
 */
export function stopCanvasDecorator() {
  els.canvasDecorator?.classList.add("is-hidden");
}
