/* ------------------------------------------------------------------ *
 *  Feature Atlas — frontend logic
 *
 *  GET /api/v1/graph?artist=<name> returns:
 *    { "seed": "<name>", "seed_id": <genius id>,
 *      "nodes": [ { "id": <genius id>, "label": "...", "image": "<url?>" } ],
 *      "edges": [ { "from": <id>, "to": <id>, "weight": N,
 *                   "collaborations": [ { "song": "...", "roles": [...] } ] } ] }
 *
 *  Node ids are REAL Genius ids (globally unique), so clicking a node expands
 *  the graph IN PLACE — new artists/links are merged into what's already on
 *  screen, and shared nodes/edges dedup by id instead of colliding.
 *
 *  Nodes render as round photos ('circularImage'); missing photos get an
 *  on-theme initial-letter placeholder. Tooltips use vis-network's HTML title.
 * ------------------------------------------------------------------ */

"use strict";

/* ---- palette (mirrors the CSS :root tokens) ------------------------ */
const COLOR = {
  paper:  "#EDEFF4",
  mist:   "#8A94A6",
  line:   "#283044",
  panel:  "#141A28",
  signal: "#5EE6C5", // teal   — the focused (current) artist
  pulse:  "#B98AFF"  // violet — everyone else
};

/* ---- element references ------------------------------------------- */
const els = {
  hero:       document.getElementById("hero"),
  heroForm:   document.getElementById("hero-form"),
  heroInput:  document.getElementById("hero-input"),
  chips:      document.getElementById("chips"),

  graphView:  document.getElementById("graph-view"),
  brand:      document.getElementById("brand"),
  dockForm:   document.getElementById("dock-form"),
  dockInput:  document.getElementById("dock-input"),

  network:    document.getElementById("network"),
  status:     document.getElementById("status"),
  statusSeed: document.getElementById("status-seed"),

  loading:    document.getElementById("loading"),
  toast:      document.getElementById("toast")
};

/* ---- runtime state ------------------------------------------------- */
let network = null;          // the vis.Network instance (created lazily)
let nodesDS = null;          // vis.DataSet for nodes (keyed by Genius id)
let edgesDS = null;          // vis.DataSet for edges (keyed by canonical id)
let currentSeedId = null;    // id of the currently focused artist
let hasRendered = false;     // have we shown the graph at least once?
let inFlight = false;        // guard against overlapping requests
let toastTimer = null;

/* ================================================================== *
 *  Small helpers (escaping, placeholders, tooltip DOM)
 * ================================================================== */

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initialOf(name) {
  const m = (name || "").trim().match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : "?").toUpperCase();
}

