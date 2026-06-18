"use strict";

const COLOR = {
  paper:  "#EDEFF4",
  mist:   "#8A94A6",
  line:   "#283044",
  panel:  "#141A28",
  signal: "#5EE6C5",
  pulse:  "#B98AFF"
};

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

let network = null;
let nodesDS = null;
let edgesDS = null;
let currentSeedId = null;
let hasRendered = false;
let inFlight = false;
let toastTimer = null;
let physicsTimer = null;
let pinnedActive = false;

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

const _phCache = new Map();
function placeholderFor(name, isSeed) {
  const accent = isSeed ? COLOR.signal : COLOR.pulse;
  const letter = initialOf(name);
  const key = letter + (isSeed ? "|s" : "|p");
  const cached = _phCache.get(key);
  if (cached) return cached;

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
        "font-weight='700' fill='" + accent + "'>" + escapeHtml(letter) + "</text>" +
    "</svg>";
  const uri = "data:image/svg+xml," + encodeURIComponent(svg);
  _phCache.set(key, uri);
  return uri;
}

function makeTooltip(innerHtml) {
  const el = document.createElement("div");
  el.className = "tt";
  el.innerHTML = innerHtml;
  return el;
}

function scheduleFreeze(ms) {
  clearTimeout(physicsTimer);
  physicsTimer = setTimeout(freeze, ms);
}

function freeze() {
  clearTimeout(physicsTimer);
  physicsTimer = null;
  if (!network) return;
  network.setOptions({ physics: { enabled: false } });
  if (pinnedActive) {
    const unpin = [];
    nodesDS.forEach(function (nd) { if (nd.fixed) unpin.push({ id: nd.id, fixed: false }); });
    if (unpin.length) nodesDS.update(unpin);
    pinnedActive = false;
  }
}

async function searchArtist(name, isExpansion = false) {
  const artist = (name || "").trim();
  if (!artist || inFlight) return;

  if (!isExpansion && network) {
    network.destroy();
    network = null;
    nodesDS = null;
    edgesDS = null;
    currentSeedId = null;
    els.status.hidden = true;
  }

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

    applyGraph(graph, isExpansion);
  } catch (err) {
    showToast(err.message || "Something went wrong. Please try again.");
  } finally {
    inFlight = false;
    showLoading(false);
  }
}

function nodeVisual(id, name, imageUrl, isSeed) {
  const accent = isSeed ? COLOR.signal : COLOR.pulse;
  const dimBorder = isSeed
    ? "rgba(94, 230, 197, 0.30)"
    : "rgba(185, 138, 255, 0.25)";
  const image = imageUrl || placeholderFor(name, isSeed);
  return {
    id: id,
    name: name,
    imageUrl: imageUrl || "",
    isSeed: isSeed,
    accent: accent,
    dimBorder: dimBorder,
    shape: "circularImage",
    image: image,
    brokenImage: placeholderFor(name, isSeed),
    size: isSeed ? 34 : 20,
    borderWidth: isSeed ? 5 : 2,
    borderWidthSelected: isSeed ? 7 : 3,
    color: {
      border: dimBorder,
      background: COLOR.panel,
      highlight: { border: COLOR.paper, background: COLOR.panel },
      hover:     { border: accent,      background: COLOR.panel }
    },
    title: makeTooltip(
      '<div class="tt-name">' + escapeHtml(name) +
      (isSeed ? ' <span class="tt-seed">focus</span>' : "") + "</div>"
    ),
    shadow: isSeed
      ? { enabled: true, color: "rgba(94,230,197,0.45)", size: 24, x: 0, y: 0 }
      : { enabled: false }
  };
}

