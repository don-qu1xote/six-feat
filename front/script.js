"use strict";

// ════════════════════════════════════════════════════════════════════════════
// FEATURE ATLAS — script.js
//
// This pass fixes:
//  A. Duplicate-id crash on expand: was caused by concurrent _doSearch calls
//     when forceImmediate bypassed the inFlight guard. Fix: forceImmediate now
//     only skips the debounce, NOT the inFlight guard.  expand calls queue
//     behind any already-running request via a pending-expand slot.
//  B. Edge visuals reverted to colour + dash only (no arrows, no labels).
//  C. Euler-style layout: expanded nodes placed on a large circle, their
//     shared neighbours seeded at the centroid of their poles, then
//     forceAtlas2Based physics settles everything. Extra inter-expanded
//     repulsion is applied by making expanded nodes temporarily heavier
//     (mass) so the solver pushes them further apart.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const COLOR = {
  paper:  "#EDEFF4",
  // mist:   "#8A94A6",
  line:   "#283044",
  panel:  "#141A28",
  signal: "#5EE6C5",   // featured  — solid green
  pulse:  "#B98AFF",   // producer  — dashed purple
  amber:  "#FFD27A",   // writer    — dotted yellow
  warn:   "#FF8FA3",
  neon:   "#FF2D78",   // BFS path
  ink:    "#0B0E14"
};

// Role → colour + dash pattern
const ROLE_STYLE = {
  featured: { color: COLOR.signal, dash: false               },
  producer: { color: COLOR.pulse,  dash: { length: 8, gap: 5 } },
  writer:   { color: COLOR.amber,  dash: { length: 2, gap: 5 } },
  primary:  { color: COLOR.signal,   dash: false               }
};

const ROLE_ICON = {
  featured: "🎤",
  producer: "🎛",
  writer:   "✍️",
  primary:  ""
};

const ROLE_PRIORITY = ["featured", "producer", "writer", "primary"];

const MAX_HISTORY       = 5;
const SEARCH_DEBOUNCE   = 300;
const PHYSICS_FREEZE_MS = 3000;  // longer settle for multi-pole layouts

// ════════════════════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════════════════════

const State = {
  network:       null,
  nodesDS:       null,
  edgesDS:       null,
  currentSeedId: null,
  hasRendered:   false,

  // FIX A: single in-flight flag; expansion queues behind it
  inFlight:      false,
  pendingExpand: null,   // { name } — queued expand waiting for current request

  toastTimer:    null,
  physicsTimer:  null,

  graphNodes: [],
  graphEdges: [],

  focusedNodeId:  null,
  selectedEdgeId: null,
  pathHighlight:  null,

  activeFilters: new Set(["featured", "producer", "writer"]),

  history: [],

  _clickTimer:    null,
  _lastClickNode: null,

  _bfsAdj:       null,
  _bfsGraphHash: "",

  // Set of node ids the user has expanded (double-clicked)
  // Used for the Euler-layout positioning.
  expandedNodes: new Set(),
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
  statusSeed:    $("status-seed"),
  statusFilters: $("status-filters"),
  loading:    $("loading"),
  toast:      $("toast"),

  filterFeatured: $("filter-featured"),
  filterProducer: $("filter-producer"),
  filterWriter:   $("filter-writer"),

  btnExportPng:  $("btn-export-png"),
  btnExportJson: $("btn-export-json"),
  btnClearGraph: $("btn-clear-graph"),
  btnCopyLink:   $("btn-copy-link"),
  btnFindPath:   $("btn-find-path"),
  btnFitView:    $("btn-fit-view"),

  historyList: $("history-list"),

  artistSidebar:  $("artist-sidebar"),
  sidebarAvatar:  $("sidebar-avatar"),
  sidebarName:    $("sidebar-name"),
  sidebarMeta:    $("sidebar-meta"),
  sidebarTracks:  $("sidebar-tracks"),
  sidebarRoles:   $("sidebar-roles"),
  sidebarGenius:  $("sidebar-genius-btn"),
  sidebarClose:   $("sidebar-close"),

  candidateOverlay: $("candidate-overlay"),
  candidateList:    $("candidate-list"),
  candidateClose:   $("candidate-close"),

  pathPanel:     $("path-panel"),
  pathFromInput: $("path-from-input"),
  pathToInput:   $("path-to-input"),
  btnRunPath:    $("btn-run-path"),
  btnClearPath:  $("btn-clear-path"),
  pathResult:    $("path-result"),

  nodeSearchOverlay: $("node-search-overlay"),
  nodeSearchInput:   $("node-search-input"),
  nodeSearchResults: $("node-search-results")
};

// ════════════════════════════════════════════════════════════════════════════
// SMALL HELPERS
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

function graphHash() {
  return State.graphEdges.map(e => `${e.from}-${e.to}`).sort().join("|");
}

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
    `<text x='60' y='60' dy='.35em' text-anchor='middle' font-family='Inter,sans-serif' ` +
    `font-size='52' font-weight='700' fill='${accent}'>${escapeHtml(letter)}</text>` +
    `</svg>`;
  const uri = "data:image/svg+xml," + encodeURIComponent(svg);
  _phCache.set(key, uri);
  return uri;
}

// ────────────────────────────────────────────────────────────────────────────
// Role helpers
// ────────────────────────────────────────────────────────────────────────────

function dominantRoleFromCollabs(collaborations) {
  const set = new Set();
  for (const c of (collaborations || []))
    for (const r of (c.roles || [])) set.add(r.toLowerCase());
  for (const r of ROLE_PRIORITY) if (set.has(r)) return r;
  return "primary";
}

function allRolesFromCollabs(collaborations) {
  const set = new Set();
  for (const c of (collaborations || []))
    for (const r of (c.roles || [])) set.add(r.toLowerCase());
  return [...set];
}

function roleStyle(role) { return ROLE_STYLE[role] || ROLE_STYLE.primary; }

// ════════════════════════════════════════════════════════════════════════════
// NODE SIZING
// ════════════════════════════════════════════════════════════════════════════

