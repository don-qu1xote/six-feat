"use strict";

// ─── Constants ───────────────────────────────────────────────────────────────

const COLOR = {
  paper:  "#EDEFF4",
  mist:   "#8A94A6",
  line:   "#283044",
  panel:  "#141A28",
  signal: "#5EE6C5",
  pulse:  "#B98AFF",
  amber:  "#FFD27A",
  warn:   "#FF8FA3",
  ink:    "#0B0E14"
};

const ROLE_COLOR = {
  featured: COLOR.signal,
  producer: COLOR.pulse,
  writer:   COLOR.amber,
  primary:  COLOR.mist
};

const ROLE_PRIORITY = ["featured", "producer", "writer", "primary"];

const LAYOUTS = {
  FORCE:   "forceAtlas2Based",
  RADIAL:  "radial",
  HIERARCH:"hierarchical"
};

const MAX_HISTORY = 5;
const SEARCH_DEBOUNCE_MS = 300;
const PHYSICS_FREEZE_MS  = 18000;

// ─── State ───────────────────────────────────────────────────────────────────

const State = {
  network:        null,
  nodesDS:        null,
  edgesDS:        null,
  currentSeedId:  null,
  hasRendered:    false,
  inFlight:       false,
  toastTimer:     null,
  physicsTimer:   null,
  physicsActive:  true,
  currentLayout:  LAYOUTS.FORCE,

  // Raw graph data for in-memory ops
  graphNodes:     [],   // {id, label, imageUrl, isSeed, weight}
  graphEdges:     [],   // {id, from, to, weight, collaborations, dominantRole}

  // Interaction
  focusedNodeId:  null,
  pinnedNodes:    new Set(),
  pathHighlight:  null,  // {from, to, path:[ids]}

  // Filters
  activeFilters:  new Set(["featured", "producer", "writer", "primary"]),

  // Search history
  history:        [],

  // Find-path UI
  pathFrom:       null,
  pathTo:         null
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const els = {
  hero:         document.getElementById("hero"),
  heroForm:     document.getElementById("hero-form"),
  heroInput:    document.getElementById("hero-input"),
  chips:        document.getElementById("chips"),

  graphView:    document.getElementById("graph-view"),
  brand:        document.getElementById("brand"),
  dockForm:     document.getElementById("dock-form"),
  dockInput:    document.getElementById("dock-input"),

  network:      document.getElementById("network"),
  status:       document.getElementById("status"),
  statusSeed:   document.getElementById("status-seed"),

  loading:      document.getElementById("loading"),
  toast:        document.getElementById("toast"),

  // New: filter toggles
  filterBar:    document.getElementById("filter-bar"),
  filterFeatured: document.getElementById("filter-featured"),
  filterProducer: document.getElementById("filter-producer"),
  filterWriter:   document.getElementById("filter-writer"),

  // New: layout switcher
  layoutBar:    document.getElementById("layout-bar"),
  layoutForce:  document.getElementById("layout-force"),
  layoutRadial: document.getElementById("layout-radial"),
  layoutHier:   document.getElementById("layout-hier"),

  // New: action buttons
  btnExportPng:   document.getElementById("btn-export-png"),
  btnExportJson:  document.getElementById("btn-export-json"),
  btnClearGraph:  document.getElementById("btn-clear-graph"),
  btnCopyLink:    document.getElementById("btn-copy-link"),
  btnFindPath:    document.getElementById("btn-find-path"),
  btnFitView:     document.getElementById("btn-fit-view"),

  // History panel
  historyList:  document.getElementById("history-list"),

  // Node search (Cmd+K)
  nodeSearchOverlay: document.getElementById("node-search-overlay"),
  nodeSearchInput:   document.getElementById("node-search-input"),
  nodeSearchResults: document.getElementById("node-search-results"),

  // Path finder
  pathPanel:    document.getElementById("path-panel"),
  pathFromInput:document.getElementById("path-from-input"),
  pathToInput:  document.getElementById("path-to-input"),
  btnRunPath:   document.getElementById("btn-run-path"),
  btnClearPath: document.getElementById("btn-clear-path"),
  pathResult:   document.getElementById("path-result")
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function initialOf(name) {
  const m = (name || "").trim().match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : "?").toUpperCase();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ─── Placeholder image ───────────────────────────────────────────────────────

const _phCache = new Map();
function placeholderFor(name, isSeed) {
  const accent = isSeed ? COLOR.signal : COLOR.pulse;
  const letter = initialOf(name);
  const key = letter + (isSeed ? "|s" : "|p");
  if (_phCache.has(key)) return _phCache.get(key);
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'>" +
    "<rect width='120' height='120' fill='#0F1420'/>" +
    "<circle cx='60' cy='60' r='54' fill='none' stroke='" + accent + "' stroke-opacity='0.30' stroke-width='2'/>" +
    "<text x='60' y='60' dy='.35em' text-anchor='middle' font-family='Inter,sans-serif' font-size='52' font-weight='700' fill='" + accent + "'>" + escapeHtml(letter) + "</text>" +
    "</svg>";
  const uri = "data:image/svg+xml," + encodeURIComponent(svg);
  _phCache.set(key, uri);
  return uri;
}

// ─── Role helpers ────────────────────────────────────────────────────────────

function dominantRole(collaborations) {
  const roleSet = new Set();
  for (const c of (collaborations || [])) {
    for (const r of (c.roles || [])) roleSet.add(r.toLowerCase());
  }
  for (const r of ROLE_PRIORITY) if (roleSet.has(r)) return r;
  return "primary";
}

function roleColor(role) {
  return ROLE_COLOR[role] || COLOR.mist;
}

function edgeColorForRole(role) {
  return roleColor(role);
}

function isEdgeVisible(edge) {
  return State.activeFilters.has(edge.dominantRole);
}

// ─── Node sizing by edge weight ───────────────────────────────────────────────

function computeNodeSizes() {
  if (!State.graphNodes.length) return;
  const weightMap = new Map();
  for (const e of State.graphEdges) {
    weightMap.set(e.from, (weightMap.get(e.from) || 0) + e.weight);
    weightMap.set(e.to,   (weightMap.get(e.to)   || 0) + e.weight);
  }
  const weights = [...weightMap.values()];
  const maxW = Math.max(...weights, 1);
  const minR = 16, maxR = 46;
  for (const n of State.graphNodes) {
    const w = weightMap.get(n.id) || 1;
    n.computedRadius = n.isSeed
      ? maxR
      : Math.round(lerp(minR, maxR * 0.8, Math.sqrt(w) / Math.sqrt(maxW)));
    n.totalWeight = w;
  }
}

// ─── Tooltip builders ─────────────────────────────────────────────────────────

function makeTooltip(innerHtml) {
  const el = document.createElement("div");
  el.className = "tt";
  el.innerHTML = innerHtml;
  return el;
}

function buildNodeTooltip(node) {
  return makeTooltip(
    '<div class="tt-name">' + escapeHtml(node.name) +
    (node.isSeed ? ' <span class="tt-seed">focus</span>' : "") +
    '</div>' +
    (node.totalWeight ? '<div class="tt-meta">' + node.totalWeight + ' collab' + (node.totalWeight === 1 ? '' : 's') + '</div>' : '') +
    '<div class="tt-hint">dbl-click to expand · right-click to pin · ctrl+click for Genius</div>'
  );
}

function buildEdgeTooltip(e, nameById) {
  const fromName = nameById[e.from] || "?";
  const toName   = nameById[e.to]   || "?";
  const collabs  = Array.isArray(e.collaborations) ? e.collaborations : [];
  const weight   = Number(e.weight) > 0 ? Number(e.weight) : collabs.length;
  let rows = "";
  for (const c of collabs) {
    const roles = Array.isArray(c.roles) ? c.roles : [];
    const pills = roles.map(r => {
      const slug = String(r).toLowerCase().replace(/[^a-z0-9]/g, "");
      return '<span class="tt-role tt-role--' + slug + '">' + escapeHtml(r) + "</span>";
    }).join("");
    rows += '<li class="tt-row"><span class="tt-song">' + escapeHtml(c.song || "Untitled") +
      "</span><span class='tt-roles'>" + pills + "</span></li>";
  }
  if (!rows) rows = '<li class="tt-empty">No track details available.</li>';
  return makeTooltip(
    '<div class="tt-head"><span class="tt-name">' + escapeHtml(fromName) + '</span>' +
    '<span class="tt-x">×</span><span class="tt-name">' + escapeHtml(toName) + '</span></div>' +
    '<div class="tt-meta">' + weight + " shared track" + (weight === 1 ? "" : "s") + "</div>" +
    '<ul class="tt-list">' + rows + "</ul>"
  );
}

// ─── Node visual builder ──────────────────────────────────────────────────────

function nodeVisual(nodeData) {
  const { id, name, imageUrl, isSeed, computedRadius, pinnedNodes } = nodeData;
  const radius    = computedRadius || (isSeed ? 34 : 20);
  const accent    = isSeed ? COLOR.signal : COLOR.pulse;
  const dimBorder = isSeed ? "rgba(94,230,197,0.30)" : "rgba(185,138,255,0.25)";
  const isPinned  = State.pinnedNodes.has(id);
  const image     = (imageUrl || placeholderFor(name, isSeed));

  const label = isPinned ? "📌 " + name : name;

  return {
    id, name,
    label,
    imageUrl: imageUrl || "",
    isSeed, accent, dimBorder,
    shape: "circularImage",
    image,
    brokenImage: placeholderFor(name, isSeed),
    size:        radius,
    borderWidth: isSeed ? 5 : 2,
    borderWidthSelected: isSeed ? 7 : 3,
    color: {
      border:    dimBorder,
      background: COLOR.panel,
      highlight: { border: COLOR.paper, background: COLOR.panel },
      hover:     { border: accent,      background: COLOR.panel }
    },
    font: {
      color:     "#00000000",  // labels hidden; we rely on tooltips
      size:      0
    },
    title: buildNodeTooltip(nodeData),
    shadow: isSeed
      ? { enabled: true, color: "rgba(94,230,197,0.45)", size: 24, x: 0, y: 0 }
      : { enabled: false },
    fixed: State.pinnedNodes.has(id)
  };
}

// ─── Edge visual builder ─────────────────────────────────────────────────────

function edgeVisual(e, nameById) {
  const lo = Math.min(e.from, e.to);
  const hi = Math.max(e.from, e.to);
  const weight  = Number(e.weight) > 0 ? Number(e.weight) : 1;
  const role    = e.dominantRole || dominantRole(e.collaborations);
  const visible = State.activeFilters.has(role);
  const color   = edgeColorForRole(role);

  return {
    id: lo + "_" + hi,
    from: e.from,
    to:   e.to,
    width: Math.min(1 + Math.sqrt(weight) * 2, 10),
    title: buildEdgeTooltip(e, nameById),
    color: {
      color:   visible ? color : "rgba(0,0,0,0)",
      opacity: visible ? 0.35 : 0,
      inherit: false
    },
    _role:  role,
    _color: color
  };
}

// ─── Physics / layout options ─────────────────────────────────────────────────

function networkOptions(layout) {
  const base = {
    autoResize: true,
    layout:     { improvedLayout: false },
    nodes: {
      shapeProperties: { interpolation: true, useBorderWithImage: true }
    },
    edges: {
      color:        { inherit: false },
      hoverWidth:   0.8,
      selectionWidth: 1,
      smooth:       { enabled: true, type: "continuous", roundness: 0.5 }
    },
    interaction: {
      hover:              true,
      dragNodes:          true,
      dragView:           true,
      zoomView:           true,
      tooltipDelay:       40,
      hoverConnectedEdges: false,
      hideEdgesOnDrag:    true,
      hideEdgesOnZoom:    true,
      navigationButtons:  false,
      keyboard:           false,
      multiselect:        false
    }
  };

  if (layout === LAYOUTS.HIERARCH) {
    return {
      ...base,
      layout: {
        hierarchical: {
          enabled:          true,
          direction:        "UD",
          sortMethod:       "directed",
          levelSeparation:  120,
          nodeSpacing:      140,
          treeSpacing:      180
        }
      },
      physics: { enabled: false }
    };
  }

  if (layout === LAYOUTS.RADIAL) {
    return {
      ...base,
      layout: { improvedLayout: false },
      physics: {
        enabled: true,
        solver: "repulsion",
        repulsion: {
          centralGravity: 0.3,
          springLength:   200,
          springConstant: 0.04,
          nodeDistance:   180,
          damping:        0.8
        },
        stabilization: { enabled: true, iterations: 150, fit: true }
      }
    };
  }

  // Default: forceAtlas2Based
  return {
    ...base,
    physics: {
      enabled: true,
      solver: "forceAtlas2Based",
      forceAtlas2Based: {
        gravitationalConstant: -46,
        centralGravity:        0.012,
        springLength:          140,
        springConstant:        0.08,
        damping:               0.6,
        avoidOverlap:          0.7
      },
      stabilization: { enabled: true, iterations: 200, fit: true },
      minVelocity: 0.7,
      timestep:    0.4
    }
  };
}

// ─── Physics control ──────────────────────────────────────────────────────────

function scheduleFreeze(ms) {
  clearTimeout(State.physicsTimer);
  State.physicsTimer = setTimeout(freezePhysics, ms);
}

function freezePhysics() {
  clearTimeout(State.physicsTimer);
  State.physicsTimer = null;
  if (!State.network) return;
  State.network.setOptions({ physics: { enabled: false } });
  State.physicsActive = false;
  syncPhysicsButton();
}

function unfreezePhysics() {
  if (!State.network) return;
  State.network.setOptions({ physics: { enabled: true, stabilization: false } });
  State.physicsActive = true;
  syncPhysicsButton();
  scheduleFreeze(3000);
}

function togglePhysics() {
  if (State.physicsActive) freezePhysics();
  else unfreezePhysics();
}

function syncPhysicsButton() {
  const btn = document.getElementById("btn-physics");
  if (!btn) return;
  btn.textContent = State.physicsActive ? "⏸ Freeze" : "▶ Unfreeze";
  btn.title = State.physicsActive ? "Space — freeze physics" : "Space — unfreeze physics";
}

// ─── Fetch & graph build ──────────────────────────────────────────────────────

const _searchDebounced = debounce(_doSearch, SEARCH_DEBOUNCE_MS);

function searchArtist(name, isExpansion = false) {
  const artist = (name || "").trim();
  if (!artist || State.inFlight) return;
  _searchDebounced(artist, isExpansion);
}

async function _doSearch(artist, isExpansion) {
  if (!isExpansion && State.network) {
    destroyNetwork();
  }

  State.inFlight = true;
  showLoading(true);
  hideToast();

  try {
    const res = await fetch("/api/v1/graph?artist=" + encodeURIComponent(artist));
    if (!res.ok) {
      let detail = "Request failed (HTTP " + res.status + ").";
      if (res.status === 502) detail = "Couldn't reach Genius. Check the API token.";
      if (res.status === 400) detail = "Please enter an artist name.";
      throw new Error(detail);
    }
    const graph = await res.json();
    if (!graph.nodes || graph.nodes.length === 0) {
      showToast("No collaborations found for " + artist + ". Try another spelling.");
      return;
    }
    applyGraph(graph, isExpansion);
    pushHistory(graph.seed || artist);
    updateShareableUrl(graph.seed || artist);
  } catch (err) {
    showToast(err.message || "Something went wrong. Please try again.");
  } finally {
    State.inFlight = false;
    showLoading(false);
  }
}

// ─── Apply graph data ─────────────────────────────────────────────────────────

function applyGraph(graph, isExpansion) {
  const seedId = (graph.seed_id != null) ? graph.seed_id
    : (graph.nodes[0] && graph.nodes[0].id);

  // Build name lookup
  const nameById = {};
  graph.nodes.forEach(n => { nameById[n.id] = n.label || n.name || ""; });

  const firstRender = (State.network === null);

  // Merge into State.graphNodes / State.graphEdges
  const existingNodeIds = new Set(State.graphNodes.map(n => n.id));
  const existingEdgeKeys = new Set(State.graphEdges.map(e => e.id));

  // Process nodes
  for (const n of graph.nodes) {
    const isSeed = (n.id === seedId);
    if (existingNodeIds.has(n.id)) {
      // Update seed status
      const existing = State.graphNodes.find(x => x.id === n.id);
      if (existing) existing.isSeed = isSeed;
    } else {
      State.graphNodes.push({
        id:       n.id,
        name:     n.label || n.name || "",
        imageUrl: n.image || "",
        isSeed:   isSeed
      });
    }
  }

  // Process edges
  for (const e of graph.edges) {
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    const key = lo + "_" + hi;
    if (!existingEdgeKeys.has(key)) {
      State.graphEdges.push({
        id:             key,
        from:           e.from,
        to:             e.to,
        weight:         e.weight || 1,
        collaborations: e.collaborations || [],
        dominantRole:   dominantRole(e.collaborations)
      });
    }
  }

  // Mark all seed nodes correctly
  State.graphNodes.forEach(n => { n.isSeed = (n.id === seedId); });
  computeNodeSizes();

  // Show UI
  if (!State.hasRendered) {
    showGraphView();
    State.hasRendered = true;
  }

  // Render
  if (firstRender) {
    initNetwork(seedId, nameById);
  } else {
    updateNetwork(seedId, nameById);
  }

  State.currentSeedId = seedId;
  updateStatus(graph);
  els.dockInput.value = graph.seed || "";
  renderHistoryList();
}

function initNetwork(seedId, nameById) {
  const nodeItems = State.graphNodes.map(n => nodeVisual(n));
  const edgeItems = State.graphEdges.map(e => edgeVisual(e, nameById));

  State.nodesDS = new vis.DataSet(nodeItems);
  State.edgesDS = new vis.DataSet(edgeItems);

  State.network = new vis.Network(
    els.network,
    { nodes: State.nodesDS, edges: State.edgesDS },
    networkOptions(State.currentLayout)
  );

  attachNetworkEvents(nameById);
  scheduleFreeze(PHYSICS_FREEZE_MS);
  State.physicsActive = true;
  syncPhysicsButton();
}

function updateNetwork(seedId, nameById) {
  // Pin existing nodes while we update
  const pins = [];
  State.nodesDS.forEach(nd => { if (!nd.fixed) pins.push({ id: nd.id, fixed: true }); });
  if (pins.length) State.nodesDS.update(pins);

  // Upsert
  const nodeItems = State.graphNodes.map(n => nodeVisual(n));
  const edgeItems = State.graphEdges.map(e => edgeVisual(e, nameById));

  State.nodesDS.update(nodeItems);
  State.edgesDS.update(edgeItems);

  // Unpin non-manually-pinned nodes
  const unpin = [];
  State.nodesDS.forEach(nd => {
    if (nd.fixed && !State.pinnedNodes.has(nd.id)) unpin.push({ id: nd.id, fixed: false });
  });
  if (unpin.length) State.nodesDS.update(unpin);

  State.network.setOptions({ physics: { enabled: true, stabilization: false } });
  State.physicsActive = true;
  syncPhysicsButton();
  scheduleFreeze(1500);
}

function attachNetworkEvents(nameById) {
  const net = State.network;

  // Single click: highlight neighborhood
  net.on("click", function(params) {
    if (!params.nodes || params.nodes.length === 0) {
      clearFocus();
      return;
    }
    const nodeId = params.nodes[0];
    const ctrlHeld = params.event && (params.event.ctrlKey || params.event.metaKey);
    if (ctrlHeld) {
      openGeniusPage(nodeId);
      return;
    }
    setFocus(nodeId);
  });

  // Double click: expand
  net.on("doubleClick", function(params) {
    if (!params.nodes || params.nodes.length === 0) return;
    const node = State.nodesDS.get(params.nodes[0]);
    if (node && node.name) searchArtist(node.name, true);
  });

  // Right click: pin
  net.on("oncontext", function(params) {
    params.event.preventDefault();
    if (!params.nodes || params.nodes.length === 0) return;
    togglePin(params.nodes[0]);
  });

  // Hover: highlight neighborhood
  net.on("hoverNode", function(params) {
    els.network.style.cursor = "pointer";
    highlightNeighborhood(params.node, false);
  });

  net.on("hoverEdge", function(params) {
    els.network.style.cursor = "pointer";
    highlightEdge(params.edge);
  });

  net.on("blurNode", function() {
    els.network.style.cursor = "default";
    if (!State.focusedNodeId) restoreDefaultColors();
  });

  net.on("blurEdge", function() {
    els.network.style.cursor = "default";
    if (!State.focusedNodeId) restoreDefaultColors();
  });
}

// ─── Focus & highlight ────────────────────────────────────────────────────────

function setFocus(nodeId) {
  State.focusedNodeId = nodeId;
  highlightNeighborhood(nodeId, true);
}

function clearFocus() {
  State.focusedNodeId = null;
  restoreDefaultColors();
}

function highlightNeighborhood(nodeId, persistent) {
  if (!State.nodesDS || !State.edgesDS) return;
  const connectedNodes = new Set(State.network.getConnectedNodes(nodeId));
  const connectedEdges = new Set(State.network.getConnectedEdges(nodeId));

  const nUpdates = [], eUpdates = [];

  State.nodesDS.forEach(nd => {
    const isTarget = nd.id === nodeId || connectedNodes.has(nd.id);
    nUpdates.push({
      id: nd.id,
      color: {
        border: isTarget ? nd.accent : "rgba(40,48,68,0.10)",
        background: isTarget ? COLOR.panel : "rgba(20,26,40,0.12)"
      },
      opacity: isTarget ? 1 : 0.25
    });
  });

  State.edgesDS.forEach(ed => {
    const isTarget = connectedEdges.has(ed.id);
    const vis = isEdgeVisible(
      State.graphEdges.find(e => e.id === ed.id) || { dominantRole: "primary" }
    );
    eUpdates.push({
      id: ed.id,
      color: {
        color:   isTarget && vis ? ed._color || COLOR.pulse : "rgba(40,48,68,0.03)",
        opacity: isTarget && vis ? 0.95 : 0.03
      }
    });
  });

  State.nodesDS.update(nUpdates);
  State.edgesDS.update(eUpdates);
}

function highlightEdge(edgeId) {
  const eUpdates = [];
  State.edgesDS.forEach(ed => {
    const vis = isEdgeVisible(
      State.graphEdges.find(e => e.id === ed.id) || { dominantRole: "primary" }
    );
    eUpdates.push({
      id: ed.id,
      color: {
        color:   ed.id === edgeId && vis ? ed._color || COLOR.pulse : "rgba(40,48,68,0.04)",
        opacity: ed.id === edgeId && vis ? 1.0 : 0.04
      }
    });
  });
  State.edgesDS.update(eUpdates);
}

function restoreDefaultColors() {
  if (!State.nodesDS || !State.edgesDS) return;
  const nUpdates = [], eUpdates = [];

  State.nodesDS.forEach(nd => {
    nUpdates.push({
      id: nd.id,
      color: { border: nd.dimBorder, background: COLOR.panel },
      opacity: 1
    });
  });

  State.graphEdges.forEach(e => {
    const vis = isEdgeVisible(e);
    const c = edgeColorForRole(e.dominantRole);
    eUpdates.push({
      id: e.id,
      color: {
        color:   vis ? c : "rgba(0,0,0,0)",
        opacity: vis ? 0.35 : 0
      }
    });
  });

  State.nodesDS.update(nUpdates);
  State.edgesDS.update(eUpdates);
}

// ─── Pinning ──────────────────────────────────────────────────────────────────

function togglePin(nodeId) {
  if (State.pinnedNodes.has(nodeId)) {
    State.pinnedNodes.delete(nodeId);
  } else {
    State.pinnedNodes.add(nodeId);
  }
  // Rebuild node visual with pin status
  const gn = State.graphNodes.find(n => n.id === nodeId);
  if (gn) State.nodesDS.update([nodeVisual(gn)]);
  showToast(State.pinnedNodes.has(nodeId)
    ? "📌 Node pinned — right-click again to unpin"
    : "📌 Node unpinned", 2200
  );
}

// ─── Open Genius page ─────────────────────────────────────────────────────────

function openGeniusPage(nodeId) {
  const node = State.graphNodes.find(n => n.id === nodeId);
  if (!node) return;
  const slug = encodeURIComponent(node.name.replace(/\s+/g, "-").toLowerCase());
  window.open("https://genius.com/artists/" + slug, "_blank", "noopener");
}

// ─── Role filtering ───────────────────────────────────────────────────────────

function applyFilters() {
  if (!State.edgesDS) return;
  const updates = [];
  State.graphEdges.forEach(e => {
    const vis = isEdgeVisible(e);
    const c = edgeColorForRole(e.dominantRole);
    updates.push({
      id: e.id,
      color: {
        color:   vis ? c : "rgba(0,0,0,0)",
        opacity: vis ? 0.35 : 0
      }
    });
  });
  State.edgesDS.update(updates);
}

function setupFilterToggles() {
  function makeToggleHandler(role, btn) {
    btn.addEventListener("click", () => {
      if (State.activeFilters.has(role)) {
        State.activeFilters.delete(role);
        btn.classList.remove("active");
      } else {
        State.activeFilters.add(role);
        btn.classList.add("active");
      }
      applyFilters();
    });
    btn.classList.add("active"); // all on by default
  }

  if (els.filterFeatured) makeToggleHandler("featured", els.filterFeatured);
  if (els.filterProducer) makeToggleHandler("producer", els.filterProducer);
  if (els.filterWriter)   makeToggleHandler("writer",   els.filterWriter);
}

// ─── Layout switcher ──────────────────────────────────────────────────────────

function switchLayout(layout) {
  State.currentLayout = layout;
  if (!State.network) return;
  State.network.setOptions(networkOptions(layout));
  if (layout !== LAYOUTS.HIERARCH) {
    State.network.setOptions({ physics: { enabled: true, stabilization: false } });
    State.physicsActive = true;
    syncPhysicsButton();
    scheduleFreeze(2000);
  }
  // Highlight active button
  [els.layoutForce, els.layoutRadial, els.layoutHier].forEach((b, i) => {
    if (!b) return;
    b.classList.toggle("active", [LAYOUTS.FORCE, LAYOUTS.RADIAL, LAYOUTS.HIERARCH][i] === layout);
  });
}

// ─── Node search (Cmd+K) ──────────────────────────────────────────────────────

function openNodeSearch() {
  if (!State.hasRendered) return;
  if (els.nodeSearchOverlay) {
    els.nodeSearchOverlay.classList.add("show");
    if (els.nodeSearchInput) {
      els.nodeSearchInput.value = "";
      els.nodeSearchInput.focus();
      renderNodeSearchResults("");
    }
  }
}

function closeNodeSearch() {
  if (els.nodeSearchOverlay) els.nodeSearchOverlay.classList.remove("show");
}

function renderNodeSearchResults(query) {
  if (!els.nodeSearchResults) return;
  const q = query.toLowerCase().trim();
  const results = q
    ? State.graphNodes.filter(n => n.name.toLowerCase().includes(q)).slice(0, 10)
    : State.graphNodes.slice(0, 10);

  els.nodeSearchResults.innerHTML = results.map(n =>
    '<div class="ns-item" data-id="' + n.id + '">' +
    '<span class="ns-name">' + escapeHtml(n.name) + '</span>' +
    '<span class="ns-weight">' + (n.totalWeight || 0) + ' collab' + (n.totalWeight === 1 ? '' : 's') + '</span>' +
    '</div>'
  ).join("") || '<div class="ns-empty">No nodes match</div>';

  els.nodeSearchResults.querySelectorAll(".ns-item").forEach(item => {
    item.addEventListener("click", () => {
      const id = Number(item.getAttribute("data-id"));
      closeNodeSearch();
      focusOnNode(id);
    });
  });
}

function focusOnNode(nodeId) {
  if (!State.network) return;
  State.network.focus(nodeId, { scale: 1.4, animation: { duration: 600, easingFunction: "easeInOutQuad" } });
  setFocus(nodeId);
}

// ─── BFS pathfinding ──────────────────────────────────────────────────────────

function bfsPath(fromId, toId) {
  // Build adjacency from in-memory graph edges
  const adj = new Map();
  State.graphEdges.forEach(e => {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to))   adj.set(e.to,   []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  });

  if (!adj.has(fromId) || !adj.has(toId)) return null;

  const visited = new Set([fromId]);
  const queue = [[fromId, [fromId]]];

  while (queue.length) {
    const [curr, path] = queue.shift();
    if (curr === toId) return path;
    for (const neighbor of (adj.get(curr) || [])) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, [...path, neighbor]]);
      }
    }
  }
  return null;
}

