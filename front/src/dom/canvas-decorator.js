import { els } from "./dom.js";

const DOT_COUNT = 46;
const NODE_COUNT = 9;
const SVG_NS = "http://www.w3.org/2000/svg";

let _built = false;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

export function setupCanvasDecorator() {
  if (_built || !els.canvasDecorator) return;
  _built = true;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");

  const positions = Array.from({ length: DOT_COUNT }, () => ({
    cx: rand(0, 1000),
    cy: rand(0, 1000),
  }));

  const nodeIndexes = new Set();
  while (nodeIndexes.size < Math.min(NODE_COUNT, positions.length)) {
    nodeIndexes.add(Math.floor(rand(0, positions.length)));
  }

  const seedX = 500,
    seedY = 500;
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

export function startCanvasDecorator() {
  els.canvasDecorator?.classList.remove("is-hidden");
}

export function stopCanvasDecorator() {
  els.canvasDecorator?.classList.add("is-hidden");
}