function placeholderFor(name, isSeed) {
  const accent = isSeed ? COLOR.signal : COLOR.pulse;
  const letter = escapeHtml(initialOf(name));
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'>" +
      "<defs><radialGradient id='g' cx='50%' cy='36%' r='75%'>" +
        "<stop offset='0%' stop-color='#1C2740'/>" +
        "<stop offset='100%' stop-color='#0F1420'/>" +
      "</radialGradient></defs>" +
      "<rect width='120' height='120' fill='url(#g)'/>" +
      "<circle cx='60' cy='60' r='54' fill='none' stroke='" + accent +
        "' stroke-opacity='0.30' stroke-width='2'/>" +
      "<text x='60' y='60' dy='.35em' text-anchor='middle' " +
        "font-family='Inter, Segoe UI, Arial, sans-serif' font-size='52' " +
        "font-weight='700' fill='" + accent + "'>" + letter + "</text>" +
    "</svg>";
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

function makeTooltip(innerHtml) {
  const el = document.createElement("div");
  el.className = "tt";
  el.innerHTML = innerHtml;
  return el;
}

/* ================================================================== *
 *  Networking
 * ================================================================== */

async function searchArtist(name) {
  const artist = (name || "").trim();
  if (!artist || inFlight) return;

  inFlight = true;
  showLoading(true);
  hideToast();

  try {
    const res = await fetch("/api/v1/graph?artist=" + encodeURIComponent(artist));

    if (!res.ok) {
      let detail = "Request failed (HTTP " + res.status + ").";
      if (res.status === 502) {
        detail = "Couldn’t reach Genius. Check the API token and try again.";
      } else if (res.status === 400) {
        detail = "Please enter an artist name.";
      }
      throw new Error(detail);
    }

    const graph = await res.json();

    if (!graph.nodes || graph.nodes.length === 0) {
      showToast("No collaborations found for “" + artist + "”. Try another spelling or a different artist.");
      return;
    }

    applyGraph(graph);
  } catch (err) {
    showToast(err.message || "Something went wrong. Please try again.");
  } finally {
    inFlight = false;
    showLoading(false);
  }
}

/* ================================================================== *
 *  Node / edge visuals
 * ================================================================== */

// Full visual spec for a node. The focused artist (isSeed) is larger, with a
// thicker --signal border and a soft signal glow; everyone else uses --pulse.
// Custom fields `name` / `imageUrl` are kept on the item for drill-in, edge
// tooltips, and seamless promote/demote restyling.
function nodeVisual(id, name, imageUrl, isSeed) {
  const accent = isSeed ? COLOR.signal : COLOR.pulse;
  const image = imageUrl || placeholderFor(name, isSeed);
  return {
    id: id,
    name: name,
    imageUrl: imageUrl || "",
    shape: "circularImage",
    image: image,
    brokenImage: placeholderFor(name, isSeed),
    size: isSeed ? 34 : 20,
    borderWidth: isSeed ? 5 : 2,
    borderWidthSelected: isSeed ? 7 : 3,
    color: {
      border: accent,
      background: COLOR.panel,
      highlight: { border: COLOR.paper, background: COLOR.panel },
      hover:     { border: accent,      background: COLOR.panel }
    },
    title: makeTooltip(
      '<div class="tt-name">' + escapeHtml(name) +
      (isSeed ? ' <span class="tt-seed">focus</span>' : "") + "</div>"
    ),
    shadow: isSeed
      ? { enabled: true, color: "rgba(94,230,197,0.45)", size: 26, x: 0, y: 0 }
      : { enabled: true, color: "rgba(0,0,0,0.5)",       size: 16, x: 0, y: 8 }
  };
}

function styleEdge(e, nameById) {
  // Canonical, direction-independent id so the same pair never doubles up,
  // no matter which endpoint was the seed when it was discovered.
  const lo = Math.min(e.from, e.to);
  const hi = Math.max(e.from, e.to);
  const weight = Number(e.weight) > 0 ? Number(e.weight) : 1;
  return {
    id: lo + "_" + hi,
    from: e.from,
    to: e.to,
    width: Math.min(1 + weight, 12),  // base thickness + weight, lightly capped
    title: buildEdgeTooltip(e, nameById)
  };
}

function buildEdgeTooltip(e, nameById) {
  const fromName = nameById[e.from] || "?";
  const toName = nameById[e.to] || "?";
  const collabs = Array.isArray(e.collaborations) ? e.collaborations : [];
  const weight = Number(e.weight) > 0 ? Number(e.weight) : collabs.length;

  let rows = "";
  for (const c of collabs) {
    const roles = Array.isArray(c.roles) ? c.roles : [];
    const pills = roles.map(function (r) {
      const slug = String(r).toLowerCase().replace(/[^a-z0-9]/g, "");
      return '<span class="tt-role tt-role--' + slug + '">' + escapeHtml(r) + "</span>";
    }).join("");
    rows +=
      '<li class="tt-row">' +
        '<span class="tt-song">' + escapeHtml(c.song || "Untitled") + "</span>" +
        '<span class="tt-roles">' + pills + "</span>" +
      "</li>";
  }
  if (!rows) rows = '<li class="tt-empty">No track details available.</li>';

  return makeTooltip(
    '<div class="tt-head">' +
      '<span class="tt-name">' + escapeHtml(fromName) + "</span>" +
      '<span class="tt-x">×</span>' +
      '<span class="tt-name">' + escapeHtml(toName) + "</span>" +
    "</div>" +
    '<div class="tt-meta">' + weight + " shared track" + (weight === 1 ? "" : "s") + "</div>" +
    '<ul class="tt-list">' + rows + "</ul>"
  );
}

/* ================================================================== *
 *  Merge a payload into the live graph (incremental expansion)
 * ================================================================== */

function applyGraph(graph) {
  const seedId = (graph.seed_id != null)
    ? graph.seed_id
    : (graph.nodes[0] && graph.nodes[0].id);

  // id -> name lookup for edge tooltips.
  const nameById = {};
  graph.nodes.forEach(function (n) { nameById[n.id] = n.label || n.name || ""; });

  const firstRender = (network === null);
  const prevCount = firstRender ? 0 : nodesDS.length;

  // Anchor new nodes to the position of the artist being expanded, so the
  // cluster grows OUT of the clicked node instead of flying in from (0,0).
  let anchor = null;
  if (!firstRender && nodesDS.get(seedId)) {
    const p = network.getPositions([seedId]);
    if (p && p[seedId]) anchor = p[seedId];
  }

  // Demote the previously focused artist back to a normal collaborator.
  if (!firstRender && currentSeedId != null && currentSeedId !== seedId) {
    const prev = nodesDS.get(currentSeedId);
    if (prev) nodesDS.update(nodeVisual(prev.id, prev.name, prev.imageUrl, false));
  }

  // Build node upserts. Only the incoming seed is focus-styled; everyone else
  // is normal. Never downgrade a known real photo to a placeholder.
  const nodeUpserts = graph.nodes.map(function (n) {
    const isSeed = n.id === seedId;
    let imageUrl = n.image || "";
    const existing = firstRender ? null : nodesDS.get(n.id);
    if (!imageUrl && existing && existing.imageUrl) imageUrl = existing.imageUrl;

    const v = nodeVisual(n.id, n.label || n.name || "", imageUrl, isSeed);
    if (anchor && !existing) {
      v.x = anchor.x + (Math.random() - 0.5) * 120;
      v.y = anchor.y + (Math.random() - 0.5) * 120;
    }
    return v;
  });

  const edgeUpserts = graph.edges.map(function (e) { return styleEdge(e, nameById); });

  // Reveal the graph surface on the first successful search.
  if (!hasRendered) {
    els.hero.classList.add("is-hidden");
    els.graphView.hidden = false;
    requestAnimationFrame(function () { els.graphView.classList.add("is-visible"); });
    els.status.hidden = false;
    hasRendered = true;
  }

  if (firstRender) {
    nodesDS = new vis.DataSet(nodeUpserts);
    edgesDS = new vis.DataSet(edgeUpserts);
    network = new vis.Network(
      els.network,
      { nodes: nodesDS, edges: edgesDS },
      networkOptions()
    );

    network.on("click", function (params) {
      if (!params.nodes || params.nodes.length === 0) return;
      const node = nodesDS.get(params.nodes[0]);
      if (node && node.name) searchArtist(node.name);  // expand this artist
    });
    network.on("hoverNode", function () { els.network.style.cursor = "pointer"; });
    network.on("blurNode", function () { els.network.style.cursor = "default"; });
  } else {
    // Incremental: update() inserts new items and overwrites existing ones by
    // id, so nothing duplicates.
    nodesDS.update(nodeUpserts);
    edgesDS.update(edgeUpserts);

    // Keep the expansion calm: a short, bounded settle instead of letting the
    // newly injected nodes blow the layout apart.
    network.stabilize(90);

    // Coming back from a reset (graph was empty) — recenter on the fresh graph.
    if (prevCount === 0) network.fit({ animation: { duration: 500 } });
  }

  currentSeedId = seedId;
  updateStatus(graph);
  els.dockInput.value = graph.seed || "";
}

function networkOptions() {
  return {
    nodes: {
      shapeProperties: { interpolation: true, useBorderWithImage: true }
    },
    edges: {
      color: { inherit: "both", opacity: 0.55 },
      hoverWidth: 0.8,
      selectionWidth: 1,
      smooth: { enabled: true, type: "continuous", roundness: 0.5 }
    },
    physics: {
      enabled: true,
      solver: "forceAtlas2Based",
      forceAtlas2Based: {
        gravitationalConstant: -46,
        centralGravity: 0.012,
        springLength: 140,
        springConstant: 0.08,
        damping: 0.6,        // higher damping => gentler settle when nodes arrive
        avoidOverlap: 0.7
      },
      stabilization: { enabled: true, iterations: 200, fit: true },
      minVelocity: 0.7,
      timestep: 0.4
    },
    interaction: {
      hover: true,
      dragNodes: true,
      dragView: true,
      zoomView: true,
      tooltipDelay: 120,
      hoverConnectedEdges: true,
      navigationButtons: false,
      keyboard: false
    }
  };
}

/* ================================================================== *
 *  Status panel — totals currently ON SCREEN, not just last request
 * ================================================================== */

function updateStatus(graph) {
  const total = nodesDS ? nodesDS.length : graph.nodes.length;
  const links = edgesDS ? edgesDS.length : graph.edges.length;
  const focus = graph.seed || "—";

  els.statusSeed.textContent =
    focus + " · " + total + " artist" + (total === 1 ? "" : "s") +
    " · " + links + " link" + (links === 1 ? "" : "s");
}

/* ================================================================== *
 *  Loading + toast helpers
 * ================================================================== */

function showLoading(on) {
  els.loading.classList.toggle("show", !!on);
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5200);
}