function highlightPath(path) {
  if (!State.nodesDS || !State.edgesDS || !path) return;
  const pathSet = new Set(path);
  const pathEdges = new Set();

  for (let i = 0; i < path.length - 1; i++) {
    const lo = Math.min(path[i], path[i + 1]);
    const hi = Math.max(path[i], path[i + 1]);
    pathEdges.add(lo + "_" + hi);
  }

  const nUpdates = [], eUpdates = [];

  State.nodesDS.forEach(nd => {
    nUpdates.push({
      id: nd.id,
      color: {
        border: pathSet.has(nd.id) ? COLOR.signal : "rgba(40,48,68,0.10)",
        background: COLOR.panel
      },
      opacity: pathSet.has(nd.id) ? 1 : 0.18
    });
  });

  State.edgesDS.forEach(ed => {
    const inPath = pathEdges.has(ed.id);
    eUpdates.push({
      id: ed.id,
      color: {
        color:   inPath ? COLOR.signal : "rgba(40,48,68,0.03)",
        opacity: inPath ? 1 : 0.03
      },
      width: inPath ? 4 : undefined
    });
  });

  State.nodesDS.update(nUpdates);
  State.edgesDS.update(eUpdates);
}

function clearPathHighlight() {
  State.pathHighlight = null;
  State.pathFrom = null;
  State.pathTo   = null;
  restoreDefaultColors();
  if (els.pathResult) els.pathResult.textContent = "";
}

