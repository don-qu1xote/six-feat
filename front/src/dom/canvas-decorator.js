// ════════════════════════════════════════════════════════════════════════════
// canvas-decorator.js — ТЗ-D8: idle starfield shown while #network is empty
//
// Pure CSS-driven (no rAF loop, no canvas 2d context) — a handful of small
// circles with randomised position/size/duration, animated via the
// `decor-drift` keyframe declared in index.html. Cheap enough to leave
// mounted permanently; we only toggle its opacity via .is-hidden.
// ════════════════════════════════════════════════════════════════════════════
import { els } from "./dom.js";

const DOT_COUNT = 46;
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

  for (let i = 0; i < DOT_COUNT; i++) {
    const dot = document.createElementNS(SVG_NS, "circle");
    const r = rand(1, 3.2);
    dot.setAttribute("cx", rand(0, 1000).toFixed(1));
    dot.setAttribute("cy", rand(0, 1000).toFixed(1));
    dot.setAttribute("r", r.toFixed(2));
    dot.setAttribute("class", "decor-dot");
    dot.style.setProperty("--decor-o", rand(0.18, 0.6).toFixed(2));
    dot.style.animationDuration = `${rand(5, 13).toFixed(1)}s`;
    dot.style.animationDelay = `-${rand(0, 10).toFixed(1)}s`;
    svg.appendChild(dot);
  }

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