function hideToast() {
  els.toast.classList.remove("show");
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
}

/* ================================================================== *
 *  Reset back to the hero landing state (clears the live graph)
 * ================================================================== */

function resetToHero() {
  els.graphView.classList.remove("is-visible");
  setTimeout(function () {
    els.graphView.hidden = true;
    els.status.hidden = true;
  }, 420);

  els.hero.classList.remove("is-hidden");
  els.heroInput.value = "";
  els.heroInput.focus();
  hideToast();

  // Wipe the canvas so the next search starts a brand-new exploration.
  if (nodesDS) nodesDS.clear();
  if (edgesDS) edgesDS.clear();
  currentSeedId = null;
  hasRendered = false;
}

/* ================================================================== *
 *  Wire up events
 * ================================================================== */

els.heroForm.addEventListener("submit", function (e) {
  e.preventDefault();
  searchArtist(els.heroInput.value);
});

els.dockForm.addEventListener("submit", function (e) {
  e.preventDefault();
  searchArtist(els.dockInput.value);
});

els.chips.addEventListener("click", function (e) {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const name = chip.getAttribute("data-artist");
  els.heroInput.value = name;
  searchArtist(name);
});

els.brand.addEventListener("click", resetToHero);

window.addEventListener("DOMContentLoaded", function () {
  els.heroInput.focus();
});