// ─── Search history ───────────────────────────────────────────────────────────

function loadHistory() {
  try {
    const raw = localStorage.getItem("feat-atlas-history");
    State.history = raw ? JSON.parse(raw) : [];
  } catch { State.history = []; }
}

function saveHistory() {
  try { localStorage.setItem("feat-atlas-history", JSON.stringify(State.history)); }
  catch { /* quota */ }
}

function pushHistory(name) {
  State.history = [name, ...State.history.filter(h => h !== name)].slice(0, MAX_HISTORY);
  saveHistory();
  renderHistoryList();
}

function renderHistoryList() {
  if (!els.historyList) return;
  if (!State.history.length) {
    els.historyList.innerHTML = '<span class="hist-empty">No recent searches</span>';
    return;
  }
  els.historyList.innerHTML = State.history.map(name =>
    '<div class="hist-item">' +
    '<span class="hist-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>' +
    '<button class="hist-btn" data-artist="' + escapeHtml(name) + '" title="Re-search">+</button>' +
    '</div>'
  ).join("");

  els.historyList.querySelectorAll(".hist-btn").forEach(btn => {
    btn.addEventListener("click", () => searchArtist(btn.getAttribute("data-artist"), false));
  });
}

// ─── Shareable URL ────────────────────────────────────────────────────────────

