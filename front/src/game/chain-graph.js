// ════════════════════════════════════════════════════════════════════════════
// game/chain-graph.js — [SF-GAME-01] Canvas visualization of the Connect chain.
//
// The left pane of the split "Connect" surface (layout: graph + track panel).
// Draws the current chain [start, …hops, goal] as an Observatory-styled path —
// monogram node discs (mint start, violet goal, amber intermediates) joined by
// gently bowed edges with a soft glow — so the game reads as part of the same
// graph world as the explorer, not a separate product.
//
// Deliberately NOT a vis-network instance: at SF-GAME-01 there's no backend and
// no real collaboration graph for arbitrary typed names (that arrives with the
// anti-cheat/ideal-path tickets), so this is a self-contained, theme-aware
// canvas render of just the chain the player is building. Pure drawing — no
// state, no DOM beyond the passed <canvas>; the controller calls draw() on
// every chain change and on resize.
// ════════════════════════════════════════════════════════════════════════════

function initials(name) {
  return String(name || "")
    .split(/\s+/)
    .map(w => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// Reads a theme token off :root so both light/dark themes render correctly.
function tok(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rgba(hex, a) {
  let h = String(hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${a})`;
}

// chain: { start, goal, hops:[], completed } or null.
// Draws into `canvas`, sizing its backing store to its CSS box (dpr-aware).
export function drawChain(canvas, chain) {
  if (!canvas || !canvas.getContext) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth || 1;
  const H = canvas.clientHeight || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const signal = tok("--signal") || "#5EE6C5";
  const pulse = tok("--pulse") || "#B98AFF";
  const amber = tok("--amber") || "#FFD27A";
  const paper = tok("--paper") || "#EDEFF4";
  const mist = tok("--mist") || "#8A94A6";
  const line = tok("--line") || "#283044";

  if (!chain || !chain.start || !chain.goal) {
    ctx.fillStyle = mist;
    ctx.font = '500 14px "Inter", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Pick a start and a goal artist to begin.", W / 2, H / 2);
    return;
  }

  const seq = [
    { name: chain.start, role: "start" },
    ...chain.hops.map(n => ({ name: n, role: "hop" })),
    { name: chain.goal, role: "goal" },
  ];

  const n = seq.length;
  const padX = Math.min(90, W * 0.14);
  const midY = H * 0.5;
  // Positions: evenly spaced left→right, with a gentle vertical wave so the
  // path reads as an organic route rather than a ruler-straight line.
  const pts = seq.map((_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const x = padX + t * (W - 2 * padX);
    const wave = Math.sin(t * Math.PI) * Math.min(46, H * 0.12);
    const y = midY - wave + (i % 2 === 0 ? 0 : Math.min(24, H * 0.06));
    return { x, y };
  });

  const rFor = role => (role === "start" ? 26 : role === "goal" ? 24 : 20);
  const colorFor = role => (role === "start" ? signal : role === "goal" ? pulse : amber);

  // Edges (behind nodes): bowed quadratic, bright accent-blend, soft glow.
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(30, len * 0.16);
    const cx = mx - (dy / len) * bow, cy = my + (dx / len) * bow;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cx, cy, b.x, b.y);
    ctx.strokeStyle = rgba(paper, 0.35);
    ctx.lineWidth = 2;
    ctx.shadowColor = rgba(signal, 0.5);
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Nodes.
  seq.forEach((st, i) => {
    const p = pts[i];
    const r = rFor(st.role);
    const col = colorFor(st.role);
    // glow halo
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
    ctx.fillStyle = rgba(col, 0.16);
    ctx.fill();
    // disc
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.shadowColor = rgba(col, 0.7);
    ctx.shadowBlur = 14;
    ctx.fill();
    ctx.shadowBlur = 0;
    // monogram
    ctx.fillStyle = "#0B0E14";
    ctx.font = `800 ${r > 22 ? 13 : 11}px "Space Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initials(st.name), p.x, p.y);
    // name label
    ctx.fillStyle = paper;
    ctx.font = '600 12px "Inter", system-ui, sans-serif';
    ctx.textBaseline = "top";
    ctx.fillText(st.name, p.x, p.y + r + 5);
    // START / GOAL tag
    if (st.role !== "hop") {
      ctx.fillStyle = col;
      ctx.font = '700 9px "Inter", system-ui, sans-serif';
      ctx.textBaseline = "bottom";
      ctx.fillText(st.role === "start" ? "START" : "GOAL", p.x, p.y - r - 5);
    }
    void line;
  });
}
