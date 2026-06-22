"use strict";

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const COLOR = {
  paper:  "#EDEFF4",
  mist:   "#8A94A6",
  line:   "#283044",
  panel:  "#141A28",
  signal: "#5EE6C5",
  pulse:  "#B98AFF",
  amber:  "#FFD27A",
  warn:   "#FF8FA3",
  neon:   "#FF2D78",   // BFS path
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
  FORCE:    "forceAtlas2Based",
  RADIAL:   "radial",
  HIERARCH: "hierarchical"
};

const MAX_HISTORY       = 5;
const SEARCH_DEBOUNCE   = 300;
const PHYSICS_FREEZE_MS = 18000;
const LONG_PRESS_MS     = 600;  // mobile long-press → pin

// ════════════════════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════════════════════

const State = {
  network:       null,
  nodesDS:       null,
  edgesDS:       null,
  currentSeedId: null,
  hasRendered:   false,
  inFlight:      false,
  toastTimer:    null,
  physicsTimer:  null,
  physicsActive: true,
  currentLayout: LAYOUTS.FORCE,

  // Raw graph data for in-memory operations
  graphNodes: [],  // { id, name, imageUrl, isSeed, weight, computedRadius, totalWeight, geniusUrl, genres, collaborationsCache }
  graphEdges: [],  // { id, from, to, weight, collaborations, dominantRole }

  // Interaction
  focusedNodeId: null,
  pinnedNodes:   new Set(),
  pathHighlight: null,

  // Filters
  activeFilters: new Set(["featured", "producer", "writer", "primary"]),

  // Timeline
  timelineMin: 1980,
  timelineMax: 2025,
  timelineActive: false,

  // History
  history: [],

  // Click timing for single vs double click disambiguation
  _clickTimer:    null,
  _lastClickNode: null
};

// ════════════════════════════════════════════════════════════════════════════
// DOM REFS
// ════════════════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);

const els = {
  hero:       $("hero"),
  heroForm:   $("hero-form"),
  heroInput:  $("hero-input"),
  chips:      $("chips"),

  graphView:  $("graph-view"),
  brand:      $("brand"),
  dockForm:   $("dock-form"),
  dockInput:  $("dock-input"),

  network:    $("network"),
  status:     $("status"),
  statusSeed: $("status-seed"),
  loading:    $("loading"),
  toast:      $("toast"),

  // Filters
  filterFeatured: $("filter-featured"),
  filterProducer: $("filter-producer"),
  filterWriter:   $("filter-writer"),

  // Layout
  layoutForce:  $("layout-force"),
  layoutRadial: $("layout-radial"),
  layoutHier:   $("layout-hier"),

  // Actions
  btnExportPng:  $("btn-export-png"),
  btnExportJson: $("btn-export-json"),
  btnClearGraph: $("btn-clear-graph"),
  btnCopyLink:   $("btn-copy-link"),
  btnFindPath:   $("btn-find-path"),
  btnFitView:    $("btn-fit-view"),
  btnTimeline:   $("btn-timeline"),

  // History
  historyList: $("history-list"),

  // Artist sidebar
  artistSidebar:  $("artist-sidebar"),
  sidebarAvatar:  $("sidebar-avatar"),
  sidebarName:    $("sidebar-name"),
  sidebarMeta:    $("sidebar-meta"),
  sidebarTracks:  $("sidebar-tracks"),
  sidebarRoles:   $("sidebar-roles"),
  sidebarGenius:  $("sidebar-genius-btn"),
  sidebarClose:   $("sidebar-close"),

  // Path finder
  pathPanel:     $("path-panel"),
  pathFromInput: $("path-from-input"),
  pathToInput:   $("path-to-input"),
  btnRunPath:    $("btn-run-path"),
  btnClearPath:  $("btn-clear-path"),
  pathResult:    $("path-result"),

  // Timeline
  timelinePanel: $("timeline-panel"),
  timelineMin:   $("timeline-min"),
  timelineMax:   $("timeline-max"),
  timelineYears: $("timeline-years"),

  // Node search (Cmd+K)
  nodeSearchOverlay: $("node-search-overlay"),
  nodeSearchInput:   $("node-search-input"),
  nodeSearchResults: $("node-search-results")
};

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

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

// ────────────────────────────────────────────────────────────────────────────
// Placeholder avatar SVG
// ────────────────────────────────────────────────────────────────────────────
const _phCache = new Map();

function placeholderFor(name, isSeed) {
  const accent = isSeed ? COLOR.signal : COLOR.pulse;
  const letter = initialOf(name);
  const key    = letter + (isSeed ? "|s" : "|p");
  if (_phCache.has(key)) return _phCache.get(key);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'>` +
    `<rect width='120' height='120' fill='#0F1420'/>` +
    `<circle cx='60' cy='60' r='54' fill='none' stroke='${accent}' stroke-opacity='0.30' stroke-width='2'/>` +
    `<text x='60' y='60' dy='.35em' text-anchor='middle' font-family='Inter,sans-serif' font-size='52' font-weight='700' fill='${accent}'>${escapeHtml(letter)}</text>` +
    `</svg>`;
  const uri = "data:image/svg+xml," + encodeURIComponent(svg);
  _phCache.set(key, uri);
  return uri;
}

// ────────────────────────────────────────────────────────────────────────────
// Role helpers
// ────────────────────────────────────────────────────────────────────────────
function dominantRole(collaborations) {
  const roleSet = new Set();
  for (const c of (collaborations || [])) {
    for (const r of (c.roles || [])) roleSet.add(r.toLowerCase());
  }
  for (const r of ROLE_PRIORITY) if (roleSet.has(r)) return r;
  return "primary";
}

function allRoles(collaborations) {
  const roleSet = new Set();
  for (const c of (collaborations || [])) {
    for (const r of (c.roles || [])) roleSet.add(r.toLowerCase());
  }
  return [...roleSet];
}