function styleEdge(e, nameById, seedId, isExpansion) {
  const lo = Math.min(e.from, e.to);
  const hi = Math.max(e.from, e.to);
  const weight = Number(e.weight) > 0 ? Number(e.weight) : 1;
  
  let customLength = undefined;
  
  if (isExpansion && nodesDS) {
    const neighborId = e.from === seedId ? e.to : (e.to === seedId ? e.from : null);
    if (neighborId !== null && nodesDS.get(neighborId)) {
      customLength = 340;
    }
  }

  return {
    id: lo + "_" + hi,
    from: e.from,
    to: e.to,
    width: Math.min(1 + weight, 12),
    length: customLength, 
    title: buildEdgeTooltip(e, nameById),
    color: {
      color: "rgba(40, 48, 68, 0.25)",
      inherit: false,
      opacity: 0.25
    }
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

function applyGraph(graph, isExpansion) {
  const seedId = (graph.seed_id != null)
    ? graph.seed_id
    : (graph.nodes[0] && graph.nodes[0].id);

  const nameById = {};
  graph.nodes.forEach(function (n) { nameById[n.id] = n.label || n.name || ""; });

  const firstRender = (network === null);

  let anchor = null;
  if (!firstRender && nodesDS.get(seedId)) {
    const p = network.getPositions([seedId]);
    if (p && p[seedId]) anchor = p[seedId];
  }

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

  const edgeUpserts = graph.edges.map(function (e) { 
    return styleEdge(e, nameById, seedId, isExpansion); 
  });

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
      if (node && node.name) searchArtist(node.name, true); 
    });

    network.on("hoverNode", function (params) {
      els.network.style.cursor = "pointer";
      const hoveredId = params.node;
      
      const connectedNodes = network.getConnectedNodes(hoveredId);
      const connectedEdges = network.getConnectedEdges(hoveredId);

      const nUpdates = [];
      nodesDS.forEach(function (nd) {
        const isTarget = (nd.id === hoveredId || connectedNodes.includes(nd.id));
        nUpdates.push({
          id: nd.id,
          color: {
            border: isTarget ? nd.accent : "rgba(40, 48, 68, 0.12)",
            background: isTarget ? COLOR.panel : "rgba(20, 26, 40, 0.15)"
          }
        });
      });

      const eUpdates = [];
      edgesDS.forEach(function (ed) {
        const isTarget = connectedEdges.includes(ed.id);
        eUpdates.push({
          id: ed.id,
          color: {
            color: isTarget ? COLOR.pulse : "rgba(40, 48, 68, 0.03)",
            opacity: isTarget ? 0.95 : 0.03
          }
        });
      });

      nodesDS.update(nUpdates);
      edgesDS.update(eUpdates);
    });

    network.on("hoverEdge", function (params) {
      els.network.style.cursor = "pointer";
      const hoveredEdgeId = params.edge;

      const eUpdates = [];
      edgesDS.forEach(function (ed) {
        const isTarget = (ed.id === hoveredEdgeId);
        eUpdates.push({
          id: ed.id,
          color: {
            color: isTarget ? COLOR.pulse : "rgba(40, 48, 68, 0.05)",
            opacity: isTarget ? 1.0 : 0.05
          }
        });
      });
      edgesDS.update(eUpdates);
    });

    network.on("blurEdge", function () {
      els.network.style.cursor = "default";
      const eUpdates = [];
      edgesDS.forEach(function (ed) {
        eUpdates.push({
          id: ed.id,
          color: { color: "rgba(40, 48, 68, 0.25)", opacity: 0.25 }
        });
      });
      edgesDS.update(eUpdates);
    });

    network.on("blurNode", function () {
      els.network.style.cursor = "default";
      
      const nUpdates = [];
      nodesDS.forEach(function (nd) {
        nUpdates.push({
          id: nd.id,
          color: {
            border: nd.dimBorder,
            background: COLOR.panel
          }
        });
      });

      const eUpdates = [];
      edgesDS.forEach(function (ed) {
        eUpdates.push({
          id: ed.id,
          color: { color: "rgba(40, 48, 68, 0.25)", opacity: 0.25 }
        });
      });

      nodesDS.update(nUpdates);
      edgesDS.update(eUpdates);
    });

    scheduleFreeze(1800);
  } else {
    const pins = [];
    nodesDS.forEach(function (nd) { pins.push({ id: nd.id, fixed: true }); });
    if (pins.length) { nodesDS.update(pins); pinnedActive = true; }

    if (currentSeedId != null && currentSeedId !== seedId) {
      const prev = nodesDS.get(currentSeedId);
      if (prev) nodesDS.update(nodeVisual(prev.id, prev.name, prev.imageUrl, false));
    }

    nodesDS.update(nodeUpserts);
    edgesDS.update(edgeUpserts);

    network.setOptions({ physics: { enabled: true, stabilization: false } });
    scheduleFreeze(1500);
  }

  currentSeedId = seedId;
  updateStatus(graph);
  els.dockInput.value = graph.seed || "";
}

function networkOptions() {
  return {
    autoResize: true,
    layout: { improvedLayout: false },
    nodes: {
      shapeProperties: { interpolation: true, useBorderWithImage: true }
    },
    edges: {
      color: { color: "rgba(40, 48, 68, 0.25)", inherit: false, opacity: 0.25 },
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
        damping: 0.6,
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
      tooltipDelay: 40,
      hoverConnectedEdges: false,
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: true,
      navigationButtons: false,
      keyboard: false
    }
  };
}

function updateStatus(graph) {
  const total = nodesDS ? nodesDS.length : graph.nodes.length;
  const links = edgesDS ? edgesDS.length : graph.edges.length;
  const focus = graph.seed || "—";

  els.statusSeed.textContent =
    focus + " · " + total + " artist" + (total === 1 ? "" : "s") +
    " · " + links + " link" + (links === 1 ? "" : "s");
}

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

  clearTimeout(physicsTimer);
  physicsTimer = null;
  pinnedActive = false;
  if (network) { network.destroy(); network = null; }
  nodesDS = null;
  edgesDS = null;
  currentSeedId = null;
  hasRendered = false;
}

els.heroForm.addEventListener("submit", function (e) {
  e.preventDefault();
  searchArtist(els.heroInput.value, false);
});

els.dockForm.addEventListener("submit", function (e) {
  e.preventDefault();
  searchArtist(els.dockInput.value, false);
});

els.chips.addEventListener("click", function (e) {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const name = chip.getAttribute("data-artist");
  els.heroInput.value = name;
  searchArtist(name, false);
});

els.brand.addEventListener("click", resetToHero);

window.addEventListener("DOMContentLoaded", function () {
  els.heroInput.focus();
});