function computeNodeSizes() {
  if (!State.graphNodes.length) return;

  const weightMap = new Map();
  for (const e of State.graphEdges) {
    const w = e.collaboration_count ?? (e.weight || 1);
    weightMap.set(e.from, (weightMap.get(e.from) || 0) + w);
    weightMap.set(e.to,   (weightMap.get(e.to)   || 0) + w);
  }

  const maxW = Math.max(...weightMap.values(), 1);
  const minR = 14, maxR = 48;

  for (const n of State.graphNodes) {
    const w = n._backendWeight || weightMap.get(n.id) || 1;
    n.totalWeight    = w;
    n.computedRadius = n.isSeed
      ? maxR
      : Math.round(lerp(minR, maxR * 0.78, Math.sqrt(w) / Math.sqrt(maxW)));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TOOLTIP BUILDERS
// ════════════════════════════════════════════════════════════════════════════

function buildNodeTooltip(node) {
  const el = document.createElement("div");
  el.className = "tt";
  const seedBadge  = node.isSeed ? ` <span class="tt-seed">focus</span>` : "";
  const isExpanded = State.expandedNodes.has(node.id)
    ? `<div class="tt-meta" style="color:var(--signal)">expanded ✓</div>` : "";
  el.innerHTML =
    `<div class="tt-name">${escapeHtml(node.name)}${seedBadge}</div>` +
    (node.totalWeight ? `<div class="tt-meta">${node.totalWeight} collab${node.totalWeight === 1 ? "" : "s"}</div>` : "") +
    isExpanded +
    `<div class="tt-hint">click → details · dbl-click → expand · ctrl+click → Genius</div>`;
  return el;
}

function buildEdgeTooltip(e, nameById) {
  const fromName = nameById[e.from] || "?";
  const toName   = nameById[e.to]   || "?";
  const weight   = Number(e.weight) > 0 ? Number(e.weight) : 1;
  const role     = e.dominantRole || "primary";
  const icon     = ROLE_ICON[role] || "";
  const collabs  = Array.isArray(e.collaborations) ? e.collaborations : [];

  let rows = "";
  for (const c of collabs) {
    const roles = Array.isArray(c.roles) ? c.roles : [];
    const pills = roles.map(r => {
      const slug = String(r).toLowerCase().replace(/[^a-z0-9]/g, "");
      const ico  = ROLE_ICON[slug] || "";
      return `<span class="tt-role tt-role--${slug}">${ico} ${escapeHtml(r)}</span>`;
    }).join("");
    rows += `<li class="tt-row"><span class="tt-song">${escapeHtml(c.song || "Untitled")}</span>` +
            `<span class="tt-roles">${pills}</span></li>`;
  }
  if (!rows) rows = `<li class="tt-empty">No track details available.</li>`;

  const el = document.createElement("div");
  el.className = "tt";
  el.innerHTML =
    `<div class="tt-head"><span class="tt-name">${escapeHtml(fromName)}</span>` +
    `<span class="tt-x"> × </span><span class="tt-name">${escapeHtml(toName)}</span></div>` +
    `<div class="tt-meta">${weight} shared track${weight === 1 ? "" : "s"} ` +
    `<span class="tt-role-badge tt-role-badge--${escapeHtml(role)}">${icon} ${escapeHtml(role)}</span></div>` +
    `<ul class="tt-list">${rows}</ul>` +
    `<div class="tt-hint">click edge → full detail in panel</div>`;
  return el;
}

// ════════════════════════════════════════════════════════════════════════════
// NODE VISUAL
// ════════════════════════════════════════════════════════════════════════════

function nodeVisual(nodeData) {
  const { id, name, imageUrl, isSeed, computedRadius } = nodeData;
  const radius    = computedRadius || (isSeed ? 36 : 20);
  const domRole   = nodeData._dominantRole || (isSeed ? "featured" : "primary");
  const rs        = roleStyle(domRole);
  const accent    = isSeed ? COLOR.signal : rs.color;
  const dimBorder = isSeed ? "rgba(94,230,197,0.45)" : `${rs.color}40`;
  const image     = imageUrl || placeholderFor(name, isSeed);

  // Expanded nodes get a brighter border to signal their status
  const isExpanded = State.expandedNodes.has(id);
  const borderCol  = isExpanded ? accent : dimBorder;

  return {
    id,
    _accent:    accent,
    _dimBorder: dimBorder,
    label:  "",
    shape:  "circularImage",
    image,
    brokenImage: placeholderFor(name, isSeed),
    size:   radius,
    // Expanded nodes get a thicker border as a visual signal
    borderWidth: isExpanded ? 4 : (isSeed ? 5 : 2),
    borderWidthSelected: isExpanded ? 6 : (isSeed ? 7 : 3),
    color: {
      border:     borderCol,
      background: COLOR.panel,
      highlight:  { border: COLOR.paper, background: COLOR.panel },
      hover:      { border: accent,      background: COLOR.panel }
    },
    font:   { color: "#00000000", size: 0 },
    title:  buildNodeTooltip({ ...nodeData, computedRadius: radius }),
    shadow: isSeed
      ? { enabled: true, color: "rgba(94,230,197,0.40)", size: 22, x: 0, y: 0 }
      : isExpanded
        ? { enabled: true, color: `${accent}30`, size: 14, x: 0, y: 0 }
        : { enabled: false },
    opacity: nodeData._isNew ? 0 : 1,
    fixed:   isExpanded 
      ? { x: true, y: true }
      : false,
    // C: expanded nodes get extra mass so the solver pushes them far apart
    mass: State.expandedNodes.has(id)
      ? 50
      : (isSeed ? 4 : 1)
  };
}

// ════════════════════════════════════════════════════════════════════════════
// EDGE VISUAL — B: colour + dash only, no arrows, no labels
// ════════════════════════════════════════════════════════════════════════════

function edgeVisual(e, nameById) {
  const weight = Number(e.weight) > 0 ? Number(e.weight) : 1;
  const role   = e.dominantRole || dominantRoleFromCollabs(e.collaborations);
  const rs     = roleStyle(role);
  const dashes = rs.dash ? [rs.dash.length, rs.dash.gap] : false;

  return {
    id:     e.id,
    from:   e.from,
    to:     e.to,
    width:  Math.min(1 + Math.sqrt(weight) * 1.8, 9),
    title:  buildEdgeTooltip(e, nameById),
    color: {
      color:     rs.color,
      opacity:   0.45,
      inherit:   false,
      hover:     COLOR.paper,
      highlight: COLOR.paper
    },
    smooth: { enabled: true, type: "continuous", roundness: 0.45 },
    _role:  role,
    _color: rs.color
  };
}

// ════════════════════════════════════════════════════════════════════════════
// NETWORK OPTIONS — C: forceAtlas2Based for good multi-cluster behaviour
// High mass on expanded nodes drives the Euler-circle separation without
// needing to manually move nodes after every expand.
// ════════════════════════════════════════════════════════════════════════════

function networkOptions() {
  return {
    autoResize: true,
    layout:  { improvedLayout: false },
    nodes:   { shapeProperties: { interpolation: true, useBorderWithImage: true } },
    edges: {
      color:          { inherit: false },
      hoverWidth:     1.4,
      selectionWidth: 2,
      smooth:         { enabled: true, type: "continuous", roundness: 0.45 }
    },
    interaction: {
      hover:               true,
      dragNodes:           true,
      dragView:            true,
      zoomView:            true,
      tooltipDelay:        120,
      hoverConnectedEdges: true,
      hideEdgesOnDrag:     true,
      hideEdgesOnZoom:     true,
      navigationButtons:   false,
      keyboard:            false,
      multiselect:         false
    },
    physics: {
      enabled: true,
      solver: "forceAtlas2Based",
      forceAtlas2Based: {
        gravitationalConstant: -50,  // Мягкое отталкивание из script-2.js
        centralGravity: 0.01,
        springLength: 180,           // Длина связей из script-2.js
        springConstant: 0.08,
        damping: 0.85,               // Высокое затухание (damping 0.85) останавливает тряску
        avoidOverlap: 1
      },
      stabilization: {
        enabled: true,
        iterations: 100,
        updateInterval: 50,
        fit: false
      },
      timestep: 0.5
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PHYSICS HELPERS
// ════════════════════════════════════════════════════════════════════════════

function scheduleFreeze(ms) {
  clearTimeout(State.physicsTimer);
  State.physicsTimer = setTimeout(() => {
    State.physicsTimer = null;
    if (State.network) State.network.setOptions({ physics: { enabled: false } });
  }, ms);
}

function nudgePhysics(ms = PHYSICS_FREEZE_MS) {
  if (!State.network) return;
  State.network.setOptions({ physics: { enabled: true, stabilization: false } });
  scheduleFreeze(ms);
}

// ════════════════════════════════════════════════════════════════════════════
// FETCH — FIX A: concurrent request protection
//
// Rules:
//  • Normal search (isExpansion=false): if inFlight, drop the request. A
//    debounce already batches rapid typing.
//  • Expansion (isExpansion=true): if inFlight, save as pendingExpand and
//    run it as soon as the current request finishes. At most one pending.
//  • forceImmediate only skips the debounce — it still respects inFlight.
// ════════════════════════════════════════════════════════════════════════════

const _searchDebounced = debounce(_doSearch, SEARCH_DEBOUNCE);

function searchArtist(name, isExpansion = false, forceImmediate = false) {
  const artist = (name || "").trim();
  if (!artist) return;

  if (State.inFlight) {
    if (isExpansion) {
      // Queue this expand; previous pending is discarded (last wins)
      State.pendingExpand = { name: artist };
    }
    // For normal searches while in-flight: silently drop (debounce handles it)
    return;
  }

  if (forceImmediate) {
    _doSearch(artist, isExpansion);
  } else {
    _searchDebounced(artist, isExpansion);
  }
}

async function _doSearch(artist, isExpansion) {
  State.inFlight     = true;
  State.pendingExpand = null;
  showLoading(true);
  hideToast();

  try {
    const roles = [...State.activeFilters].join(",");
    const url   = `/api/v1/graph?artist=${encodeURIComponent(artist)}&roles=${encodeURIComponent(roles)}`;
    const res   = await fetch(url);
    if (!res.ok) {
      let msg = `Request failed (HTTP ${res.status}).`;
      if (res.status === 502) msg = "Couldn't reach Genius. Check the API token.";
      if (res.status === 400) msg = "Please enter an artist name.";
      throw new Error(msg);
    }
    const graph = await res.json();

    if (graph.ambiguous) {
      showCandidatePicker(graph.candidates || [], artist);
      return;
    }
    if (!graph.nodes || graph.nodes.length === 0) {
      showToast(`No collaborations found for "${artist}". Try another spelling.`);
      return;
    }

    if (isExpansion) {
      mergeGraph(graph);
    } else {
      replaceGraph(graph);
      pushHistory(graph.seed || artist);
      updateShareableUrl(graph.seed || artist);
    }
  } catch (err) {
    showToast(err.message || "Something went wrong. Please try again.");
  } finally {
    State.inFlight = false;
    showLoading(false);

    // Run any queued expansion now that we're free
    if (State.pendingExpand) {
      const { name } = State.pendingExpand;
      State.pendingExpand = null;
      _doSearch(name, true);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// CANDIDATE PICKER
// ════════════════════════════════════════════════════════════════════════════

function showCandidatePicker(candidates, originalQuery) {
  if (!els.candidateOverlay || !els.candidateList) return;

  els.candidateList.innerHTML = candidates.slice(0, 6).map(c => {
    const imgSrc = c.image || placeholderFor(c.name, false);
    const score  = c.score != null ? Math.round(c.score * 100) : "";
    return `<div class="candidate-item" data-name="${escapeHtml(c.name)}">
      <img class="candidate-avatar" src="${escapeHtml(imgSrc)}"
           onerror="this.src='${placeholderFor(c.name, false)}'" alt="" />
      <div class="candidate-info">
        <div class="candidate-name">${escapeHtml(c.name)}</div>
        ${score ? `<div class="candidate-score">${score}% match for "${escapeHtml(originalQuery)}"</div>` : ""}
      </div>
    </div>`;
  }).join("");

  els.candidateList.querySelectorAll(".candidate-item").forEach(item => {
    item.addEventListener("click", () => {
      const name = item.getAttribute("data-name");
      hideCandidatePicker();
      searchArtist(name, false, true);
    });
  });

  els.candidateOverlay.classList.add("show");
}

function hideCandidatePicker() {
  if (els.candidateOverlay) els.candidateOverlay.classList.remove("show");
}

// ════════════════════════════════════════════════════════════════════════════
// REPLACE GRAPH — full reset for a new artist search
// ════════════════════════════════════════════════════════════════════════════

function replaceGraph(graph) {
  const seedId = graph.seed_id ?? (graph.nodes[0]?.id);

  const savedPositions = State.network ? State.network.getPositions() : {};
  const nameById = {};
  graph.nodes.forEach(n => { nameById[n.id] = n.label || n.name || ""; });

  // On replace, clear expanded-node history (fresh graph)
  State.expandedNodes.clear();

  const existingIds = new Set(State.graphNodes.map(n => n.id));
  State.graphNodes  = graph.nodes.map(n => buildNodeState(n, seedId, existingIds));
  State.graphEdges  = graph.edges.map(e => buildEdgeState(e));

  finalizeGraphState(seedId, nameById, savedPositions, graph, false);
}

// ════════════════════════════════════════════════════════════════════════════
// MERGE GRAPH — FIX A + C: safe merge with dedup + Euler positioning
// ════════════════════════════════════════════════════════════════════════════

function mergeGraph(graph) {
  const expandedId = graph.seed_id ?? (graph.nodes[0]?.id);

  const savedPositions = State.network ? State.network.getPositions() : {};

  // Snapshot BEFORE any mutation — this is the dedup source of truth
  const existingNodeIds  = new Set(State.graphNodes.map(n => n.id));
  const existingEdgeKeys = new Set(State.graphEdges.map(e => e.id));

  // Build unified name map
  const nameById = {};
  State.graphNodes.forEach(n => { nameById[n.id] = n.name; });
  graph.nodes.forEach(n => { nameById[n.id] = n.label || n.name || ""; });

  // Add new nodes only (strict guard against duplicates)
  for (const n of graph.nodes) {
    if (!existingNodeIds.has(n.id)) {
      State.graphNodes.push(buildNodeState(n, null, existingNodeIds));
    }
    // Node already exists → nothing to do (its position/data is kept)
  }

  // Add new edges only
  for (const e of graph.edges) {
    const lo  = Math.min(e.from, e.to);
    const hi  = Math.max(e.from, e.to);
    const key = `${lo}_${hi}`;
    if (!existingEdgeKeys.has(key)) {
      State.graphEdges.push(buildEdgeState(e));
    }
  }

  // Register as expanded
  State.expandedNodes.add(expandedId);

  finalizeGraphState(State.currentSeedId, nameById, savedPositions, graph, true);
}

// ─── Node / edge state constructors ────────────────────────────────────────

function buildNodeState(n, seedId, existingIds) {
  return {
    id:             n.id,
    name:           n.label || n.name || "",
    imageUrl:       n.image || "",
    geniusUrl:      n.url   || null,
    genres:         [],
    isSeed:         (n.id === seedId),
    _isNew:         existingIds ? !existingIds.has(n.id) : true,
    _backendWeight: n.weight || null
  };
}

function buildEdgeState(e) {
  const lo   = Math.min(e.from, e.to);
  const hi   = Math.max(e.from, e.to);
  const role = e.dominant_role || e.role_priority || dominantRoleFromCollabs(e.collaborations);
  return {
    id:                  `${lo}_${hi}`,
    from:                e.from,
    to:                  e.to,
    weight:              e.weight || 1,
    collaboration_count: e.collaboration_count || null,
    collaborations:      e.collaborations || [],
    dominantRole:        role
  };
}

// ─── Shared finaliser ───────────────────────────────────────────────────────

function finalizeGraphState(seedId, nameById, savedPositions, graph, isMerge) {
  if (seedId != null) {
    State.graphNodes.forEach(n => { n.isSeed = (n.id === seedId); });
  }

  computeNodeSizes();
  cacheNodeCollaborations();
  computeNodeDominantRoles();

  const newHash = graphHash();
  if (newHash !== State._bfsGraphHash) {
    State._bfsAdj       = null;
    State._bfsGraphHash = newHash;
  }

  if (!State.hasRendered) {
    showGraphView();
    State.hasRendered = true;
  }

  if (!State.network) {
    initNetwork(seedId, nameById);
  } else if (isMerge) {
    mergeNetwork(nameById, savedPositions);
  } else {
    refreshNetwork(nameById, savedPositions);
  }

  if (!isMerge) {
    State.currentSeedId = seedId;
    State.focusedNodeId = null;
    hideArtistSidebar();
  }

  updateStatus(graph);
  updateStatusFilters();
  els.dockInput.value = graph.seed || els.dockInput.value;
}

function computeNodeDominantRoles() {
  for (const n of State.graphNodes) {
    const inc = State.graphEdges.filter(e => e.from === n.id || e.to === n.id);
    const counts = {};
    for (const e of inc) counts[e.dominantRole] = (counts[e.dominantRole] || 0) + (e.weight || 1);
    let top = "primary", topC = 0;
    for (const [r, c] of Object.entries(counts)) if (c > topC) { top = r; topC = c; }
    n._dominantRole = n.isSeed ? "featured" : top;
  }
}

function cacheNodeCollaborations() {
  for (const n of State.graphNodes) {
    const inc = State.graphEdges.filter(e => e.from === n.id || e.to === n.id);
    const all = inc.flatMap(e => e.collaborations || []);
    const scored = all.map(c => ({ ...c, _pop: Number(c.popularity || c.views || 0) }))
                      .sort((a, b) => b._pop - a._pop);
    n._topTracks    = scored.slice(0, 5);
    n._rolesSet     = new Set(inc.flatMap(e => allRolesFromCollabs(e.collaborations)));
    n._totalCollabs = inc.reduce((s, e) => s + (e.collaboration_count || e.weight || 1), 0);
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
    networkOptions()
  );

  // FIX-PERF: When edge count is high (>120), throttle vis rendering during
  // zoom/scroll to prevent frame drops. We temporarily disable rendering for
  // 80 ms bursts and re-enable it once the interaction stops.
  // This is separate from hideEdgesOnZoom (which only hides edges during drag).
  _attachZoomThrottle();

  fadeInNewNodes();
  attachNetworkEvents(nameById);
  scheduleFreeze(PHYSICS_FREEZE_MS);
}

// ─── Zoom/scroll rendering throttle for dense graphs ──────────────────────
// vis-network re-renders every frame during zoom even when frozen.
// For graphs with many edges (>120) each frame is expensive.
// Solution: disable rendering while zooming, re-enable 80ms after last event.
let _zoomThrottleTimer = null;
function _attachZoomThrottle() {
  if (!State.network) return;
  State.network.on("zoom", () => {
    if (State.graphEdges.length < 120) return; // only throttle dense graphs
    State.network.stopSimulation();
    if (_zoomThrottleTimer) clearTimeout(_zoomThrottleTimer);
    _zoomThrottleTimer = setTimeout(() => {
      _zoomThrottleTimer = null;
      if (State.network) State.network.redraw();
    }, 80);
  });
}

// Full replace
function refreshNetwork(nameById, savedPositions) {
  const nodeItems = State.graphNodes.map(n => nodeVisual(n));
  const edgeItems = State.graphEdges.map(e => edgeVisual(e, nameById));

  State.nodesDS.clear();
  State.edgesDS.clear();
  State.nodesDS.add(nodeItems);
  State.edgesDS.add(edgeItems);

  for (const n of State.graphNodes) {
    const p = savedPositions[n.id];
    if (p && !n._isNew) State.network.moveNode(n.id, p.x, p.y);
  }

  fadeInNewNodes();
  nudgePhysics();
}

// ────────────────────────────────────────────────────────────────────────────
// mergeNetwork — FIX A: dedup against DataSet ids (not just State arrays)
// C: places expanded nodes on a spread circle, seeds shared neighbours
//    toward the centroid of their poles
// ────────────────────────────────────────────────────────────────────────────

function mergeNetwork(nameById, savedPositions) {
  // Ground truth: what vis currently holds
  const dsNodeIds = new Set(State.nodesDS.getIds());
  const dsEdgeIds = new Set(State.edgesDS.getIds());

  // Only add truly absent items — double-guard
  const newNodeItems = State.graphNodes
    .filter(n => n._isNew && !dsNodeIds.has(n.id))
    .map(n => nodeVisual(n));

  const newEdgeItems = State.graphEdges
    .filter(e => !dsEdgeIds.has(e.id))
    .map(e => edgeVisual(e, nameById));

  if (newNodeItems.length) State.nodesDS.add(newNodeItems);
  if (newEdgeItems.length) State.edgesDS.add(newEdgeItems);

  // Refresh visual properties (sizes, border) on existing nodes —
  // their weights may have changed after the merge.
  const existingUpdates = State.graphNodes
    .filter(n => !n._isNew && dsNodeIds.has(n.id))
    .map(n => {
      const v = nodeVisual(n);
      return {
        id:          n.id,
        size:        v.size,
        color:       v.color,
        borderWidth: v.borderWidth,
        shadow:      v.shadow,
        mass:        v.mass,
        title:       v.title
      };
    });
  if (existingUpdates.length) State.nodesDS.update(existingUpdates);

  // C: seed positions for Euler layout
  placeExpandedNodes(savedPositions);

  fadeInNewNodes();
  // Long settle so the Euler clusters have time to fully separate
  nudgePhysics(PHYSICS_FREEZE_MS + 1500);
}

// ════════════════════════════════════════════════════════════════════════════
// C: EULER-STYLE LAYOUT — expanded nodes spread, shared neighbours converge
//
// Strategy:
//  1. Place the N expanded nodes uniformly on a circle of radius R.
//     R is large so they start well separated.
//  2. Each non-expanded node is pre-positioned at the weighted centroid of
//     the expanded nodes it is connected to.
//     → Nodes connected only to A start near A's position.
//     → Nodes connected to both A and B start in the middle.
//  3. forceAtlas2Based + high "mass" on expanded nodes does the rest:
//     - high mass = harder to move → poles stay where we put them
//     - spring forces pull shared collaborators to the midpoint
//     - avoidOverlap prevents stacking
//
// This reliably produces the "Venn without circles" shape without explicit
// circle drawing.
// ════════════════════════════════════════════════════════════════════════════

function placeExpandedNodes(savedPositions) {
  if (!State.network) return;

  const expanded = [...State.expandedNodes];
  const N = expanded.length;

  if (N === 0) return;

  const W = els.network.offsetWidth || 1200;
  const H = els.network.offsetHeight || 800;

  // расстояние между выбранными артистами
  const poleRadius = Math.min(W, H) * 0.45;

  const polePositions = {};

  // --------------------------------------------------
  // 1. Расставляем выбранных артистов далеко друг от друга
  // --------------------------------------------------

  expanded.forEach((nodeId, i) => {
    const angle = (2 * Math.PI * i) / N - Math.PI / 2;

    const x = Math.cos(angle) * poleRadius;
    const y = Math.sin(angle) * poleRadius;

    polePositions[nodeId] = { x, y };

    State.network.moveNode(nodeId, x, y);

    State.nodesDS.update({
      id: nodeId,
      fixed: {
        x: true,
        y: true
      },
      mass: 50
    });
  });

  const expandedSet = new Set(expanded);

  // --------------------------------------------------
  // 2. Для каждого узла выясняем,
  //    с какими expanded артистами он связан
  // --------------------------------------------------

  const memberships = new Map();

  State.graphNodes.forEach(node => {
    if (expandedSet.has(node.id)) return;

    const poles = new Set();

    for (const edge of State.graphEdges) {
      if (edge.from === node.id && expandedSet.has(edge.to))
        poles.add(edge.to);

      if (edge.to === node.id && expandedSet.has(edge.from))
        poles.add(edge.from);
    }

    memberships.set(node.id, [...poles]);
  });

  // --------------------------------------------------
  // 3. Уникальные коллабы раскладываем
  //    кольцом вокруг своего артиста
  // --------------------------------------------------

  expanded.forEach(poleId => {
    const owned = [];

    memberships.forEach((poles, nodeId) => {
      if (poles.length === 1 && poles[0] === poleId)
        owned.push(nodeId);
    });

    const center = polePositions[poleId];

    const localRadius = 180;

    owned.forEach((nodeId, idx) => {
      if (savedPositions[nodeId]) return;

      const a = (2 * Math.PI * idx) / Math.max(owned.length, 1);

      const x =
        center.x +
        Math.cos(a) * localRadius;

      const y =
        center.y +
        Math.sin(a) * localRadius;

      State.network.moveNode(nodeId, x, y);
    });
  });

  // --------------------------------------------------
  // 4. Общие коллабы ставим между артистами
  // --------------------------------------------------

  memberships.forEach((poles, nodeId) => {
    if (savedPositions[nodeId]) return;

    if (poles.length < 2) return;

    let x = 0;
    let y = 0;

    poles.forEach(pid => {
      x += polePositions[pid].x;
      y += polePositions[pid].y;
    });

    x /= poles.length;
    y /= poles.length;

    const jitter = 60;

    State.network.moveNode(
      nodeId,
      x + (Math.random() - 0.5) * jitter,
      y + (Math.random() - 0.5) * jitter
    );
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Fade-in animation for new nodes
// ────────────────────────────────────────────────────────────────────────────

function fadeInNewNodes() {
  const newIds = State.graphNodes.filter(n => n._isNew).map(n => n.id);
  if (!newIds.length) return;
  let start = null;
  const duration = 420;
  function step(ts) {
    if (!start) start = ts;
    const t = Math.min((ts - start) / duration, 1);
    if (State.nodesDS) State.nodesDS.update(newIds.map(id => ({ id, opacity: t })));
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ════════════════════════════════════════════════════════════════════════════
// NETWORK EVENTS
// ════════════════════════════════════════════════════════════════════════════

function attachNetworkEvents(nameById) {
  const net = State.network;

  net.on("click", function(params) {
    const ctrlKey = params.event && (params.event.ctrlKey || params.event.metaKey);

    // Edge click → sidebar
    if (params.edges?.length > 0 && !params.nodes?.length) {
      showEdgeSidebar(params.edges[0], nameById);
      return;
    }

    if (!params.nodes?.length) { clearFocus(); return; }

    const nodeId = params.nodes[0];
    if (ctrlKey) { openGeniusPage(nodeId); return; }

    // Single / double click disambiguation
    if (State._clickTimer && State._lastClickNode === nodeId) {
      clearTimeout(State._clickTimer);
      State._clickTimer    = null;
      State._lastClickNode = null;
      const gn = State.graphNodes.find(n => n.id === nodeId);
      if (gn) {
        showToast(`Expanding ${gn.name}…`, 1800, true);
        searchArtist(gn.name, true, true);
      }
    } else {
      clearTimeout(State._clickTimer);
      State._lastClickNode = nodeId;
      State._clickTimer = setTimeout(() => {
        State._clickTimer    = null;
        State._lastClickNode = null;
        setFocus(nodeId);
        showArtistSidebar(nodeId);
      }, 260);
    }
  });

  net.on("doubleClick", function(params) {
    clearTimeout(State._clickTimer);
    State._clickTimer    = null;
    State._lastClickNode = null;
    if (!params.nodes?.length) return;
    const gn = State.graphNodes.find(n => n.id === params.nodes[0]);
    if (gn) {
      showToast(`Expanding ${gn.name}…`, 1800, true);
      searchArtist(gn.name, true, true);
    }
  });

  net.on("hoverNode", function(params) {
    els.network.style.cursor = "pointer";
    if (!State.focusedNodeId) highlightNeighborhood(params.node);
  });
  net.on("hoverEdge", function(params) {
    els.network.style.cursor = "pointer";
    if (!State.focusedNodeId) highlightEdgePair(params.edge);
  });
  net.on("blurNode",  function() {
    els.network.style.cursor = "default";
    if (!State.focusedNodeId) restoreDefaultColors();
  });
  net.on("blurEdge",  function() {
    els.network.style.cursor = "default";
    if (!State.focusedNodeId) restoreDefaultColors();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SIDEBAR
// ════════════════════════════════════════════════════════════════════════════

function showArtistSidebar(nodeId) {
  const node = State.graphNodes.find(n => n.id === nodeId);
  if (!node) return;

  els.pathPanel.classList.remove("show");
  State.selectedEdgeId = null;

  els.sidebarAvatar.src = node.imageUrl || placeholderFor(node.name, node.isSeed);
  els.sidebarAvatar.alt = node.name;
  els.sidebarName.textContent = node.name;

  const collab = node._totalCollabs || node.totalWeight || 0;
  const expanded = State.expandedNodes.has(node.id) ? " · expanded ✓" : "";
  els.sidebarMeta.textContent = `${collab} collab${collab === 1 ? "" : "s"}${expanded}`;

  const tracks = node._topTracks || [];
  if (tracks.length) {
    els.sidebarTracks.innerHTML = tracks.map(t => {
      const roles = t.roles || [];
      const mainR = roles[0] ? roles[0].toLowerCase().replace(/[^a-z0-9]/g, "") : "primary";
      const icon  = ROLE_ICON[mainR] || "";
      return `<div class="sidebar-track">
        <span class="sidebar-track-name">${escapeHtml(t.song || "Untitled")}</span>
        <span class="sidebar-track-role role-chip--${mainR}">${icon} ${escapeHtml(roles[0] || "primary")}</span>
      </div>`;
    }).join("");
  } else {
    els.sidebarTracks.innerHTML = `<div style="color:var(--mist);font-size:12px;">No track data.</div>`;
  }

  const roles = [...(node._rolesSet || [])];
  els.sidebarRoles.innerHTML = roles.length
    ? roles.map(r => {
        const slug = r.replace(/[^a-z0-9]/g, "");
        const icon = ROLE_ICON[slug] || "";
        return `<span class="sidebar-role-chip role-chip--${slug}">${icon} ${escapeHtml(r)}</span>`;
      }).join("")
    : `<span style="color:var(--mist);font-size:11px;">—</span>`;

  els.sidebarGenius.style.display = "";
  els.sidebarGenius.onclick = () => openGeniusPage(nodeId);
  els.artistSidebar.classList.add("show");
}

function showEdgeSidebar(edgeId, nameById) {
  const edge = State.graphEdges.find(e => e.id === edgeId);
  if (!edge) return;

  const fromName = nameById[edge.from] || State.graphNodes.find(n => n.id === edge.from)?.name || "?";
  const toName   = nameById[edge.to]   || State.graphNodes.find(n => n.id === edge.to)?.name   || "?";
  const role     = edge.dominantRole || "primary";
  const icon     = ROLE_ICON[role] || "";

  els.pathPanel.classList.remove("show");
  els.sidebarAvatar.src = placeholderFor(`${fromName[0]}${toName[0]}`, false);
  els.sidebarAvatar.alt = "";
  els.sidebarName.textContent = `${fromName} × ${toName}`;
  els.sidebarMeta.textContent =
    `${edge.weight} shared track${edge.weight === 1 ? "" : "s"} · ${icon} ${role}`;

  const collabs = edge.collaborations || [];
  if (collabs.length) {
    els.sidebarTracks.innerHTML = collabs.map(c => {
      const roles = c.roles || [];
      const chips = roles.map(r => {
        const sl = r.toLowerCase().replace(/[^a-z0-9]/g, "");
        return `<span class="sidebar-track-role role-chip--${sl}">${ROLE_ICON[sl] || ""} ${escapeHtml(r)}</span>`;
      }).join(" ");
      return `<div class="sidebar-track">
        <span class="sidebar-track-name">${escapeHtml(c.song || "Untitled")}</span>
        <span style="display:flex;gap:3px;flex-wrap:wrap">${chips}</span>
      </div>`;
    }).join("");
  } else {
    els.sidebarTracks.innerHTML = `<div style="color:var(--mist);font-size:12px;">No track data.</div>`;
  }

  els.sidebarRoles.innerHTML = "";
  els.sidebarGenius.style.display = "none";
  els.artistSidebar.classList.add("show");
  highlightEdgePair(edgeId);
}

function hideArtistSidebar() {
  els.artistSidebar.classList.remove("show");
  State.selectedEdgeId = null;
}

// ════════════════════════════════════════════════════════════════════════════
// FOCUS & HIGHLIGHT
// ════════════════════════════════════════════════════════════════════════════

function setFocus(nodeId) {
  State.focusedNodeId = nodeId;
  highlightNeighborhood(nodeId);
}

function clearFocus() {
  State.focusedNodeId = null;
  hideArtistSidebar();
  restoreDefaultColors();
}

function highlightNeighborhood(nodeId) {
  if (!State.nodesDS || !State.edgesDS) return;
  const connNodes = new Set(State.network.getConnectedNodes(nodeId));
  const connEdges = new Set(State.network.getConnectedEdges(nodeId));

  const nU = [], eU = [];
  State.nodesDS.forEach(nd => {
    const t = nd.id === nodeId || connNodes.has(nd.id);
    nU.push({ id: nd.id,
      color:   { border: t ? (nd._accent || COLOR.pulse) : "rgba(40,48,68,0.08)", background: t ? COLOR.panel : "rgba(20,26,40,0.08)" },
      opacity: t ? 1 : 0.08 });
  });
  State.edgesDS.forEach(ed => {
    const t = connEdges.has(ed.id);
    eU.push({ id: ed.id,
      color: { color: t ? (ed._color || COLOR.pulse) : "rgba(40,48,68,0.02)", opacity: t ? 0.95 : 0.02 } });
  });
  State.nodesDS.update(nU);
  State.edgesDS.update(eU);
}

function highlightEdgePair(edgeId) {
  if (!State.edgesDS || !State.network) return;
  const pairSet = new Set(State.network.getConnectedNodes(edgeId));

  const nU = [], eU = [];
  State.nodesDS.forEach(nd => {
    nU.push({ id: nd.id, opacity: pairSet.has(nd.id) ? 1 : 0.10 });
  });
  State.edgesDS.forEach(ed => {
    eU.push({ id: ed.id,
      color: {
        color:   ed.id === edgeId ? (ed._color || COLOR.pulse) : "rgba(40,48,68,0.02)",
        opacity: ed.id === edgeId ? 1 : 0.02
      }
    });
  });
  State.nodesDS.update(nU);
  State.edgesDS.update(eU);
}

function restoreDefaultColors() {
  if (!State.nodesDS || !State.edgesDS) return;
  const nU = [], eU = [];
  State.nodesDS.forEach(nd => {
    nU.push({ id: nd.id,
      color:   { border: nd._dimBorder || "rgba(40,48,68,0.25)", background: COLOR.panel },
      opacity: 1 });
  });
  State.graphEdges.forEach(e => {
    const rs = roleStyle(e.dominantRole);
    eU.push({ id: e.id, color: { color: rs.color, opacity: 0.45 } });
  });
  State.nodesDS.update(nU);
  State.edgesDS.update(eU);
}

// ════════════════════════════════════════════════════════════════════════════
// GENIUS PAGE
// ════════════════════════════════════════════════════════════════════════════

function openGeniusPage(nodeId) {
  const node = State.graphNodes.find(n => n.id === nodeId);
  if (!node) return;
  const url = node.geniusUrl ||
    `https://genius.com/artists/${encodeURIComponent(node.name.replace(/\s+/g, "-").toLowerCase())}`;
  window.open(url, "_blank", "noopener");
}

// ════════════════════════════════════════════════════════════════════════════
// ROLE FILTER TOGGLES
// ════════════════════════════════════════════════════════════════════════════

function setupFilterToggles() {
  function makeToggle(role, btn) {
    btn.addEventListener("click", () => {
      if (State.activeFilters.has(role)) {
        if (State.activeFilters.size <= 1) {
          showToast("At least one role filter must be active.", 2200);
          return;
        }
        State.activeFilters.delete(role);
        btn.classList.remove("active");
      } else {
        State.activeFilters.add(role);
        btn.classList.add("active");
      }
      updateStatusFilters();
      updateShareableUrl(els.dockInput.value);
      const artist = (els.dockInput.value || "").trim();
      if (artist) searchArtist(artist, false, true);
    });
    btn.classList.add("active");
  }
  if (els.filterFeatured) makeToggle("featured", els.filterFeatured);
  if (els.filterProducer) makeToggle("producer", els.filterProducer);
  if (els.filterWriter)   makeToggle("writer",   els.filterWriter);
}

function updateStatusFilters() {
  if (!els.statusFilters) return;
  const chips = [];
  if (State.activeFilters.has("featured")) chips.push(`<span class="status-chip status-chip--featured">🎤 feat.</span>`);
  if (State.activeFilters.has("producer")) chips.push(`<span class="status-chip status-chip--producer">🎛 prod.</span>`);
  if (State.activeFilters.has("writer"))   chips.push(`<span class="status-chip status-chip--writer">✍️ writer</span>`);
  els.statusFilters.innerHTML = chips.join("");
}

// ════════════════════════════════════════════════════════════════════════════
// BFS PATHFINDING
// ════════════════════════════════════════════════════════════════════════════

function getBfsAdj() {
  const h = graphHash();
  if (State._bfsAdj && h === State._bfsGraphHash) return State._bfsAdj;
  const adj = new Map();
  State.graphEdges.forEach(e => {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to))   adj.set(e.to,   []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  });
  State._bfsAdj       = adj;
  State._bfsGraphHash = h;
  return adj;
}

function bfsPath(fromId, toId) {
  const adj = getBfsAdj();
  if (!adj.has(fromId) || !adj.has(toId)) return null;
  const visited = new Set([fromId]);
  const queue   = [[fromId, [fromId]]];
  while (queue.length) {
    const [curr, path] = queue.shift();
    if (curr === toId) return path;
    for (const nb of (adj.get(curr) || [])) {
      if (!visited.has(nb)) { visited.add(nb); queue.push([nb, [...path, nb]]); }
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
  const nU = [], eU = [];
  State.nodesDS.forEach(nd => {
    nU.push({ id: nd.id,
      color:   { border: pathSet.has(nd.id) ? COLOR.neon : "rgba(40,48,68,0.08)", background: COLOR.panel },
      opacity: pathSet.has(nd.id) ? 1 : 0.12 });
  });
  State.edgesDS.forEach(ed => {
    const inP = pathEdges.has(ed.id);
    eU.push({ id: ed.id,
      color: { color: inP ? COLOR.neon : "rgba(40,48,68,0.02)", opacity: inP ? 1 : 0.02 },
      width: inP ? 5 : undefined });
  });
  State.nodesDS.update(nU);
  State.edgesDS.update(eU);
}

function clearPathHighlight() {
  State.pathHighlight = null;
  restoreDefaultColors();
  if (els.pathResult) els.pathResult.textContent = "";
}

// ════════════════════════════════════════════════════════════════════════════
// AUTOCOMPLETE  — Genius /search suggestions for hero + dock search inputs
//                 and smart node-graph suggestions for path-finder inputs
// ════════════════════════════════════════════════════════════════════════════

// Shared debounce for Genius search suggestions (300 ms)
const _acGenius = debounce(async (query, dropdownEl, onSelect) => {
  if (!query || query.length < 2) { dropdownEl.classList.remove("open"); return; }
  dropdownEl.innerHTML = `<div class="ac-spinner">Searching…</div>`;
  dropdownEl.classList.add("open");
  try {
    // Hit the Genius search endpoint via the backend proxy.
    // The backend already handles auth; we piggyback on /api/v1/graph with
    // an intentionally-low threshold so we always get candidates back.
    const res  = await fetch(`/api/v1/graph?artist=${encodeURIComponent(query)}&role_filter=featured,producer,writer,primary&__ac=1`);
    const data = res.ok ? await res.json() : null;
    const candidates = data?.ambiguous ? (data.candidates || []) : [];

    // If the backend returned a direct hit (not ambiguous), synthesise a
    // single candidate card so the dropdown still has something useful.
    if (!data?.ambiguous && data?.seed) {
      candidates.unshift({ name: data.seed, image: data.nodes?.[0]?.image || "", score: 1 });
    }

    if (!candidates.length) { dropdownEl.classList.remove("open"); return; }

    dropdownEl.innerHTML = candidates.slice(0, 6).map(c => `
      <div class="ac-item" data-name="${escapeHtml(c.name)}" role="option">
        <img class="ac-avatar" src="${escapeHtml(c.image || placeholderFor(c.name, false))}"
            onerror="this.src='${placeholderFor(c.name, false)}'" alt="" />
        <div class="ac-info">
          <span class="ac-name">${escapeHtml(c.name)}</span>
          ${c.score != null && c.score < 1
            ? `<span class="ac-hint">${Math.round(c.score * 100)}%</span>`
            : ''}
        </div>
      </div>
    `).join('');

    dropdownEl.querySelectorAll(".ac-item").forEach(item => {
      item.addEventListener("mousedown", e => {
        e.preventDefault(); // prevent blur before click fires
        const name = item.getAttribute("data-name");
        dropdownEl.classList.remove("open");
        onSelect(name);
      });
    });
  } catch { dropdownEl.classList.remove("open"); }
}, 300);

// Wire autocomplete to a (input, dropdown, onSelect) triple.
function attachGeniusAutocomplete(inputEl, dropdownEl, onSelect) {
  // Показывает историю поиска в выпадающем списке
  function showHistoryDropdown() {
    const items = State.history.slice(0, 5);
    if (!items.length) {
      dropdownEl.innerHTML = `<div class="ac-spinner">No recent searches</div>`;
      dropdownEl.classList.add("open");
      return;
    }
    dropdownEl.innerHTML = items.map(name => `
      <div class="ac-item ac-history" data-name="${escapeHtml(name)}">
        <div class="ac-info">
          <span class="ac-name">${escapeHtml(name)}</span>
        </div>
      </div>
    `).join('');
    dropdownEl.classList.add("open");

    // Обработчики для элементов истории
    dropdownEl.querySelectorAll(".ac-history").forEach(item => {
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        const name = item.getAttribute("data-name");
        dropdownEl.classList.remove("open");
        inputEl.value = name;
        onSelect(name);
      });
    });
  }

  // При фокусе и пустом поле показываем историю
  inputEl.addEventListener("focus", () => {
    if (!inputEl.value.trim()) {
      showHistoryDropdown();
    }
  });

  // При вводе текста — подсказки Genius, при пустом — история
  inputEl.addEventListener("input", () => {
    const val = inputEl.value.trim();
    if (val) {
      _acGenius(val, dropdownEl, onSelect);
    } else {
      showHistoryDropdown();
    }
  });

  // Закрываем при потере фокуса (с задержкой, чтобы успел сработать клик)
  inputEl.addEventListener("blur", () => {
    setTimeout(() => dropdownEl.classList.remove("open"), 150);
  });

  // Навигация клавишами и Escape — оставляем без изменений
  inputEl.addEventListener("keydown", e => {
    if (e.key === "Escape") dropdownEl.classList.remove("open");
    if (e.key === "ArrowDown") {
      const first = dropdownEl.querySelector(".ac-item");
      if (first) { first.classList.add("ac-active"); first.focus(); }
    }
  });

  dropdownEl.addEventListener("keydown", e => {
    const items = [...dropdownEl.querySelectorAll(".ac-item")];
    const idx   = items.findIndex(i => i === document.activeElement);
    if (e.key === "ArrowDown" && idx < items.length - 1) items[idx + 1].focus();
    if (e.key === "ArrowUp"   && idx > 0)                items[idx - 1].focus();
    if (e.key === "ArrowUp"   && idx === 0)              inputEl.focus();
    if (e.key === "Enter" && idx >= 0) items[idx].dispatchEvent(new MouseEvent("mousedown"));
    if (e.key === "Escape") { dropdownEl.classList.remove("open"); inputEl.focus(); }
  });
}

// Path-panel: suggest from already-loaded graph nodes (no network call needed)
function attachNodeAutocomplete(inputEl, dropdownEl, onSelect) {
  const _show = debounce(() => {
    const q = inputEl.value.trim().toLowerCase();
    if (!q) { dropdownEl.classList.remove("open"); return; }
    const matches = State.graphNodes
      .filter(n => n.name.toLowerCase().includes(q))
      .slice(0, 8);
    if (!matches.length) { dropdownEl.classList.remove("open"); return; }
    dropdownEl.innerHTML = matches.map(n => {
      const img = n.imageUrl || placeholderFor(n.name, n.isSeed);
      return `<div class="ac-item" data-name="${escapeHtml(n.name)}" role="option">
        <img class="ac-avatar" src="${escapeHtml(img)}"
             onerror="this.src='${placeholderFor(n.name, false)}'" alt="" />
        <div class="ac-info"><div class="ac-name">${escapeHtml(n.name)}</div></div>
      </div>`;
    }).join("");
    dropdownEl.querySelectorAll(".ac-item").forEach(item => {
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        const name = item.getAttribute("data-name");
        inputEl.value = name;
        dropdownEl.classList.remove("open");
        onSelect(name);
      });
    });
    dropdownEl.classList.add("open");
  }, 80);

  inputEl.addEventListener("input", _show);
  inputEl.addEventListener("focus", _show);
  inputEl.addEventListener("blur",  () => { setTimeout(() => dropdownEl.classList.remove("open"), 150); });
  inputEl.addEventListener("keydown", e => {
    if (e.key === "Escape") dropdownEl.classList.remove("open");
  });
}

function setupPathPanel() {
  els.btnFindPath?.addEventListener("click", () => {
    hideArtistSidebar();
    els.pathPanel.classList.toggle("show");
  });

  // Wire smart node-autocomplete to path inputs
  const pathFromAc = $("path-from-ac");
  const pathToAc   = $("path-to-ac");
  if (pathFromAc) attachNodeAutocomplete(els.pathFromInput, pathFromAc, () => {});
  if (pathToAc)   attachNodeAutocomplete(els.pathToInput,   pathToAc,   () => {});

  els.btnRunPath?.addEventListener("click", () => {
    const fromName = (els.pathFromInput.value || "").trim();
    const toName   = (els.pathToInput.value   || "").trim();
    if (!fromName || !toName) { showToast("Enter both artist names."); return; }
    const fromNode = State.graphNodes.find(n => n.name.toLowerCase() === fromName.toLowerCase());
    const toNode   = State.graphNodes.find(n => n.name.toLowerCase() === toName.toLowerCase());
    if (!fromNode) { showToast(`"${fromName}" not in current graph.`); return; }
    if (!toNode)   { showToast(`"${toName}" not in current graph.`);   return; }
    const path = bfsPath(fromNode.id, toNode.id);
    if (!path) {
      els.pathResult.textContent = "No path found — artists may not be connected.";
      restoreDefaultColors(); return;
    }
    State.pathHighlight = path;
    highlightPath(path);
    const names = path.map(id => State.graphNodes.find(x => x.id === id)?.name || id);
    const hops  = path.length - 1;
    els.pathResult.textContent = `${hops} hop${hops === 1 ? "" : "s"}: ${names.join(" → ")}`;
  });
  els.btnClearPath?.addEventListener("click", clearPathHighlight);
}

// ════════════════════════════════════════════════════════════════════════════
// NODE SEARCH (Cmd+K)
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
    `<span class="ns-name">${escapeHtml(n.name)}` +
    (State.expandedNodes.has(n.id) ? ` <span style="color:var(--signal);font-size:9px">✓</span>` : "") +
    `</span>` +
    `<span class="ns-weight">${n.totalWeight || 0} collab${n.totalWeight === 1 ? "" : "s"}</span>` +
    `</div>`
  ).join("") || `<div class="ns-empty">No nodes match</div>`;

  els.nodeSearchResults.querySelectorAll(".ns-item").forEach(item => {
    item.addEventListener("click", () => {
      const id = Number(item.getAttribute("data-id"));
      closeNodeSearch();
      if (!State.network) return;
      State.network.focus(id, { scale: 1.5, animation: { duration: 600, easingFunction: "easeInOutQuad" } });
      setFocus(id);
      showArtistSidebar(id);
    });
  });
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
// SEARCH HISTORY
// ════════════════════════════════════════════════════════════════════════════

function loadHistory() {
  try {
    const raw = localStorage.getItem("feat-atlas-history");
    State.history = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(State.history)) State.history = [];
  } catch { State.history = []; }
}

function saveHistory() {
  try { localStorage.setItem("feat-atlas-history", JSON.stringify(State.history)); } catch {}
}

function pushHistory(name) {
  State.history = [name, ...State.history.filter(h => h !== name)].slice(0, MAX_HISTORY);
  saveHistory();
}

function clearHistory() {
  State.history = []; saveHistory();
}

// ════════════════════════════════════════════════════════════════════════════
// SHAREABLE URL
// ════════════════════════════════════════════════════════════════════════════

function updateShareableUrl(artistName) {
  if (!artistName) return;
  const url = new URL(window.location.href);
  url.searchParams.set("artist", artistName);
  url.searchParams.set("roles", [...State.activeFilters].sort().join(","));
  history.replaceState(null, "", url.toString());
}

function loadArtistFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const artist = params.get("artist");
  const roles  = params.get("roles");
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
    searchArtist(artist, false, true);
  }
}

function copyShareableLink() {
  const url = window.location.href;
  navigator.clipboard.writeText(url)
    .then(() => showToast("🔗 Link copied!", 2000, true))
    .catch(() => showToast(`Copy: ${url}`, 5000));
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════════════════════

function exportPng() {
  // FIX-PNG: vis-network exposes the real drawing canvas via
  // network.canvas.frame.canvas — this is guaranteed to be the composited
  // graph canvas, not the transparent interaction overlay that
  // querySelector("canvas") sometimes returns first.
  if (!State.network) { showToast("No graph to export yet."); return; }
  try {
    // Primary: use the vis API canvas reference
    const canvas = State.network.canvas?.frame?.canvas
                || els.network.querySelector("canvas");
    if (!canvas) { showToast("Canvas not found."); return; }

    // We need to trigger a full redraw so the canvas isn't blank
    // (vis clears it between frames when physics is frozen).
    State.network.redraw();

    // Give the redraw one animation frame to complete before capturing.
    requestAnimationFrame(() => {
      try {
        const out = document.createElement("canvas");
        out.width  = canvas.width;
        out.height = canvas.height;
        const ctx = out.getContext("2d");
        // Fill background with the app's dark ink colour
        ctx.fillStyle = "#0B0E14";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(canvas, 0, 0);
        const link = document.createElement("a");
        link.download = "feature-atlas.png";
        link.href = out.toDataURL("image/png");
        link.click();
      } catch (e2) { showToast("Export failed: " + e2.message); }
    });
  } catch (e) { showToast("Export failed: " + e.message); }
}

function exportJson() {
  if (!State.graphNodes.length) { showToast("No graph to export yet."); return; }
  const data = {
    exported:   new Date().toISOString(),
    seedArtist: els.dockInput.value,
    nodes: State.graphNodes.map(n => ({ id: n.id, name: n.name, imageUrl: n.imageUrl, expanded: State.expandedNodes.has(n.id) })),
    edges: State.graphEdges.map(e => ({ from: e.from, to: e.to, weight: e.weight, dominantRole: e.dominantRole, collaborations: e.collaborations }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = "feature-atlas.json";
  link.href = url; link.click();
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
// KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════════════════════════════

function setupKeyboard() {
  document.addEventListener("keydown", e => {
    const tag     = document.activeElement?.tagName;
    const inInput = tag === "INPUT" || tag === "TEXTAREA";

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      els.nodeSearchOverlay.classList.contains("show") ? closeNodeSearch() : openNodeSearch();
      return;
    }

    if (e.key === "Escape") {
      if (els.candidateOverlay?.classList.contains("show")) { hideCandidatePicker(); return; }
      if (els.nodeSearchOverlay.classList.contains("show")) { closeNodeSearch();      return; }
      if (State.pathHighlight)                              { clearPathHighlight();   return; }
      focusSeed(); return;
    }

    if (inInput) return;

    switch (e.key) {
      case "f": case "F": fitView(); break;
      case "+": case "=": zoomIn();  break;
      case "-": case "_": zoomOut(); break;
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
  State.pathHighlight = null;
  State.hasRendered   = false;
  State._bfsAdj       = null;
  State._bfsGraphHash = "";
  State.expandedNodes.clear();
  hideArtistSidebar();
}

function resetToHero() {
  els.graphView.classList.remove("is-visible");
  setTimeout(() => { els.graphView.hidden = true; els.status.hidden = true; }, 420);
  els.hero.classList.remove("is-hidden");
  els.heroInput.value = "";
  els.heroInput.focus();
  hideToast();
  hideArtistSidebar();
  hideCandidatePicker();
  els.pathPanel.classList.remove("show");
  destroyNetwork();
  history.replaceState(null, "", window.location.pathname);
}

function updateStatus(graph) {
  const total = State.graphNodes.length;
  const links = State.graphEdges.length;
  const focus = graph.seed || els.dockInput.value || "—";
  const exp   = State.expandedNodes.size > 1 ? ` · ${State.expandedNodes.size} poles` : "";
  els.statusSeed.textContent =
    `${focus} · ${total} artist${total === 1 ? "" : "s"} · ${links} link${links === 1 ? "" : "s"}${exp}`;
}

function showLoading(on) { els.loading.classList.toggle("show", !!on); }

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
  setupFilterToggles();
  setupKeyboard();
  setupNodeSearch();
  setupPathPanel();
  updateStatusFilters();

  // FIX-AC: Genius autocomplete for hero and dock search boxes
  const heroAc = $("hero-ac");
  const dockAc = $("dock-ac");
  if (heroAc) {
    attachGeniusAutocomplete(els.heroInput, heroAc, name => {
      els.heroInput.value = name;
      searchArtist(name, false, true);
    });
  }
  if (dockAc) {
    attachGeniusAutocomplete(els.dockInput, dockAc, name => {
      els.dockInput.value = name;
      searchArtist(name, false, true);
    });
  }

  els.heroForm.addEventListener("submit", e => {
    e.preventDefault();
    heroAc?.classList.remove("open");
    searchArtist(els.heroInput.value, false, true);
  });

  els.dockForm.addEventListener("submit", e => {
    e.preventDefault();
    dockAc?.classList.remove("open");
    searchArtist(els.dockInput.value, false, true);
    els.dockInput.blur();
  });

  els.chips.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const name = chip.getAttribute("data-artist");
    els.heroInput.value = name;
    searchArtist(name, false, true);
  });

  els.brand.addEventListener("click", resetToHero);

  els.sidebarClose.addEventListener("click", () => { hideArtistSidebar(); clearFocus(); });

  els.candidateClose?.addEventListener("click", hideCandidatePicker);
  els.candidateOverlay?.addEventListener("click", e => {
    if (e.target === els.candidateOverlay) hideCandidatePicker();
  });

  els.btnExportPng  ?.addEventListener("click", exportPng);
  els.btnExportJson ?.addEventListener("click", exportJson);
  els.btnClearGraph ?.addEventListener("click", resetToHero);
  els.btnCopyLink   ?.addEventListener("click", copyShareableLink);
  els.btnFitView    ?.addEventListener("click", fitView);

  $("btn-node-search")?.addEventListener("click", openNodeSearch);

  loadArtistFromUrl();
  els.heroInput.focus();
}

window.addEventListener("DOMContentLoaded", init);