function updateShareableUrl(artistName) {
  const url = new URL(window.location.href);
  url.searchParams.set("artist", artistName);
  history.replaceState(null, "", url.toString());
}

function loadArtistFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const artist = params.get("artist");
  if (artist) {
    els.heroInput.value = artist;
    searchArtist(artist, false);
  }
}

function copyShareableLink() {
  navigator.clipboard.writeText(window.location.href)
    .then(() => showToast("🔗 Link copied to clipboard!", 2200))
    .catch(() => showToast("Copy this URL: " + window.location.href, 4000));
}

// ─── Export ───────────────────────────────────────────────────────────────────

function exportPng() {
  if (!State.network) { showToast("No graph to export yet."); return; }
  try {
    const canvas = els.network.querySelector("canvas");
    if (!canvas) { showToast("Canvas not found."); return; }
    const link  = document.createElement("a");
    link.download = "feature-atlas.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (e) {
    showToast("Export failed: " + e.message);
  }
}

function exportJson() {
  if (!State.graphNodes.length) { showToast("No graph to export yet."); return; }
  const data = {
    exported:  new Date().toISOString(),
    seedArtist: els.dockInput.value,
    nodes: State.graphNodes.map(n => ({ id: n.id, name: n.name, imageUrl: n.imageUrl })),
    edges: State.graphEdges.map(e => ({
      from: e.from, to: e.to, weight: e.weight,
      dominantRole: e.dominantRole, collaborations: e.collaborations
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = "feature-atlas.json";
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
}

// ─── Graph clear ─────────────────────────────────────────────────────────────

function clearGraph() {
  resetToHero();
}

// ─── View helpers ─────────────────────────────────────────────────────────────

function fitView() {
  if (State.network) State.network.fit({ animation: { duration: 500, easingFunction: "easeInOutQuad" } });
}

function focusSeed() {
  if (State.network && State.currentSeedId != null) {
    State.network.focus(State.currentSeedId, { scale: 1.2, animation: { duration: 500, easingFunction: "easeInOutQuad" } });
  }
}

function zoomIn() {
  if (!State.network) return;
  const s = State.network.getScale();
  State.network.moveTo({ scale: s * 1.25, animation: { duration: 250, easingFunction: "easeInOutQuad" } });
}

function zoomOut() {
  if (!State.network) return;
  const s = State.network.getScale();
  State.network.moveTo({ scale: s * 0.8, animation: { duration: 250, easingFunction: "easeInOutQuad" } });
}

// ─── UI lifecycle ─────────────────────────────────────────────────────────────

function showGraphView() {
  els.hero.classList.add("is-hidden");
  els.graphView.hidden = false;
  requestAnimationFrame(() => els.graphView.classList.add("is-visible"));
  els.status.hidden = false;
}

function destroyNetwork() {
  clearTimeout(State.physicsTimer);
  State.physicsTimer = null;
  if (State.network) { State.network.destroy(); State.network = null; }
  State.nodesDS = null;
  State.edgesDS = null;
  State.graphNodes = [];
  State.graphEdges = [];
  State.currentSeedId = null;
  State.focusedNodeId = null;
  State.pinnedNodes.clear();
  State.pathHighlight = null;
  State.hasRendered = false;
  State.physicsActive = true;
}

function resetToHero() {
  els.graphView.classList.remove("is-visible");
  setTimeout(() => {
    els.graphView.hidden = true;
    els.status.hidden = true;
  }, 420);
  els.hero.classList.remove("is-hidden");
  els.heroInput.value = "";
  els.heroInput.focus();
  hideToast();
  destroyNetwork();
  // Clear URL
  history.replaceState(null, "", window.location.pathname);
}

function updateStatus(graph) {
  const total = State.nodesDS ? State.nodesDS.length : graph.nodes.length;
  const links  = State.edgesDS ? State.edgesDS.length : graph.edges.length;
  const focus  = graph.seed || "—";
  els.statusSeed.textContent =
    focus + " · " + total + " artist" + (total === 1 ? "" : "s") +
    " · " + links + " link" + (links === 1 ? "" : "s");
}

function showLoading(on) {
  els.loading.classList.toggle("show", !!on);
}

function showToast(message, ms = 5200) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  if (State.toastTimer) clearTimeout(State.toastTimer);
  State.toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  els.toast.classList.remove("show");
  if (State.toastTimer) { clearTimeout(State.toastTimer); State.toastTimer = null; }
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

function setupKeyboard() {
  document.addEventListener("keydown", e => {
    const tag = document.activeElement && document.activeElement.tagName;
    const inInput = tag === "INPUT" || tag === "TEXTAREA";

    // Cmd/Ctrl+K — node search
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      if (els.nodeSearchOverlay && els.nodeSearchOverlay.classList.contains("show")) {
        closeNodeSearch();
      } else {
        openNodeSearch();
      }
      return;
    }

    if (inInput) return;

    switch (e.key) {
      case "Escape":
        if (els.nodeSearchOverlay && els.nodeSearchOverlay.classList.contains("show")) {
          closeNodeSearch();
        } else if (State.pathHighlight) {
          clearPathHighlight();
        } else {
          focusSeed();
        }
        break;
      case "f": case "F":
        fitView();
        break;
      case "+": case "=":
        zoomIn();
        break;
      case "-": case "_":
        zoomOut();
        break;
      case " ":
        e.preventDefault();
        togglePhysics();
        break;
    }
  });
}

// ─── Path panel UI ────────────────────────────────────────────────────────────

function setupPathPanel() {
  if (!els.btnFindPath) return;

  els.btnFindPath.addEventListener("click", () => {
    if (els.pathPanel) els.pathPanel.classList.toggle("show");
  });

  if (els.btnRunPath) {
    els.btnRunPath.addEventListener("click", () => {
      const fromName = els.pathFromInput ? els.pathFromInput.value.trim() : "";
      const toName   = els.pathToInput   ? els.pathToInput.value.trim()   : "";
      if (!fromName || !toName) { showToast("Enter both artists to find a path."); return; }

      const fromNode = State.graphNodes.find(n => n.name.toLowerCase() === fromName.toLowerCase());
      const toNode   = State.graphNodes.find(n => n.name.toLowerCase() === toName.toLowerCase());

      if (!fromNode) { showToast("Artist " + fromName + " not in current graph."); return; }
      if (!toNode)   { showToast("Artist " + toName   + " not in current graph."); return; }

      const path = bfsPath(fromNode.id, toNode.id);

      if (!path) {
        if (els.pathResult) els.pathResult.textContent = "No path found — artists may not be connected in the current graph.";
        restoreDefaultColors();
        return;
      }

      State.pathHighlight = { from: fromNode.id, to: toNode.id, path };
      highlightPath(path);

      const names = path.map(id => {
        const n = State.graphNodes.find(x => x.id === id);
        return n ? n.name : String(id);
      });

      if (els.pathResult) {
        els.pathResult.textContent = "Path (" + (path.length - 1) + " hop" + (path.length - 1 === 1 ? "" : "s") + "): " + names.join(" → ");
      }
    });
  }

  if (els.btnClearPath) {
    els.btnClearPath.addEventListener("click", clearPathHighlight);
  }
}

// ─── Node search overlay events ───────────────────────────────────────────────

function setupNodeSearch() {
  if (!els.nodeSearchInput) return;

  const onInput = debounce(e => {
    renderNodeSearchResults(e.target.value);
  }, 120);

  els.nodeSearchInput.addEventListener("input", onInput);

  els.nodeSearchInput.addEventListener("keydown", e => {
    if (e.key === "Escape") closeNodeSearch();
  });

  if (els.nodeSearchOverlay) {
    els.nodeSearchOverlay.addEventListener("click", e => {
      if (e.target === els.nodeSearchOverlay) closeNodeSearch();
    });
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  loadHistory();
  renderHistoryList();
  setupFilterToggles();
  setupKeyboard();
  setupNodeSearch();
  setupPathPanel();

  // Hero form
  els.heroForm.addEventListener("submit", e => {
    e.preventDefault();
    searchArtist(els.heroInput.value, false);
  });

  // Dock form
  els.dockForm.addEventListener("submit", e => {
    e.preventDefault();
    searchArtist(els.dockInput.value, false);
  });

  // Chip buttons
  els.chips.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const name = chip.getAttribute("data-artist");
    els.heroInput.value = name;
    searchArtist(name, false);
  });

  // Brand → back
  els.brand.addEventListener("click", resetToHero);

  // Layout buttons
  if (els.layoutForce)  els.layoutForce.addEventListener("click",  () => switchLayout(LAYOUTS.FORCE));
  if (els.layoutRadial) els.layoutRadial.addEventListener("click", () => switchLayout(LAYOUTS.RADIAL));
  if (els.layoutHier)   els.layoutHier.addEventListener("click",   () => switchLayout(LAYOUTS.HIERARCH));

  // Action buttons
  if (els.btnExportPng)  els.btnExportPng.addEventListener("click",  exportPng);
  if (els.btnExportJson) els.btnExportJson.addEventListener("click",  exportJson);
  if (els.btnClearGraph) els.btnClearGraph.addEventListener("click",  clearGraph);
  if (els.btnCopyLink)   els.btnCopyLink.addEventListener("click",   copyShareableLink);
  if (els.btnFitView)    els.btnFitView.addEventListener("click",    fitView);

  // Physics toggle button
  const btnPhysics = document.getElementById("btn-physics");
  if (btnPhysics) btnPhysics.addEventListener("click", togglePhysics);

  // Node search open button
  const btnNodeSearch = document.getElementById("btn-node-search");
  if (btnNodeSearch) btnNodeSearch.addEventListener("click", openNodeSearch);

  // URL-based auto-search
  loadArtistFromUrl();

  // Focus
  els.heroInput.focus();
}

window.addEventListener("DOMContentLoaded", init);