function roleColor(role) { return ROLE_COLOR[role] || COLOR.mist; }
function edgeColorForRole(role) { return roleColor(role); }

function isEdgeVisible(edge) {
  if (!State.activeFilters.has(edge.dominantRole)) return false;
  if (State.timelineActive && edge.release_year != null) {
    if (edge.release_year < State.timelineMin || edge.release_year > State.timelineMax) return false;
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// NODE SIZING  (Stage 1.1)
// Radius scaled via scaleLinear by sum of collaboration_count on all edges
// ════════════════════════════════════════════════════════════════════════════

function computeNodeSizes() {
  if (!State.graphNodes.length) return;

  const weightMap = new Map();
  for (const e of State.graphEdges) {
    // Use collaboration_count if present (richer signal), else edge weight
    const w = e.collaboration_count != null ? e.collaboration_count : (e.weight || 1);
    weightMap.set(e.from, (weightMap.get(e.from) || 0) + w);
    weightMap.set(e.to,   (weightMap.get(e.to)   || 0) + w);
  }

  const weights = [...weightMap.values()];
  const maxW = Math.max(...weights, 1);
  const minR = 14, maxR = 48;

  for (const n of State.graphNodes) {
    const w = weightMap.get(n.id) || 1;
    n.totalWeight = w;
    n.computedRadius = n.isSeed
      ? maxR
      : Math.round(lerp(minR, maxR * 0.78, Math.sqrt(w) / Math.sqrt(maxW)));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TOOLTIP BUILDERS
// ════════════════════════════════════════════════════════════════════════════

function makeTooltipEl(innerHtml) {
  const el = document.createElement("div");
  el.className = "tt";
  el.innerHTML = innerHtml;
  return el;
}

function buildNodeTooltip(node) {
  return makeTooltipEl(
    `<div class="tt-name">${escapeHtml(node.name)}` +
    (node.isSeed ? ' <span class="tt-seed">focus</span>' : "") +
    `</div>` +
    (node.totalWeight
      ? `<div class="tt-meta">${node.totalWeight} collab${node.totalWeight === 1 ? "" : "s"}</div>`
      : "") +
    `<div class="tt-hint">click legend · dbl-click expand · right-click pin · ctrl+click Genius</div>`
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
      return `<span class="tt-role tt-role--${slug}">${escapeHtml(r)}</span>`;
    }).join("");
    rows += `<li class="tt-row"><span class="tt-song">${escapeHtml(c.song || "Untitled")}</span><span class="tt-roles">${pills}</span></li>`;
  }
  if (!rows) rows = `<li class="tt-empty">No track details available.</li>`;

  return makeTooltipEl(
    `<div class="tt-head"><span class="tt-name">${escapeHtml(fromName)}</span>` +
    `<span class="tt-x">×</span><span class="tt-name">${escapeHtml(toName)}</span></div>` +
    `<div class="tt-meta">${weight} shared track${weight === 1 ? "" : "s"}</div>` +
    `<ul class="tt-list">${rows}</ul>`
  );
}

// ════════════════════════════════════════════════════════════════════════════
// NODE VISUAL
// ════════════════════════════════════════════════════════════════════════════

function nodeVisual(nodeData) {
  const { id, name, imageUrl, isSeed, computedRadius } = nodeData;
  const radius  = computedRadius || (isSeed ? 36 : 20);
  const accent  = isSeed ? COLOR.signal : COLOR.pulse;
  const dimBorder = isSeed ? "rgba(94,230,197,0.30)" : "rgba(185,138,255,0.25)";
  const isPinned  = State.pinnedNodes.has(id);
  const image = imageUrl || placeholderFor(name, isSeed);

  return {
    id,
    // Expose these for restoreDefaultColors to read back
    _name:      name,
    _accent:    accent,
    _dimBorder: dimBorder,
    label: isPinned ? "📌" : "",   // tiny pin indicator only; names via sidebar
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
      color: isPinned ? accent : "#00000000",
      size:  isPinned ? 11 : 0,
      vadjust: radius + 6,
      align: "center"
    },
    title: buildNodeTooltip({ ...nodeData, computedRadius: radius }),
    shadow: isSeed
      ? { enabled: true, color: "rgba(94,230,197,0.40)", size: 22, x: 0, y: 0 }
      : { enabled: false },
    fixed: State.pinnedNodes.has(id) ? { x: true, y: true } : false
  };
}

// ════════════════════════════════════════════════════════════════════════════
// EDGE VISUAL
// ════════════════════════════════════════════════════════════════════════════

function edgeVisual(e, nameById) {
  const lo     = Math.min(e.from, e.to);
  const hi     = Math.max(e.from, e.to);
  const weight = Number(e.weight) > 0 ? Number(e.weight) : 1;
  const role   = e.dominantRole || dominantRole(e.collaborations);
  const vis    = isEdgeVisible(e);
  const color  = edgeColorForRole(role);

  return {
    id: lo + "_" + hi,
    from: e.from,
    to:   e.to,
    width: Math.min(1 + Math.sqrt(weight) * 1.8, 9),
    title: buildEdgeTooltip(e, nameById),
    color: {
      color:   vis ? color : "rgba(0,0,0,0)",
      opacity: vis ? 0.35  : 0,
      inherit: false
    },
    _role:  role,
    _color: color
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PHYSICS / LAYOUT OPTIONS
// ════════════════════════════════════════════════════════════════════════════

function networkOptions(layout) {
  const base = {
    autoResize: true,
    layout:  { improvedLayout: false },
    nodes:   { shapeProperties: { interpolation: true, useBorderWithImage: true } },
    edges: {
      color:          { inherit: false },
      hoverWidth:     0.8,
      selectionWidth: 1,
      smooth:         { enabled: true, type: "continuous", roundness: 0.5 }
    },
    interaction: {
      hover:               true,
      dragNodes:           true,
      dragView:            true,
      zoomView:            true,
      tooltipDelay:        50,
      hoverConnectedEdges: false,
      hideEdgesOnDrag:     true,
      hideEdgesOnZoom:     true,
      navigationButtons:   false,
      keyboard:            false,
      multiselect:         false
    }
  };

  if (layout === LAYOUTS.HIERARCH) {
    return {
      ...base,
      layout: {
        hierarchical: {
          enabled:         true,
          direction:       "UD",
          sortMethod:      "directed",
          levelSeparation: 120,
          nodeSpacing:     140,
          treeSpacing:     180
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
        solver:  "repulsion",
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
      solver:  "forceAtlas2Based",
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

// ════════════════════════════════════════════════════════════════════════════
// PHYSICS CONTROL
// ════════════════════════════════════════════════════════════════════════════

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

function unfreezePhysics(alpha = 0) {
  if (!State.network) return;
  State.network.setOptions({ physics: { enabled: true, stabilization: false } });
  State.physicsActive = true;
  syncPhysicsButton();
  scheduleFreeze(3500);
}

function togglePhysics() {
  if (State.physicsActive) freezePhysics();
  else unfreezePhysics();
}

function syncPhysicsButton() {
  const btn = $("btn-physics");
  if (!btn) return;
  btn.textContent = State.physicsActive ? "⏸" : "▶";
  btn.title = State.physicsActive ? "Space — freeze physics" : "Space — unfreeze physics";
  btn.classList.toggle("active", !State.physicsActive);
}

// ════════════════════════════════════════════════════════════════════════════
// FETCH & GRAPH BUILD
// ════════════════════════════════════════════════════════════════════════════

const _searchDebounced = debounce(_doSearch, SEARCH_DEBOUNCE);

function searchArtist(name, isExpansion = false) {
  const artist = (name || "").trim();
  if (!artist || State.inFlight) return;
  _searchDebounced(artist, isExpansion);
}

async function _doSearch(artist, isExpansion) {
  if (!isExpansion && State.network) destroyNetwork();

  State.inFlight = true;
  showLoading(true);
  hideToast();

  try {
    // Build URL with active role filters to save bandwidth
    const roles = [...State.activeFilters].join(",");
    const url   = `/api/v1/graph?artist=${encodeURIComponent(artist)}&role_filter=${encodeURIComponent(roles)}`;
    const res   = await fetch(url);
    if (!res.ok) {
      let msg = `Request failed (HTTP ${res.status}).`;
      if (res.status === 502) msg = "Couldn't reach Genius. Check the API token.";
      if (res.status === 400) msg = "Please enter an artist name.";
      throw new Error(msg);
    }
    const graph = await res.json();
    if (!graph.nodes || graph.nodes.length === 0) {
      showToast(`No collaborations found for "${artist}". Try another spelling.`);
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

// ════════════════════════════════════════════════════════════════════════════
// APPLY GRAPH DATA
// ════════════════════════════════════════════════════════════════════════════

function applyGraph(graph, isExpansion) {
  const seedId = graph.seed_id != null
    ? graph.seed_id
    : (graph.nodes[0] && graph.nodes[0].id);

  // Build name lookup
  const nameById = {};
  graph.nodes.forEach(n => { nameById[n.id] = n.label || n.name || ""; });

  const firstRender = (State.network === null);
  const existingNodeIds  = new Set(State.graphNodes.map(n => n.id));
  const existingEdgeKeys = new Set(State.graphEdges.map(e => e.id));

  // ── Merge nodes ──────────────────────────────────────────────────────────
  for (const n of graph.nodes) {
    const isSeed = (n.id === seedId);
    if (existingNodeIds.has(n.id)) {
      const ex = State.graphNodes.find(x => x.id === n.id);
      if (ex) ex.isSeed = isSeed;
    } else {
      State.graphNodes.push({
        id:        n.id,
        name:      n.label || n.name || "",
        imageUrl:  n.image || "",
        geniusUrl: n.genius_url || null,
        genres:    Array.isArray(n.genres) ? n.genres : [],
        isSeed
      });
    }
  }

  // ── Merge edges ──────────────────────────────────────────────────────────
  for (const e of graph.edges) {
    const lo  = Math.min(e.from, e.to);
    const hi  = Math.max(e.from, e.to);
    const key = `${lo}_${hi}`;
    if (!existingEdgeKeys.has(key)) {
      State.graphEdges.push({
        id:                  key,
        from:                e.from,
        to:                  e.to,
        weight:              e.weight || 1,
        collaboration_count: e.collaboration_count || null,
        release_year:        e.release_year || null,
        collaborations:      e.collaborations || [],
        dominantRole:        dominantRole(e.collaborations)
      });
    }
  }

  // Mark seed
  State.graphNodes.forEach(n => { n.isSeed = (n.id === seedId); });
  computeNodeSizes();

  // Cache collaborations per node for the sidebar (Stage 1.2)
  cacheNodeCollaborations();

  if (!State.hasRendered) {
    showGraphView();
    State.hasRendered = true;
  }

  if (firstRender) initNetwork(seedId, nameById);
  else             updateNetwork(seedId, nameById);

  State.currentSeedId = seedId;
  updateStatus(graph);
  els.dockInput.value = graph.seed || "";
  renderHistoryList();
  updateTimelineRange();
}

// Build a per-node cache: top tracks + role set from edges
function cacheNodeCollaborations() {
  for (const n of State.graphNodes) {
    const edgesForNode = State.graphEdges.filter(e => e.from === n.id || e.to === n.id);
    const allCollabs   = edgesForNode.flatMap(e => e.collaborations || []);

    // Sort by popularity (prefer collabs with higher weight)
    const scored = allCollabs.map(c => ({
      ...c,
      _popularity: Number(c.popularity || c.views || 0)
    })).sort((a, b) => b._popularity - a._popularity);

    n._topTracks  = scored.slice(0, 3);
    n._rolesSet   = new Set(edgesForNode.flatMap(e => allRoles(e.collaborations)));
    n._totalCollabs = edgesForNode.reduce((s, e) => s + (e.collaboration_count || e.weight || 1), 0);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// VIS NETWORK LIFECYCLE
// ════════════════════════════════════════════════════════════════════════════

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
  // Freeze existing nodes temporarily to avoid jumps
  const pins = [];
  State.nodesDS.forEach(nd => { if (!nd.fixed) pins.push({ id: nd.id, fixed: true }); });
  if (pins.length) State.nodesDS.update(pins);

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

  // Soft re-ignite physics (alpha 0.3 style)
  State.network.setOptions({ physics: { enabled: true, stabilization: false } });
  State.physicsActive = true;
  syncPhysicsButton();
  scheduleFreeze(2500);
}

// ════════════════════════════════════════════════════════════════════════════
// NETWORK EVENTS
// ════════════════════════════════════════════════════════════════════════════

function attachNetworkEvents(nameById) {
  const net = State.network;

  // ── Click logic: single vs double click disambiguation ───────────────────
  // Single → sidebar + focus highlight (no fetch)
  // Double → expand (fetch)
  // Ctrl/Cmd → Genius

  net.on("click", function(params) {
    if (!params.nodes || params.nodes.length === 0) {
      clearFocus();
      return;
    }
    const nodeId  = params.nodes[0];
    const ctrlKey = params.event && (params.event.ctrlKey || params.event.metaKey);

    if (ctrlKey) {
      openGeniusPage(nodeId);
      return;
    }

    // Disambiguate single vs double click
    if (State._clickTimer && State._lastClickNode === nodeId) {
      // Second click on same node quickly → treat as double
      clearTimeout(State._clickTimer);
      State._clickTimer    = null;
      State._lastClickNode = null;
      // Expand
      const gn = State.graphNodes.find(n => n.id === nodeId);
      if (gn) searchArtist(gn.name, true);
    } else {
      clearTimeout(State._clickTimer);
      State._lastClickNode = nodeId;
      State._clickTimer = setTimeout(() => {
        State._clickTimer    = null;
        State._lastClickNode = null;
        // Single click action: show sidebar + highlight neighborhood
        setFocus(nodeId);
        showArtistSidebar(nodeId);
      }, 260);
    }
  });

  // Double-click fallback (in case vis fires doubleClick separately)
  net.on("doubleClick", function(params) {
    clearTimeout(State._clickTimer);
    State._clickTimer    = null;
    State._lastClickNode = null;
    if (!params.nodes || params.nodes.length === 0) return;
    const gn = State.graphNodes.find(n => n.id === params.nodes[0]);
    if (gn) searchArtist(gn.name, true);
  });

  // Right-click → pin
  net.on("oncontext", function(params) {
    params.event.preventDefault();
    if (!params.nodes || params.nodes.length === 0) return;
    togglePin(params.nodes[0]);
  });

  // Long press on mobile → pin
  let _touchTimer = null, _touchNodeId = null;
  net.on("hold", function(params) {
    if (!params.nodes || params.nodes.length === 0) return;
    togglePin(params.nodes[0]);
  });

  // Hover effects
  net.on("hoverNode", function(params) {
    els.network.style.cursor = "pointer";
    if (!State.focusedNodeId) highlightNeighborhood(params.node, false);
  });
  net.on("hoverEdge", function(params) {
    els.network.style.cursor = "pointer";
    if (!State.focusedNodeId) highlightEdge(params.edge);
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

// ════════════════════════════════════════════════════════════════════════════
// ARTIST SIDEBAR  (Stage 1.2)
// ════════════════════════════════════════════════════════════════════════════

function showArtistSidebar(nodeId) {
  const node = State.graphNodes.find(n => n.id === nodeId);
  if (!node) return;

  // Hide path panel if open to avoid overlap
  els.pathPanel.classList.remove("show");

  // Avatar
  els.sidebarAvatar.src    = node.imageUrl || placeholderFor(node.name, node.isSeed);
  els.sidebarAvatar.alt    = node.name;
  els.sidebarName.textContent = node.name;

  const collab = node._totalCollabs || node.totalWeight || 0;
  const genres = (node.genres || []).slice(0, 3).join(", ");
  els.sidebarMeta.textContent =
    `${collab} collab${collab === 1 ? "" : "s"}` + (genres ? ` · ${genres}` : "");

  // Top tracks
  const tracks = node._topTracks || [];
  if (tracks.length) {
    els.sidebarTracks.innerHTML = tracks.map(t => {
      const roles = (t.roles || []);
      const mainRole = roles[0] ? roles[0].toLowerCase() : "primary";
      const slug = mainRole.replace(/[^a-z0-9]/g, "");
      return `<div class="sidebar-track">
        <span class="sidebar-track-name">${escapeHtml(t.song || "Untitled")}</span>
        <span class="sidebar-track-role role-chip--${slug}">${escapeHtml(roles[0] || "primary")}</span>
      </div>`;
    }).join("");
  } else {
    els.sidebarTracks.innerHTML = `<div style="color:var(--mist);font-size:12px;">No track data cached.</div>`;
  }

  // Roles
  const roles = [...(node._rolesSet || [])];
  els.sidebarRoles.innerHTML = roles.length
    ? roles.map(r => `<span class="sidebar-role-chip role-chip--${r.replace(/[^a-z0-9]/g, "")}">${escapeHtml(r)}</span>`).join("")
    : `<span style="color:var(--mist);font-size:11px;">—</span>`;

  // Genius button
  els.sidebarGenius.onclick = () => openGeniusPage(nodeId);

  els.artistSidebar.classList.add("show");
}

function hideArtistSidebar() {
  els.artistSidebar.classList.remove("show");
}

// ════════════════════════════════════════════════════════════════════════════
// FOCUS & HIGHLIGHT
// ════════════════════════════════════════════════════════════════════════════

function setFocus(nodeId) {
  State.focusedNodeId = nodeId;
  highlightNeighborhood(nodeId, true);
}

function clearFocus() {
  State.focusedNodeId = null;
  hideArtistSidebar();
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
      id:      nd.id,
      color:   { border: isTarget ? (nd._accent || nd.accent || COLOR.pulse) : "rgba(40,48,68,0.10)", background: isTarget ? COLOR.panel : "rgba(20,26,40,0.12)" },
      opacity: isTarget ? 1 : 0.1
    });
  });

  State.edgesDS.forEach(ed => {
    const isTarget = connectedEdges.has(ed.id);
    const rawEdge  = State.graphEdges.find(e => e.id === ed.id) || { dominantRole: "primary" };
    const vis      = isEdgeVisible(rawEdge);
    eUpdates.push({
      id:    ed.id,
      color: {
        color:   isTarget && vis ? (ed._color || COLOR.pulse) : "rgba(40,48,68,0.02)",
        opacity: isTarget && vis ? 0.95 : 0.02
      }
    });
  });

  State.nodesDS.update(nUpdates);
  State.edgesDS.update(eUpdates);
}

function highlightEdge(edgeId) {
  if (!State.edgesDS) return;
  const eUpdates = [];
  State.edgesDS.forEach(ed => {
    const rawEdge = State.graphEdges.find(e => e.id === ed.id) || { dominantRole: "primary" };
    const vis     = isEdgeVisible(rawEdge);
    eUpdates.push({
      id:    ed.id,
      color: {
        color:   ed.id === edgeId && vis ? (ed._color || COLOR.pulse) : "rgba(40,48,68,0.03)",
        opacity: ed.id === edgeId && vis ? 1.0 : 0.03
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
      id:      nd.id,
      color:   { border: nd._dimBorder || nd.dimBorder, background: COLOR.panel },
      opacity: 1
    });
  });

  State.graphEdges.forEach(e => {
    const vis = isEdgeVisible(e);
    const c   = edgeColorForRole(e.dominantRole);
    eUpdates.push({
      id:    e.id,
      color: { color: vis ? c : "rgba(0,0,0,0)", opacity: vis ? 0.35 : 0 }
    });
  });

  State.nodesDS.update(nUpdates);
  State.edgesDS.update(eUpdates);
}

// ════════════════════════════════════════════════════════════════════════════
// PINNING  (Stage 2.2)
// ════════════════════════════════════════════════════════════════════════════

function togglePin(nodeId) {
  if (State.pinnedNodes.has(nodeId)) {
    State.pinnedNodes.delete(nodeId);
    if (State.network) State.network.editNode(nodeId, { fixed: false });
  } else {
    const pos = State.network && State.network.getPositions([nodeId]);
    const p   = pos && pos[nodeId];
    State.pinnedNodes.add(nodeId);
    if (State.network && p) {
      State.network.moveNode(nodeId, p.x, p.y);
    }
  }
  const gn = State.graphNodes.find(n => n.id === nodeId);
  if (gn && State.nodesDS) State.nodesDS.update([nodeVisual(gn)]);
  showToast(
    State.pinnedNodes.has(nodeId) ? "📌 Pinned — right-click to unpin" : "Unpinned",
    2000
  );
}

// ════════════════════════════════════════════════════════════════════════════
// GENIUS PAGE  (Stage 2.1)
// ════════════════════════════════════════════════════════════════════════════

function openGeniusPage(nodeId) {
  const node = State.graphNodes.find(n => n.id === nodeId);
  if (!node) return;
  // Prefer a cached genius_url from the API if available
  const url = node.geniusUrl ||
    `https://genius.com/artists/${encodeURIComponent(node.name.replace(/\s+/g, "-").toLowerCase())}`;
  window.open(url, "_blank", "noopener");
}

// ════════════════════════════════════════════════════════════════════════════
// ROLE FILTERING  (Stage 2.2)
// ════════════════════════════════════════════════════════════════════════════

function applyFilters() {
  if (!State.edgesDS) return;
  const updates = [];

  State.graphEdges.forEach(e => {
    const vis = isEdgeVisible(e);
    const c   = edgeColorForRole(e.dominantRole);
    updates.push({ id: e.id, color: { color: vis ? c : "rgba(0,0,0,0)", opacity: vis ? 0.35 : 0 } });
  });
  State.edgesDS.update(updates);

  // Hide nodes that have no visible edges
  hideOrphanNodes();
  updateShareableUrl(els.dockInput.value);
}

function hideOrphanNodes() {
  if (!State.nodesDS || !State.edgesDS) return;
  const visibleEdges = State.graphEdges.filter(isEdgeVisible);
  const connectedIds = new Set();
  for (const e of visibleEdges) { connectedIds.add(e.from); connectedIds.add(e.to); }

  const updates = [];
  State.nodesDS.forEach(nd => {
    const gn = State.graphNodes.find(n => n.id === nd.id);
    const isSeed = gn && gn.isSeed;
    // Seed is always shown; others hidden if disconnected
    const hidden = !isSeed && !connectedIds.has(nd.id);
    updates.push({ id: nd.id, hidden });
  });
  State.nodesDS.update(updates);
}

function setupFilterToggles() {
  function makeToggle(role, btn) {
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
    btn.classList.add("active");
  }
  if (els.filterFeatured) makeToggle("featured", els.filterFeatured);
  if (els.filterProducer) makeToggle("producer", els.filterProducer);
  if (els.filterWriter)   makeToggle("writer",   els.filterWriter);
}

// ════════════════════════════════════════════════════════════════════════════
// LAYOUT SWITCHER  (Stage 3.1)
// ════════════════════════════════════════════════════════════════════════════

function switchLayout(layout) {
  State.currentLayout = layout;
  if (!State.network) return;

  // Disable physics first
  State.network.setOptions({ physics: { enabled: false } });

  // Apply new layout options
  State.network.setOptions(networkOptions(layout));

  if (layout !== LAYOUTS.HIERARCH) {
    // Soft re-enable with alpha-like low energy
    setTimeout(() => {
      State.network.setOptions({ physics: { enabled: true, stabilization: false } });
      State.physicsActive = true;
      syncPhysicsButton();
      scheduleFreeze(3000);
    }, 80);
  } else {
    State.physicsActive = false;
    syncPhysicsButton();
  }

  State.network.fit({ animation: { duration: 500, easingFunction: "easeInOutQuad" } });

  [els.layoutForce, els.layoutRadial, els.layoutHier].forEach((b, i) => {
    if (!b) return;
    b.classList.toggle("active", [LAYOUTS.FORCE, LAYOUTS.RADIAL, LAYOUTS.HIERARCH][i] === layout);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// TIMELINE SLIDER  (Stage 3.3)
// ════════════════════════════════════════════════════════════════════════════

function updateTimelineRange() {
  // Auto-detect min/max year from edges
  const years = State.graphEdges
    .map(e => e.release_year)
    .filter(y => y != null && y > 1900 && y <= new Date().getFullYear());
  if (!years.length) return;
  const minY = Math.min(...years);
  const maxY = Math.max(...years);
  els.timelineMin.min = minY; els.timelineMin.max = maxY; els.timelineMin.value = minY;
  els.timelineMax.min = minY; els.timelineMax.max = maxY; els.timelineMax.value = maxY;
  State.timelineMin = minY; State.timelineMax = maxY;
  els.timelineYears.textContent = `${minY} – ${maxY}`;
}

function setupTimeline() {
  els.btnTimeline && els.btnTimeline.addEventListener("click", () => {
    State.timelineActive = !State.timelineActive;
    els.timelinePanel.classList.toggle("show", State.timelineActive);
    els.btnTimeline.classList.toggle("active", State.timelineActive);
  });

  function onSlider() {
    let min = Number(els.timelineMin.value);
    let max = Number(els.timelineMax.value);
    if (min > max) [min, max] = [max, min];
    State.timelineMin = min;
    State.timelineMax = max;
    els.timelineYears.textContent = `${min} – ${max}`;
    applyFilters();
  }

  els.timelineMin && els.timelineMin.addEventListener("input", onSlider);
  els.timelineMax && els.timelineMax.addEventListener("input", onSlider);
}

// ════════════════════════════════════════════════════════════════════════════
// BFS PATHFINDING  (Stage 2.3)
// ════════════════════════════════════════════════════════════════════════════

function bfsPath(fromId, toId) {
  const adj = new Map();
  State.graphEdges.forEach(e => {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to))   adj.set(e.to,   []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  });

  if (!adj.has(fromId) || !adj.has(toId)) return null;

  const visited = new Set([fromId]);
  const queue   = [[fromId, [fromId]]];

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
  const pathSet   = new Set(path);
  const pathEdges = new Set();

  for (let i = 0; i < path.length - 1; i++) {
    const lo = Math.min(path[i], path[i + 1]);
    const hi = Math.max(path[i], path[i + 1]);
    pathEdges.add(`${lo}_${hi}`);
  }

  const nUpdates = [], eUpdates = [];

  State.nodesDS.forEach(nd => {
    nUpdates.push({
      id:      nd.id,
      color:   { border: pathSet.has(nd.id) ? COLOR.neon : "rgba(40,48,68,0.08)", background: COLOR.panel },
      opacity: pathSet.has(nd.id) ? 1 : 0.12
    });
  });

  State.edgesDS.forEach(ed => {
    const inPath = pathEdges.has(ed.id);
    eUpdates.push({
      id:    ed.id,
      color: { color: inPath ? COLOR.neon : "rgba(40,48,68,0.02)", opacity: inPath ? 1 : 0.02 },
      width: inPath ? 5 : undefined
    });
  });

  State.nodesDS.update(nUpdates);
  State.edgesDS.update(eUpdates);
}

function clearPathHighlight() {
  State.pathHighlight = null;
  restoreDefaultColors();
  if (els.pathResult) els.pathResult.textContent = "";
}

function setupPathPanel() {
  els.btnFindPath && els.btnFindPath.addEventListener("click", () => {
    // Hide sidebar if open to avoid overlap
    hideArtistSidebar();
    els.pathPanel.classList.toggle("show");
  });

  els.btnRunPath && els.btnRunPath.addEventListener("click", () => {
    const fromName = (els.pathFromInput.value || "").trim();
    const toName   = (els.pathToInput.value   || "").trim();
    if (!fromName || !toName) { showToast("Enter both artist names."); return; }

    const fromNode = State.graphNodes.find(n => n.name.toLowerCase() === fromName.toLowerCase());
    const toNode   = State.graphNodes.find(n => n.name.toLowerCase() === toName.toLowerCase());

    if (!fromNode) { showToast(`"${fromName}" not loaded in current graph.`); return; }
    if (!toNode)   { showToast(`"${toName}" not loaded in current graph.`);   return; }

    const path = bfsPath(fromNode.id, toNode.id);
    if (!path) {
      els.pathResult.textContent = "No path found — artists may not be connected.";
      restoreDefaultColors();
      return;
    }

    State.pathHighlight = { from: fromNode.id, to: toNode.id, path };
    highlightPath(path);

    const names = path.map(id => {
      const n = State.graphNodes.find(x => x.id === id);
      return n ? n.name : String(id);
    });
    const hops = path.length - 1;
    els.pathResult.textContent = `${hops} hop${hops === 1 ? "" : "s"}: ${names.join(" → ")}`;
  });

  els.btnClearPath && els.btnClearPath.addEventListener("click", clearPathHighlight);
}

// ════════════════════════════════════════════════════════════════════════════
// NODE SEARCH  (Cmd+K)  (Stage 4.4)
// ════════════════════════════════════════════════════════════════════════════

function openNodeSearch() {
  if (!State.hasRendered) return;
  els.nodeSearchOverlay.classList.add("show");
  els.nodeSearchInput.value = "";
  els.nodeSearchInput.focus();
  renderNodeSearchResults("");
}

function closeNodeSearch() {
  els.nodeSearchOverlay.classList.remove("show");
}

function renderNodeSearchResults(query) {
  const q = query.toLowerCase().trim();
  const results = q
    ? State.graphNodes.filter(n => n.name.toLowerCase().includes(q)).slice(0, 12)
    : State.graphNodes.slice(0, 12);

  els.nodeSearchResults.innerHTML = results.map(n =>
    `<div class="ns-item" data-id="${n.id}">` +
    `<span class="ns-name">${escapeHtml(n.name)}</span>` +
    `<span class="ns-weight">${n.totalWeight || 0} collab${n.totalWeight === 1 ? "" : "s"}</span>` +
    `</div>`
  ).join("") || `<div class="ns-empty">No nodes match</div>`;

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
  State.network.focus(nodeId, { scale: 1.5, animation: { duration: 600, easingFunction: "easeInOutQuad" } });
  setFocus(nodeId);
  showArtistSidebar(nodeId);
}

function setupNodeSearch() {
  const onInput = debounce(e => renderNodeSearchResults(e.target.value), 120);
  els.nodeSearchInput.addEventListener("input", onInput);
  els.nodeSearchInput.addEventListener("keydown", e => { if (e.key === "Escape") closeNodeSearch(); });
  els.nodeSearchOverlay.addEventListener("click", e => {
    if (e.target === els.nodeSearchOverlay) closeNodeSearch();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SEARCH HISTORY  (Stage 4.2)
// ════════════════════════════════════════════════════════════════════════════

function loadHistory() {
  try {
    const raw = localStorage.getItem("feat-atlas-history");
    State.history = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(State.history)) State.history = [];
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

function clearHistory() {
  State.history = [];
  saveHistory();
  renderHistoryList();
}

function renderHistoryList() {
  if (!els.historyList) return;
  if (!State.history.length) {
    els.historyList.innerHTML = `<span class="hist-empty">No recent searches</span>`;
    return;
  }
  els.historyList.innerHTML =
    State.history.map(name =>
      `<div class="hist-item">` +
      `<span class="hist-name" data-artist="${escapeHtml(name)}" title="Re-search ${escapeHtml(name)}">${escapeHtml(name)}</span>` +
      `<button class="hist-btn" data-artist="${escapeHtml(name)}" title="Re-search">↻</button>` +
      `</div>`
    ).join("") +
    `<button class="dock-btn hist-clear-btn" id="btn-hist-clear">Clear history</button>`;

  els.historyList.querySelectorAll("[data-artist]").forEach(el => {
    el.addEventListener("click", () => searchArtist(el.getAttribute("data-artist"), false));
  });
  const clearBtn = $("btn-hist-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => { clearHistory(); });
}

// ════════════════════════════════════════════════════════════════════════════
// SHAREABLE URL  (Stage 4.3)
// ════════════════════════════════════════════════════════════════════════════

function updateShareableUrl(artistName) {
  if (!artistName) return;
  const url = new URL(window.location.href);
  url.searchParams.set("artist", artistName);
  // Also store active filters
  const roles = [...State.activeFilters].sort().join(",");
  url.searchParams.set("roles", roles);
  history.replaceState(null, "", url.toString());
}

function loadArtistFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const artist = params.get("artist");
  const roles  = params.get("roles");

  // Restore role filters from URL
  if (roles) {
    const set = new Set(roles.split(",").map(r => r.trim()).filter(Boolean));
    State.activeFilters = set;
    [els.filterFeatured, els.filterProducer, els.filterWriter].forEach((btn, i) => {
      const role = ["featured", "producer", "writer"][i];
      if (!btn) return;
      btn.classList.toggle("active", State.activeFilters.has(role));
    });
  }

  if (artist) {
    els.heroInput.value = artist;
    searchArtist(artist, false);
  }
}

function copyShareableLink() {
  const url = window.location.href;
  navigator.clipboard.writeText(url)
    .then(() => showToast("🔗 Link copied!", 2000, true))
    .catch(() => showToast(`Copy: ${url}`, 5000));
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORT  (Stage 4.1)
// ════════════════════════════════════════════════════════════════════════════

function exportPng() {
  if (!State.network) { showToast("No graph to export yet."); return; }
  try {
    const canvas = els.network.querySelector("canvas");
    if (!canvas) { showToast("Canvas not found."); return; }

    // Composite: fill dark background then draw graph
    const out = document.createElement("canvas");
    out.width  = canvas.width;
    out.height = canvas.height;
    const ctx  = out.getContext("2d");
    ctx.fillStyle = "#0B0E14";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);

    const link = document.createElement("a");
    link.download = "feature-atlas.png";
    link.href = out.toDataURL("image/png");
    link.click();
  } catch (e) {
    showToast("Export failed: " + e.message);
  }
}

function exportJson() {
  if (!State.graphNodes.length) { showToast("No graph to export yet."); return; }
  const data = {
    exported:   new Date().toISOString(),
    seedArtist: els.dockInput.value,
    nodes: State.graphNodes.map(n => ({ id: n.id, name: n.name, imageUrl: n.imageUrl, genres: n.genres })),
    edges: State.graphEdges.map(e => ({
      from: e.from, to: e.to, weight: e.weight,
      dominantRole: e.dominantRole, collaborations: e.collaborations,
      release_year: e.release_year
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = "feature-atlas.json";
  link.href     = url;
  link.click();
  URL.revokeObjectURL(url);
}

// ════════════════════════════════════════════════════════════════════════════
// VIEW HELPERS
// ════════════════════════════════════════════════════════════════════════════

function fitView() {
  if (State.network) State.network.fit({ animation: { duration: 500, easingFunction: "easeInOutQuad" } });
}

function focusSeed() {
  if (State.network && State.currentSeedId != null) {
    State.network.focus(State.currentSeedId, { scale: 1.2, animation: { duration: 500, easingFunction: "easeInOutQuad" } });
    clearFocus();
  }
}

function zoomIn() {
  if (!State.network) return;
  State.network.moveTo({ scale: State.network.getScale() * 1.25, animation: { duration: 220, easingFunction: "easeInOutQuad" } });
}

function zoomOut() {
  if (!State.network) return;
  State.network.moveTo({ scale: State.network.getScale() * 0.8, animation: { duration: 220, easingFunction: "easeInOutQuad" } });
}

// ════════════════════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS  (Stage 4.4)
// ════════════════════════════════════════════════════════════════════════════

function setupKeyboard() {
  document.addEventListener("keydown", e => {
    const tag     = document.activeElement && document.activeElement.tagName;
    const inInput = tag === "INPUT" || tag === "TEXTAREA";

    // Cmd/Ctrl+K — node search (works even from inputs)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (els.nodeSearchOverlay.classList.contains("show")) closeNodeSearch();
      else openNodeSearch();
      return;
    }

    if (inInput) return;

    switch (e.key) {
      case "Escape":
        if (els.nodeSearchOverlay.classList.contains("show")) { closeNodeSearch(); }
        else if (State.pathHighlight) { clearPathHighlight(); }
        else { focusSeed(); }
        break;
      case "f": case "F": fitView(); break;
      case "+": case "=": zoomIn();  break;
      case "-": case "_": zoomOut(); break;
      case " ":
        e.preventDefault();
        togglePhysics();
        break;
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// UI LIFECYCLE
// ════════════════════════════════════════════════════════════════════════════

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
  State.nodesDS       = null;
  State.edgesDS       = null;
  State.graphNodes    = [];
  State.graphEdges    = [];
  State.currentSeedId = null;
  State.focusedNodeId = null;
  State.pinnedNodes.clear();
  State.pathHighlight = null;
  State.hasRendered   = false;
  State.physicsActive = true;
  hideArtistSidebar();
}

function resetToHero() {
  els.graphView.classList.remove("is-visible");
  setTimeout(() => {
    els.graphView.hidden = true;
    els.status.hidden    = true;
  }, 420);
  els.hero.classList.remove("is-hidden");
  els.heroInput.value = "";
  els.heroInput.focus();
  hideToast();
  hideArtistSidebar();
  els.pathPanel.classList.remove("show");
  els.timelinePanel.classList.remove("show");
  State.timelineActive = false;
  destroyNetwork();
  history.replaceState(null, "", window.location.pathname);
}

function updateStatus(graph) {
  const total = State.nodesDS ? State.nodesDS.length : (graph.nodes || []).length;
  const links  = State.edgesDS ? State.edgesDS.length : (graph.edges || []).length;
  const focus  = graph.seed || "—";
  els.statusSeed.textContent = `${focus} · ${total} artist${total === 1 ? "" : "s"} · ${links} link${links === 1 ? "" : "s"}`;
}

function showLoading(on) {
  els.loading.classList.toggle("show", !!on);
}

function showToast(message, ms = 4800, isInfo = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle("toast--info", isInfo);
  els.toast.classList.add("show");
  if (State.toastTimer) clearTimeout(State.toastTimer);
  State.toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
  els.toast.classList.remove("show", "toast--info");
  if (State.toastTimer) { clearTimeout(State.toastTimer); State.toastTimer = null; }
}

// ════════════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════════════

function init() {
  loadHistory();
  renderHistoryList();
  setupFilterToggles();
  setupKeyboard();
  setupNodeSearch();
  setupPathPanel();
  setupTimeline();

  // Hero form
  els.heroForm.addEventListener("submit", e => {
    e.preventDefault();
    searchArtist(els.heroInput.value, false);
  });

  // Dock form
  els.dockForm.addEventListener("submit", e => {
    e.preventDefault();
    searchArtist(els.dockInput.value, false);
    els.dockInput.blur();
  });

  // Chips
  els.chips.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const name = chip.getAttribute("data-artist");
    els.heroInput.value = name;
    searchArtist(name, false);
  });

  // Brand → back to hero
  els.brand.addEventListener("click", resetToHero);

  // Sidebar close
  els.sidebarClose.addEventListener("click", () => {
    hideArtistSidebar();
    clearFocus();
  });

  // Layout buttons
  els.layoutForce  && els.layoutForce.addEventListener("click",  () => switchLayout(LAYOUTS.FORCE));
  els.layoutRadial && els.layoutRadial.addEventListener("click", () => switchLayout(LAYOUTS.RADIAL));
  els.layoutHier   && els.layoutHier.addEventListener("click",   () => switchLayout(LAYOUTS.HIERARCH));

  // Action buttons
  els.btnExportPng  && els.btnExportPng.addEventListener("click",  exportPng);
  els.btnExportJson && els.btnExportJson.addEventListener("click",  exportJson);
  els.btnClearGraph && els.btnClearGraph.addEventListener("click",  resetToHero);
  els.btnCopyLink   && els.btnCopyLink.addEventListener("click",   copyShareableLink);
  els.btnFitView    && els.btnFitView.addEventListener("click",    fitView);

  // Physics
  const btnPhysics = $("btn-physics");
  if (btnPhysics) btnPhysics.addEventListener("click", togglePhysics);

  // Node search
  const btnNodeSearch = $("btn-node-search");
  if (btnNodeSearch) btnNodeSearch.addEventListener("click", openNodeSearch);

  // URL auto-search
  loadArtistFromUrl();

  // Focus input
  els.heroInput.focus();
}

window.addEventListener("DOMContentLoaded", init);
