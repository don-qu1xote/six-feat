"use strict";

// ════════════════════════════════════════════════════════════════════════════
// FEATURE ATLAS — script.js  (iteration 5)
//
// Changes from iteration 4:
//  1. SERVER PATH ENDPOINT — /api/v1/graph/path is now called; client-side
//     BFS is kept as fallback for nodes already in the canvas.
//  2. NODE LABELS — Space Mono 10px below nodes; toggle button in dock;
//     auto-hidden when graph has >60 nodes.
//  3. BETWEENNESS CENTRALITY GLOW — shadow size/opacity lerped from
//     betweenness_normalised; replaces old binary expanded-glow logic.
//     Expanded-node thick border kept as separate cue.
//  4. PATH PANEL — moved to left side (CSS), close button, Clear path,
//     hop chain with avatar+name+songs, both node-AC and Genius-AC fallback.
//  5. DEDUPLICATED AC DEBOUNCE — createGeniusAc() factory; each call site
//     gets its own independent debounce timer.
//  6. MINOR FIXES — dead historyList ref removed; exportPng SecurityError
//     handling; _dimBorder stored on graphNode state.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const COLOR = {
  paper:  "#EDEFF4",
  line:   "#283044",
  panel:  "#141A28",
  signal: "#5EE6C5",
  pulse:  "#B98AFF",
  amber:  "#FFD27A",
  warn:   "#FF8FA3",
  neon:   "#FF2D78",
  ink:    "#0B0E14"
};

// Все линии сплошные — dashes при большом числе рёбер нечитаемы
// и значительно замедляют рендер (canvas fillRect на каждый сегмент).
// Роли различаются только цветом.
const ROLE_STYLE = {
  featured: { color: COLOR.signal, dash: false },
  producer: { color: COLOR.pulse,  dash: false },
  writer:   { color: COLOR.amber,  dash: false },
  primary:  { color: "#5A6480",    dash: false }
};

const ROLE_ICON = {
  featured: "🎤",
  producer: "🎛",
  writer:   "✍️",
  primary:  ""
};

const ROLE_PRIORITY = ["featured", "producer", "writer", "primary"];

const MAX_HISTORY     = 5;
const SEARCH_DEBOUNCE = 300;


// Physics timing constants
// SETTLE: время работы физики при первом открытии (stabilization уже отработал,
// это запасной таймер).
// EXPAND: время физики при expand — ноды уже расставлены, нужно чуть-чуть.
const PHYSICS_SETTLE_MS      = 1500;
const PHYSICS_EXPAND_MS      = 800;
const STABILIZE_ITERATIONS   = 200;

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
  pendingExpand: null,

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

  expandedNodes: new Set(),
  lastExpandedId: null,
  _clickedNodeId: null,

  // RAF handle for the expand fly-in animation (rule 3); cancellable.
  _expandAnimId: null,

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

  btnClearGraph: $("btn-clear-graph"),
  btnCopyLink:   $("btn-copy-link"),
  btnFindPath:   $("btn-find-path"),
  btnFitView:    $("btn-fit-view"),

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

  pathPanel:      $("path-panel"),
  pathPanelClose: $("path-panel-close"),
  pathFromInput:  $("path-from-input"),
  pathToInput:    $("path-to-input"),
  btnRunPath:     $("btn-run-path"),
  btnClearPath:   $("btn-clear-path"),
  pathResult:     $("path-result"),
  hopChain:       $("hop-chain"),

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
// TASK 3: BETWEENNESS GLOW
// ════════════════════════════════════════════════════════════════════════════

function betweennessGlow(nodeData) {
  const bn = nodeData._betweennessNorm || 0;   // 0…1
  const isExpanded = State.expandedNodes.has(nodeData.id);

  if (nodeData.isSeed) {
    // Seed keeps its signature teal glow, boosted by betweenness
    const size = lerp(18, 32, bn);
    return { enabled: true, color: `rgba(94,230,197,${lerp(0.35, 0.60, bn).toFixed(2)})`, size, x: 0, y: 0 };
  }
  if (isExpanded) {
    // Expanded nodes: thick glow based on betweenness (minimum 8px)
    const accent = nodeData._accent || COLOR.pulse;
    const size   = Math.max(8, lerp(0, 28, bn));
    const alpha  = lerp(0.20, 0.55, bn).toFixed(2);
    return { enabled: true, color: `${accent}${Math.round(Number(alpha) * 255).toString(16).padStart(2,"0")}`, size, x: 0, y: 0 };
  }
  if (bn > 0.05) {
    const accent = nodeData._accent || COLOR.pulse;
    const size   = lerp(0, 28, bn);
    const alpha  = lerp(0.0, 0.55, bn).toFixed(2);
    return { enabled: true, color: `${accent}${Math.round(Number(alpha) * 255).toString(16).padStart(2,"0")}`, size, x: 0, y: 0 };
  }
  return { enabled: false };
}

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

  // Spread оператор на Map.values() медленный при 500+ записях — используем reduce.
  let maxW = 1;
  weightMap.forEach(v => { if (v > maxW) maxW = v; });
  const minR = 14, maxR = 48;

  for (const n of State.graphNodes) {
    const w = n._backendWeight || weightMap.get(n.id) || 1;
    n.totalWeight    = w;
    n.computedRadius = Math.round(lerp(minR, maxR * 0.78, Math.sqrt(w) / Math.sqrt(maxW)));
    if (n.isSeed) n.computedRadius = maxR;
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
  const bcPct = node._betweennessNorm != null
    ? `<div class="tt-meta">centrality ${Math.round((node._betweennessNorm || 0) * 100)}%</div>` : "";
  el.innerHTML =
    `<div class="tt-name">${escapeHtml(node.name)}${seedBadge}</div>` +
    (node.totalWeight ? `<div class="tt-meta">${node.totalWeight} collab${node.totalWeight === 1 ? "" : "s"}</div>` : "") +
    bcPct +
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
// LABEL HELPERS
// ════════════════════════════════════════════════════════════════════════════


function labelFont() {
  return { size: 0, color: "#00000000" };
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

  const isExpanded = State.expandedNodes.has(id);
  const borderCol  = isExpanded ? accent : dimBorder;

  // Seed: mass=1 т.к. он зафиксирован (fixed:true) и масса не влияет на физику.
  // Expanded: высокая масса — притягивают листья, но сами не улетают.
  // Leaf: масса 1 — свободно оседают вокруг expanded.
  const mass = isSeed ? 1 : (isExpanded ? 8 : 1);
  const shadow = betweennessGlow(nodeData);

  return {
    id,
    _accent:    accent,
    _dimBorder: dimBorder,
    label:  name,
    font:   labelFont(isSeed),
    shape:  "circularImage",
    image,
    brokenImage: placeholderFor(name, isSeed),
    size:   radius,
    borderWidth: isExpanded ? 4 : (isSeed ? 5 : 2),
    borderWidthSelected: isExpanded ? 6 : (isSeed ? 7 : 3),
    color: {
      border:     borderCol,
      background: COLOR.panel,
      highlight:  { border: COLOR.paper, background: COLOR.panel },
      hover:      { border: accent,      background: COLOR.panel }
    },
    title:  buildNodeTooltip({ ...nodeData, computedRadius: radius }),
    shadow,
    opacity: nodeData._isNew ? 0 : 1,
    // Новые expanded не фиксируем заранее — placeExpandedNodes вызовет moveNode
    // и только потом зафиксирует. Иначе vis.js ставит их в (0,0) до moveNode.
    fixed: (isSeed || (isExpanded && !nodeData._isNew)) ? { x: true, y: true } : false,
    mass,
    x: isSeed ? 0 : undefined,
    y: isSeed ? 0 : undefined,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// EDGE VISUAL
// ════════════════════════════════════════════════════════════════════════════

function edgeVisual(e, nameById) {
  const weight = Number(e.weight) > 0 ? Number(e.weight) : 1;
  const role = resolveEdgeDominantRole(e);
  const rs   = roleStyle(role);
  const dashes = false;  // всегда сплошные — dashes медленны и нечитаемы

  return {
    id:     e.id,
    from:   e.from,
    to:     e.to,
    width:  Math.min(1 + Math.sqrt(weight) * 1.8, 9),
    dashes,
    title:  buildEdgeTooltip(e, nameById),
    color: {
      color:     rs.color,
      // Opacity зависит от размера графа — при 200+ нодах линии тоньше/прозрачнее
      opacity:   0.40,
      inherit:   false,
      hover:     COLOR.paper,
      highlight: COLOR.paper
    },
    // smooth не указываем — берётся глобальный из networkOptions
    // (false при >EDGE_SMOOTH_THRESHOLD рёбрах, dynamic при меньшем).
    _role:  role,
    _color: rs.color
  };
}

function resolveEdgeDominantRole(e) {
  const roleSet = new Set();
  for (const c of (e.collaborations || []))
    for (const r of (c.roles || [])) roleSet.add(r.toLowerCase());
  if (e.dominant_role)   roleSet.add(e.dominant_role.toLowerCase());
  if (e.role_priority)   roleSet.add(e.role_priority.toLowerCase());
  if (e.dominantRole)    roleSet.add(e.dominantRole.toLowerCase());
  for (const r of ROLE_PRIORITY) {
    if (roleSet.has(r)) return r;
  }
  return "primary";
}

// ════════════════════════════════════════════════════════════════════════════
// NETWORK OPTIONS
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
      // Кривые рёбра. type:"continuous" считает изгиб напрямую из позиций
      // концов — БЕЗ виртуальных узлов (в отличие от "dynamic", который и давал
      // спирали-«улитки» около seed). С выключенной физикой это дёшево и
      // выглядит мягко.
      smooth: { enabled: true, type: "continuous", roundness: 0.45 }
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
      solver: "barnesHut",
      barnesHut: {
        // Начальная стабилизация (initNetwork): мягко разводим seed-граф.
        // При expand эти параметры переопределяются через setOptions.
        gravitationalConstant: -6000,
        centralGravity:        0.05,
        springLength:          180,
        springConstant:        0.04,
        damping:               0.88,
        avoidOverlap:          0.9
      },
      stabilization: {
        enabled:        true,
        iterations:     200,
        updateInterval: 50,
        fit:            false
      },
      timestep:         0.35,
      adaptiveTimestep: true,
      maxVelocity:      60,
      minVelocity:      0.8
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

// Порог числа рёбер для переключения в "fast render" режим.
const FAST_RENDER_EDGE_THRESHOLD = 150;

function updateEdgeRenderMode() {
  if (!State.network) return;
  // Кривые рёбра (continuous): без виртуальных узлов, без спиралей.
  State.network.setOptions({ edges: { smooth: { enabled: true, type: "continuous", roundness: 0.45 } } });
}

function nudgePhysics(ms, noFit) {
  if (!State.network) return;
  const settleMs = ms || PHYSICS_SETTLE_MS;
  updateEdgeRenderMode();
  State.network.setOptions({
    physics: { enabled: true, stabilization: { enabled: false } }
  });
  scheduleFreeze(settleMs);
}

// ════════════════════════════════════════════════════════════════════════════
// FETCH — concurrent request protection
// ════════════════════════════════════════════════════════════════════════════

const _searchDebounced = debounce((artist, isExpansion) => _doSearch(artist, isExpansion), SEARCH_DEBOUNCE);

function searchArtist(artist, isExpansion = false, forceImmediate = false) {
  artist = (artist || "").trim();
  if (!artist) return;
  if (State.inFlight) {
    if (isExpansion) State.pendingExpand = { name: artist };
    return;
  }
  if (forceImmediate) _doSearch(artist, isExpansion);
  else _searchDebounced(artist, isExpansion);
}

async function _doSearch(artist, isExpansion) {
  State.inFlight      = true;
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
// REPLACE GRAPH
// ════════════════════════════════════════════════════════════════════════════

function replaceGraph(graph) {
  const seedId = graph.seed_id ?? (graph.nodes[0]?.id);

  const savedPositions = State.network ? State.network.getPositions() : {};
  const nameById = {};
  graph.nodes.forEach(n => { nameById[n.id] = n.label || n.name || ""; });

  State.expandedNodes.clear();
  State.lastExpandedId  = null;
  State._clickedNodeId  = null;
  State.pendingExpand   = null;
  State._bfsAdj         = null;
  State._bfsGraphHash   = "";
  clearTimeout(State.physicsTimer);
  State.physicsTimer    = null;
  clearTimeout(State._clickTimer);
  State._clickTimer     = null;
  State._lastClickNode  = null;

  const existingIds = new Set(State.graphNodes.map(n => n.id));
  State.graphNodes  = graph.nodes.map(n => buildNodeState(n, seedId, existingIds, graph));
  State.graphEdges  = graph.edges.map(e => buildEdgeState(e));

  finalizeGraphState(seedId, nameById, savedPositions, graph, false);
}

// ════════════════════════════════════════════════════════════════════════════
// MERGE GRAPH
// ════════════════════════════════════════════════════════════════════════════

function mergeGraph(graph) {
  const expandedId = graph.seed_id ?? (graph.nodes[0]?.id);

  const savedPositions = State.network ? State.network.getPositions() : {};

  const existingNodeIds  = new Set(State.graphNodes.map(n => n.id));
  const existingEdgeKeys = new Set(State.graphEdges.map(e => e.id));

  const nameById = {};
  State.graphNodes.forEach(n => { nameById[n.id] = n.name; });
  graph.nodes.forEach(n => { nameById[n.id] = n.label || n.name || ""; });

  for (const n of graph.nodes) {
    if (!existingNodeIds.has(n.id)) {
      State.graphNodes.push(buildNodeState(n, null, existingNodeIds, graph));
    } else {
      // Update betweenness on existing node if provided
      const existing = State.graphNodes.find(x => x.id === n.id);
      if (existing) {
        if (n.betweenness_normalised != null) existing._betweennessNorm = n.betweenness_normalised;
      }
    }
  }

  for (const e of graph.edges) {
    const lo  = Math.min(e.from, e.to);
    const hi  = Math.max(e.from, e.to);
    const key = `${lo}_${hi}`;
    if (!existingEdgeKeys.has(key)) {
      State.graphEdges.push(buildEdgeState(e));
    }
  }

  State.expandedNodes.add(expandedId);
  State.lastExpandedId = expandedId;

  // Записываем родителя expand-дерева: кликнутая нода = _clickedNodeId
  const expandedNode = State.graphNodes.find(n => n.id === expandedId);
  if (expandedNode && expandedNode._expandParent == null) {
    expandedNode._expandParent = State._clickedNodeId ?? State.currentSeedId ?? null;
  }

  finalizeGraphState(State.currentSeedId, nameById, savedPositions, graph, true);
}

// ─── Node / edge state constructors ────────────────────────────────────────

// Task 6: _dimBorder persisted onto graphNode state
// Task 3: _betweennessNorm stored from API response
function buildNodeState(n, seedId, existingIds, graph) {
  const isSeed   = (n.id === seedId);
  const domRole  = "primary"; // computed later
  const rs       = roleStyle(domRole);
  const accent   = isSeed ? COLOR.signal : rs.color;
  const dimBorder = isSeed ? "rgba(94,230,197,0.45)" : `${accent}40`;

  return {
    id:               n.id,
    name:             n.label || n.name || "",
    imageUrl:         n.image || "",
    geniusUrl:        n.url   || null,
    genres:           [],
    isSeed:           isSeed,
    _isNew:           existingIds ? !existingIds.has(n.id) : true,
    _backendWeight:   n.weight || null,
    _betweennessNorm: n.betweenness_normalised ?? null,
    _dimBorder:       dimBorder,        // Task 6: persisted here
    _accent:          accent,
  };
}

function buildEdgeState(e) {
  const lo   = Math.min(e.from, e.to);
  const hi   = Math.max(e.from, e.to);
  const role = resolveEdgeDominantRole(e);
  return {
    id:                  `${lo}_${hi}`,
    from:                e.from,
    to:                  e.to,
    weight:              e.weight || 1,
    collaboration_count: e.collaboration_count || null,
    collaborations:      e.collaborations || [],
    // Task 1: path endpoint returns songs[] instead of collaborations[]
    songs:               e.songs || [],
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
  // Task 3: refresh _dimBorder after roles are resolved
  refreshNodeDimBorders();
  // Инвалидируем кэш цветов — граф изменился.
  _defaultNodeColors = null;
  _defaultEdgeColors = null;

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

// Task 6: keep _dimBorder in sync after role computation
function refreshNodeDimBorders() {
  for (const n of State.graphNodes) {
    const rs = roleStyle(n._dominantRole || "primary");
    const accent = n.isSeed ? COLOR.signal : rs.color;
    n._accent    = accent;
    n._dimBorder = n.isSeed ? "rgba(94,230,197,0.45)" : `${accent}40`;
  }
}

function computeNodeDominantRoles() {
  // O(N+E): один проход по рёбрам, накапливаем веса по ролям.
  const roleWeights = new Map();  // nodeId → {role: weight}
  for (const n of State.graphNodes) roleWeights.set(n.id, {});
  for (const e of State.graphEdges) {
    const r = e.dominantRole || "primary";
    const w = e.weight || 1;
    if (roleWeights.has(e.from)) {
      const m = roleWeights.get(e.from);
      m[r] = (m[r] || 0) + w;
    }
    if (roleWeights.has(e.to)) {
      const m = roleWeights.get(e.to);
      m[r] = (m[r] || 0) + w;
    }
  }
  for (const n of State.graphNodes) {
    if (n.isSeed) { n._dominantRole = "featured"; continue; }
    const counts = roleWeights.get(n.id) || {};
    let top = "primary", topC = 0;
    for (const [r, c] of Object.entries(counts)) if (c > topC) { top = r; topC = c; }
    n._dominantRole = top;
  }
}

function cacheNodeCollaborations() {
  // Строим adjacency-индекс один раз за O(E) вместо O(N×E) фильтрации.
  const edgesByNode = new Map();
  for (const n of State.graphNodes) edgesByNode.set(n.id, []);
  for (const e of State.graphEdges) {
    if (edgesByNode.has(e.from)) edgesByNode.get(e.from).push(e);
    if (edgesByNode.has(e.to))   edgesByNode.get(e.to).push(e);
  }
  for (const n of State.graphNodes) {
    const inc = edgesByNode.get(n.id) || [];
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

  // Seed сразу в (0,0) и зафиксирован — nodeVisual уже выставил x/y/fixed,
  // но moveNode гарантирует позицию до первого тика физики.
  if (seedId != null) {
    State.network.moveNode(seedId, 0, 0);
  }

  updateEdgeRenderMode();
  _attachZoomThrottle();
  fadeInNewNodes();
  attachNetworkEvents(nameById);

  State.network.once("stabilizationIterationsDone", () => {
    if (!State.network) return;
    State.network.setOptions({ physics: { enabled: false } });
    // После стабилизации восстанавливаем seed в (0,0) — stabilization могла сдвинуть.
    if (seedId != null) State.network.moveNode(seedId, 0, 0);
    State.network.fit({ animation: { duration: 400, easingFunction: "easeInOutQuad" } });
    clearTimeout(State.physicsTimer);
    State.physicsTimer = null;
  });

  scheduleFreeze(PHYSICS_SETTLE_MS);
}

let _zoomThrottleTimer = null;
function _attachZoomThrottle() {
  if (!State.network) return;
  State.network.on("zoom", () => {
    if (State.graphEdges.length < 120) return;
    // При быстром зуме: дебаунсим redraw чтобы не перерисовывать каждый тик.
    if (_zoomThrottleTimer) clearTimeout(_zoomThrottleTimer);
    _zoomThrottleTimer = setTimeout(() => {
      _zoomThrottleTimer = null;
      if (State.network) State.network.redraw();
    }, 60);
  });
  // При очень большом графе: отключаем hover-эффекты на рёбрах (дорогой hit-test).
  State.network.on("zoom", () => {
    if (!State.network) return;
    const scale = State.network.getScale();
    const bigGraph = State.graphEdges.length > FAST_RENDER_EDGE_THRESHOLD;
    // При zoom-out на большом графе — выключаем hover полностью.
    if (bigGraph && scale < 0.5) {
      State.network.setOptions({ interaction: { hover: false } });
    } else if (bigGraph && scale >= 0.5) {
      State.network.setOptions({ interaction: { hover: true } });
    }
  });
}

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

  // Seed всегда в (0,0).
  if (State.currentSeedId != null) {
    State.network.moveNode(State.currentSeedId, 0, 0);
  }

  // Восстанавливаем fixed для expanded нод (они могли стать !fixed после nodeVisual rebuild).
  State.expandedNodes.forEach(nodeId => {
    if (nodeId === State.currentSeedId) return;
    const pos = State.network.getPosition(nodeId);
    if (pos) State.nodesDS.update({ id: nodeId, fixed: { x: true, y: true } });
  });

  fadeInNewNodes();
  nudgePhysics(PHYSICS_SETTLE_MS);
}

// Fit viewport на последний добавленный expanded-кластер.
// Анимация мягкая — не перебрасывает весь граф.
function _fitToExpandedCluster() {
  if (!State.network || State.expandedNodes.size === 0) return;
  // Берём последний expanded и его листья
  const expanded = [...State.expandedNodes];
  const lastExpanded = expanded[expanded.length - 1];
  const conn = State.network.getConnectedNodes(lastExpanded);
  const nodeIds = [lastExpanded, ...conn].slice(0, 40);
  // Не делаем fit если уже смотрим на нужную область
  try {
    State.network.fit({
      nodes: nodeIds,
      animation: { duration: 600, easingFunction: "easeInOutQuad" }
    });
  } catch(e) { /* ignore */ }
}


function mergeNetwork(nameById, savedPositions) {
  // Отменяем предыдущую анимацию вылета, если ещё идёт.
  if (State._expandAnimId != null) {
    cancelAnimationFrame(State._expandAnimId);
    State._expandAnimId = null;
  }
  // Останавливаем предыдущую физику/таймер заморозки.
  clearTimeout(State.physicsTimer);
  State.physicsTimer = null;
  if (State.network) State.network.setOptions({ physics: { enabled: false } });

  const dsNodeIds = new Set(State.nodesDS.getIds());
  const dsEdgeIds = new Set(State.edgesDS.getIds());

  const freshNodes = State.graphNodes.filter(n => n._isNew && !dsNodeIds.has(n.id));
  const newNodeItems  = freshNodes.map(n => nodeVisual(n));
  const newEdgeItems  = State.graphEdges
    .filter(e => !dsEdgeIds.has(e.id))
    .map(e => edgeVisual(e, nameById));

  if (newNodeItems.length) State.nodesDS.add(newNodeItems);
  if (newEdgeItems.length) State.edgesDS.add(newEdgeItems);

  const existingUpdates = State.graphNodes
    .filter(n => !n._isNew && dsNodeIds.has(n.id))
    .map(n => {
      const v = nodeVisual(n);
      return { id: n.id, size: v.size, color: v.color, borderWidth: v.borderWidth,
               shadow: v.shadow, mass: v.mass, title: v.title, label: v.label,
               font: v.font, fixed: v.fixed };
    });
  if (existingUpdates.length) State.nodesDS.update(existingUpdates);

  // ── Детерминированный старт ────────────────────────────────────────────────
  // placeExpandedNodes вычисляет куда полетит каждая нода.
  // Мы используем эти позиции только как СТАРТОВЫЕ для вылета и для физики.
  // Физика сама дойдёт до финала — никакой жёсткой заморозки в RAF.
  const { targets, fromPos } = placeExpandedNodes(savedPositions);

  // Ставим все ноды в стартовые позиции (fromPos) сразу, без redraw.
  // Seed — всегда в (0,0).
  const net  = State.network;
  const body = net && net.body && net.body.nodes;
  for (const [id, f] of fromPos) {
    if (body && body[id]) { body[id].x = f.x; body[id].y = f.y; }
    else if (net) net.moveNode(id, f.x, f.y);
  }
  if (State.currentSeedId != null && net) net.moveNode(State.currentSeedId, 0, 0);

  fadeInNewNodes();

  // ── Вылет: RAF-анимация 420мс, ноды летят fromPos → targets ──────────────
  // После завершения вылета включаем физику — она разрешит все наслоения.
  const FLYOUT_MS = 420;
  const ids = [...targets.keys()];
  const M   = ids.length;
  const sx  = new Float32Array(M), sy = new Float32Array(M);
  const tx  = new Float32Array(M), ty = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const f = fromPos.get(ids[i]) || { x: 0, y: 0 };
    const t = targets.get(ids[i]);
    sx[i] = f.x; sy[i] = f.y; tx[i] = t.x; ty[i] = t.y;
  }

  const easeOut = t => 1 - Math.pow(1 - t, 3);
  let t0 = null;

  function flyStep(ts) {
    if (!State.network) { State._expandAnimId = null; return; }
    if (t0 === null) t0 = ts;
    const pct = easeOut(Math.min((ts - t0) / FLYOUT_MS, 1));

    if (body) {
      for (let i = 0; i < M; i++) {
        const nb = body[ids[i]];
        if (nb) { nb.x = sx[i] + (tx[i] - sx[i]) * pct; nb.y = sy[i] + (ty[i] - sy[i]) * pct; }
      }
      net.redraw();
    } else {
      for (let i = 0; i < M; i++)
        net.moveNode(ids[i], sx[i] + (tx[i] - sx[i]) * pct, sy[i] + (ty[i] - sy[i]) * pct);
    }
    if (State.currentSeedId != null) net.moveNode(State.currentSeedId, 0, 0);

    if (pct < 1) {
      State._expandAnimId = requestAnimationFrame(flyStep);
      return;
    }

    // ── Вылет завершён → передаём в физику ──────────────────────────────────
    State._expandAnimId = null;

    // Снимаем fixed со всех нод кроме seed — физика должна двигать их.
    // Seed остаётся fixed, expanded-ноды получают высокую массу (притягивают листья).
    const unfixUpdates = [];
    for (const n of State.graphNodes) {
      if (n.id === State.currentSeedId) continue;
      const isExp = State.expandedNodes.has(n.id);
      unfixUpdates.push({
        id:    n.id,
        fixed: false,
        mass:  isExp ? 6 : 1,    // expanded тяжёлые, листья свободны
      });
    }
    if (unfixUpdates.length) State.nodesDS.update(unfixUpdates);

    // Включаем barnesHut с параметрами для expand:
    //   springLength = LEAF_R  → листья оседают на нужном радиусе
    //   avoidOverlap = 1       → ноды не наслаиваются
    //   centralGravity = 0     → кластеры не съезжаются к центру
    //   gravitationalConstant большой → expanded-ноды сильно отталкиваются
    net.setOptions({
      physics: {
        enabled: true,
        solver:  "barnesHut",
        barnesHut: {
          gravitationalConstant: -12000,
          centralGravity:        0.0,
          springLength:          LEAF_R,
          springConstant:        0.06,
          damping:               0.85,
          avoidOverlap:          1.0
        },
        stabilization: { enabled: false },  // стабилизируем через тики, не batch
        timestep:         0.3,
        adaptiveTimestep: true,
        maxVelocity:      80,
        minVelocity:      0.5
      }
    });

    // Камера: плавно подстраиваем под конечный bbox targets.
    try {
      let mnx = 0, mxx = 0, mny = 0, mxy = 0;
      for (let i = 0; i < M; i++) {
        if (tx[i] < mnx) mnx = tx[i]; if (tx[i] > mxx) mxx = tx[i];
        if (ty[i] < mny) mny = ty[i]; if (ty[i] > mxy) mxy = ty[i];
      }
      const pad = 140;
      const cw  = (els.network && els.network.clientWidth)  || 1100;
      const ch  = (els.network && els.network.clientHeight) || 720;
      const sc  = Math.min(cw / Math.max(1, mxx - mnx + pad * 2),
                           ch / Math.max(1, mxy - mny + pad * 2));
      net.moveTo({
        position: { x: (mnx + mxx) / 2, y: (mny + mxy) / 2 },
        scale:    Math.max(0.14, Math.min(sc, 1.25)),
        animation: { duration: 700, easingFunction: "easeInOutQuad" }
      });
    } catch (e) { /* ignore */ }

    // Замораживаем через PHYSICS_EXPAND_MS мс.
    // После заморозки восстанавливаем красивые кривые рёбра.
    State.physicsTimer = setTimeout(() => {
      State.physicsTimer = null;
      if (!State.network) return;
      State.network.setOptions({ physics: { enabled: false } });
      updateEdgeRenderMode();
      // Фиксируем все ноды на их финальных позициях.
      const fixAll = State.graphNodes.map(n => ({
        id:    n.id,
        fixed: { x: true, y: true }
      }));
      if (State.nodesDS) State.nodesDS.update(fixAll);
      if (State.currentSeedId != null) State.network.moveNode(State.currentSeedId, 0, 0);
    }, PHYSICS_EXPAND_MS);
  }

  // _isNew сбрасываем до старта RAF — fadeInNewNodes уже прочитал их.
  for (const n of freshNodes) n._isNew = false;

  State._expandAnimId = requestAnimationFrame(flyStep);
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXPAND LAYOUT  —  «одуванчики» + «круги Эйлера»
//
//  Настраивается пятью числами:
//    POLE_DIST  — расстояние seed → expanded-нода (px)
//    LEAF_R     — радиус первого кольца листьев (px)
//    LEAF_GAP   — шаг между кольцами листьев (px)
//    NODE_W     — ширина ноды + зазор (px, задаёт ёмкость кольца)
//    EULER_GAP  — зазор в зоне пересечения Эйлера (px)
//
//  Две публичные функции:
//    placeExpandedNodes(savedPositions) → {targets, fromPos}  (вычисление позиций)
//    mergeNetwork использует targets как СТАРТ вылета, физика дойдёт до финала
// ═══════════════════════════════════════════════════════════════════════════

const POLE_DIST   = 440;   // px: seed → expanded-нода
const LEAF_R      = 165;   // px: радиус первого кольца листьев
const LEAF_GAP    = 14;    // px: зазор между кольцами
const NODE_W      = 80;    // px: ширина ноды + минимальный зазор
const EULER_GAP   = 80;    // px: зазор в линзе пересечения (Эйлер)
const ANIM_MS     = 5800;   // мс: длительность анимации

function _easeOut3(t) { return 1 - Math.pow(1 - t, 3); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Ёмкость кольца радиуса r (сколько нод помещается без перекрытий)
function _ringCap(r) { return Math.max(1, Math.floor(2 * Math.PI * r / NODE_W)); }

// Внешний радиус «одуванчика» для N эксклюзивных листьев
function _dandelionR(n) {
  if (n <= 0) return LEAF_R * 0.5;
  let rem = n, k = 0;
  while (rem > 0) { rem -= _ringCap(LEAF_R + k * LEAF_GAP); k++; if (k > 60) break; }
  return LEAF_R + (k - 1) * LEAF_GAP + NODE_W * 0.5;
}

// ─────────────────────────────────────────────────────────────────────────────
// placeExpandedNodes
//
// Считает целевые позиции (targets) и стартовые позиции (fromPos) для анимации.
// Сложность: O(E + N) — нет итерационных циклов, нет релаксации.
// ─────────────────────────────────────────────────────────────────────────────
function placeExpandedNodes(savedPositions) {
  const targets = new Map(), fromPos = new Map();
  if (!State.network || !State.nodesDS) return { targets, fromPos };

  const expanded = [...State.expandedNodes];
  if (!expanded.length) return { targets, fromPos };

  const seedId     = State.currentSeedId;
  const expandedSet = new Set(expanded);

  // Начальная позиция для анимации: сохранённая — для уже существующих нод,
  // (0,0) — для новых нод (они вылетают из seed).
  const getFrom = id => {
    const sp = savedPositions[id];
    return sp ? { x: sp.x, y: sp.y } : { x: 0, y: 0 };
  };

  // Seed всегда в центре, зафиксирован.
  if (seedId != null) {
    State.network.moveNode(seedId, 0, 0);
    State.nodesDS.update({ id: seedId, fixed: { x: true, y: true } });
  }

  const poles = expanded.filter(id => id !== seedId);
  if (!poles.length) return { targets, fromPos };

  // ── 1. Один проход O(E): кэш весов рёбер + классификация листьев ────────────
  const wCache    = new Map();               // "minId_maxId" → weight
  const leafOwners = new Map();              // leafId → Set<poleId>

  for (const e of State.graphEdges) {
    const a = e.from, b = e.to;
    const w = Math.max(1, Number(e.weight || e.collaboration_count || 1));
    wCache.set(a < b ? a + '_' + b : b + '_' + a, w);

    const aIsPole = expandedSet.has(a) && a !== seedId;
    const bIsPole = expandedSet.has(b) && b !== seedId;

    if (aIsPole && !expandedSet.has(b) && b !== seedId) {
      let s = leafOwners.get(b); if (!s) { s = new Set(); leafOwners.set(b, s); } s.add(a);
    }
    if (bIsPole && !expandedSet.has(a) && a !== seedId) {
      let s = leafOwners.get(a); if (!s) { s = new Set(); leafOwners.set(a, s); } s.add(b);
    }
  }

  const exclusive = new Map();   // poleId → [leafId, ...]
  const sharedLeaves = [];       // { leaf, owners:Set }
  for (const id of poles) exclusive.set(id, []);
  for (const [leaf, owners] of leafOwners) {
    if (owners.size === 1) {
      const [pole] = owners;
      if (exclusive.has(pole)) exclusive.get(pole).push(leaf);
    } else {
      sharedLeaves.push({ leaf, owners });
    }
  }

  // ── 2. Размещение полюсов вокруг seed ── O(N log N) ──────────────────────────
  //
  // Ключевой принцип: каждый полюс «отплывает» в том направлении, где он уже
  // находился как лист — это и есть эффект «нода отплывает в сторону от родителя».
  // Для новых нод без позиции находим наибольший свободный угол.

  const poleInfo = poles.map(id => {
    const sp = savedPositions[id];
    const ang = (sp && (sp.x !== 0 || sp.y !== 0))
      ? Math.atan2(sp.y, sp.x)
      : null;  // будет назначен ниже
    const wKey = id < seedId ? id + '_' + seedId : seedId + '_' + id;
    const w = wCache.get(wKey) || 1;
    const dist = clamp(POLE_DIST + (w - 1) * 22, POLE_DIST, 860);
    return { id, ang, dist, dR: _dandelionR(exclusive.get(id).length) };
  });

  // Назначаем углы полюсам без сохранённой позиции.
  const takenAngles = poleInfo.filter(p => p.ang !== null).map(p => p.ang);
  for (const p of poleInfo.filter(p => p.ang === null)) {
    if (takenAngles.length === 0) {
      p.ang = -Math.PI / 2;  // первый полюс — вверх
    } else {
      // Ищем наибольший зазор между существующими углами.
      const sorted = [...takenAngles].sort((a, b) => a - b);
      let bestGap = 0, bestAng = 0;
      for (let i = 0; i < sorted.length; i++) {
        const next = sorted[(i + 1) % sorted.length];
        const gap  = ((next - sorted[i]) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
        if (gap > bestGap) { bestGap = gap; bestAng = sorted[i] + gap / 2; }
      }
      p.ang = bestAng;
    }
    takenAngles.push(p.ang);
  }

  // Лёгкое угловое расталкивание (3 прохода, только O(N) — N мало).
  // Гарантирует что одуванчики не перекрывают друг друга.
  for (let pass = 0; pass < 3; pass++) {
    poleInfo.sort((a, b) => a.ang - b.ang);
    for (let i = 0; i < poleInfo.length; i++) {
      const A = poleInfo[i], B = poleInfo[(i + 1) % poleInfo.length];
      const minAng = 2 * Math.asin(clamp((A.dR + B.dR + EULER_GAP) / (A.dist + B.dist), 0, 1));
      const gap = ((B.ang - A.ang) + 2 * Math.PI) % (2 * Math.PI);
      if (gap < minAng && gap >= 0) {
        const push = (minAng - gap) / 2;
        A.ang -= push; B.ang += push;
      }
    }
  }

  // Фиксируем позиции полюсов.
  const P = new Map();   // poleId → {x, y, dR}
  for (const { id, ang, dist, dR } of poleInfo) {
    const x = Math.cos(ang) * dist, y = Math.sin(ang) * dist;
    P.set(id, { x, y, dR });
    targets.set(id, { x, y });
    fromPos.set(id, getFrom(id));
  }

  // ── 3. Эксклюзивные листья: концентрические кольца («одуванчик») ──────────────
  for (const [poleId, leaves] of exclusive) {
    if (!leaves.length) continue;
    const { x: px, y: py } = P.get(poleId);
    const baseAngle = Math.atan2(py, px);   // кольцо ориентировано наружу от seed
    let rem = [...leaves], k = 0;
    while (rem.length) {
      const r   = LEAF_R + k * LEAF_GAP;
      const cap = _ringCap(r);
      const batch = rem.splice(0, cap);
      batch.forEach((leaf, i) => {
        const ang = baseAngle + (2 * Math.PI * i) / batch.length;
        targets.set(leaf, { x: px + Math.cos(ang) * r, y: py + Math.sin(ang) * r });
        fromPos.set(leaf, getFrom(leaf));
      });
      k++;
    }
  }

  // ── 4. Shared-листья: в зоне пересечения (круги Эйлера) ─────────────────────
  //
  // Группируем по уникальному набору владельцев (одна «линза» на пару/тройку).
  const eulerZones = new Map();
  for (const { leaf, owners } of sharedLeaves) {
    const key = [...owners].map(String).sort().join('_');
    if (!eulerZones.has(key)) eulerZones.set(key, { owners: [...owners], leaves: [] });
    eulerZones.get(key).leaves.push(leaf);
  }

  for (const { owners, leaves } of eulerZones.values()) {
    const valid = owners.filter(o => P.has(o));
    if (!valid.length) continue;

    if (valid.length === 2) {
      // Два владельца: листья ложатся перпендикулярной лентой
      // ровно в центре зазора между краями их облаков.
      const A = P.get(valid[0]), B = P.get(valid[1]);
      const dx = B.x - A.x, dy = B.y - A.y;
      const D  = Math.hypot(dx, dy) || 1;
      const ux = dx / D, uy = dy / D;   // A→B
      const px = -uy, py = ux;          // перпендикуляр

      // Центроид зазора: посередине между краями облаков A и B.
      const midDist = (A.dR + (D - B.dR)) / 2;
      const cx = A.x + ux * clamp(midDist, A.dR * 0.5, D - B.dR * 0.5);
      const cy = A.y + uy * clamp(midDist, A.dR * 0.5, D - B.dR * 0.5);

      leaves.forEach((leaf, i) => {
        const off = (i - (leaves.length - 1) / 2) * NODE_W;
        targets.set(leaf, { x: cx + px * off, y: cy + py * off });
        fromPos.set(leaf, getFrom(leaf));
      });
    } else {
      // Три+ владельца: компактное кольцо в центроиде.
      let cx = 0, cy = 0;
      valid.forEach(o => { cx += P.get(o).x; cy += P.get(o).y; });
      cx /= valid.length; cy /= valid.length;
      const r = Math.max(NODE_W, (leaves.length * NODE_W) / (2 * Math.PI));
      leaves.forEach((leaf, i) => {
        const ang = (2 * Math.PI * i) / leaves.length;
        targets.set(leaf, { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
        fromPos.set(leaf, getFrom(leaf));
      });
    }
  }

  // ── 5. Seed-only листья — сохраняем их позиции ──────────────────────────────
  for (const n of State.graphNodes) {
    if (expandedSet.has(n.id) || n.id === seedId || leafOwners.has(n.id)) continue;
    if (savedPositions[n.id]) {
      const { x, y } = savedPositions[n.id];
      targets.set(n.id, { x, y });
      fromPos.set(n.id, { x, y });
    }
  }

  return { targets, fromPos };
}



// ────────────────────────────────────────────────────────────────────────────
// Fade-in animation for new nodes
// ────────────────────────────────────────────────────────────────────────────

function fadeInNewNodes() {
  const newIds = State.graphNodes.filter(n => n._isNew).map(n => n.id);
  if (!newIds.length) return;
  let start = null;
  const duration = 600;
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function step(ts) {
    if (!start) start = ts;
    const t = easeOut(Math.min((ts - start) / duration, 1));
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

    if (params.edges?.length > 0 && !params.nodes?.length) {
      showEdgeSidebar(params.edges[0], nameById);
      return;
    }

    if (!params.nodes?.length) { clearFocus(); return; }

    const nodeId = params.nodes[0];
    if (ctrlKey) { openGeniusPage(nodeId); return; }

    if (State._clickTimer && State._lastClickNode === nodeId) {
      clearTimeout(State._clickTimer);
      State._clickTimer    = null;
      State._lastClickNode = null;
      const gn = State.graphNodes.find(n => n.id === nodeId);
      if (gn) {
        showToast(`Expanding ${gn.name}…`, 1800, true);
        State._clickedNodeId = nodeId;
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
      State._clickedNodeId = gn.id;
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

  // Task 4: path panel stays open (no longer force-closes it)
  State.selectedEdgeId = null;

  els.sidebarAvatar.src = node.imageUrl || placeholderFor(node.name, node.isSeed);
  els.sidebarAvatar.alt = node.name;
  els.sidebarName.textContent = node.name;

  const collab   = node._totalCollabs || node.totalWeight || 0;
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

// ════════════════════════════════════════════════════════════════════════════
// HIGHLIGHT — оптимизированные версии для больших графов
//
// Проблема: nodesDS.forEach + update при 200+ нодах и 500+ рёбрах
// вызывает перерисовку всего canvas на каждое hover-событие.
//
// Оптимизации:
//  1. При > HIGHLIGHT_SKIP_THRESHOLD рёбрах hover-highlight отключается
//     (граф и так нечитаем при таком размере).
//  2. restoreDefaultColors — батч-update только изменившихся элементов
//     через Map для O(1) lookup вместо find().
//  3. Highlight debounced на requestAnimationFrame — не дублируем при
//     быстром движении мыши.
// ════════════════════════════════════════════════════════════════════════════

const HIGHLIGHT_SKIP_THRESHOLD = 300;  // рёбер; выше — отключаем hover-dim

// Кэш «дефолтного» состояния нод и рёбер для быстрого restoreDefaultColors.
// Заполняется в buildDefaultColorCache() при каждом изменении графа.
let _defaultNodeColors = null;  // Map<id, {border, shadow}>
let _defaultEdgeColors = null;  // Map<id, color>

function buildDefaultColorCache() {
  _defaultNodeColors = new Map();
  _defaultEdgeColors = new Map();
  for (const n of State.graphNodes) {
    _defaultNodeColors.set(n.id, {
      border: n._dimBorder || "rgba(40,48,68,0.25)",
      shadow: betweennessGlow(n)
    });
  }
  for (const e of State.graphEdges) {
    _defaultEdgeColors.set(e.id, roleStyle(e.dominantRole).color);
  }
}

let _hlRafId = null;

function highlightNeighborhood(nodeId) {
  if (!State.nodesDS || !State.edgesDS) return;
  // При большом графе hover-dimming убивает FPS — пропускаем.
  if (State.graphEdges.length > HIGHLIGHT_SKIP_THRESHOLD) return;

  if (_hlRafId) cancelAnimationFrame(_hlRafId);
  _hlRafId = requestAnimationFrame(() => {
    _hlRafId = null;
    if (!State.nodesDS || !State.edgesDS) return;
    const connNodes = new Set(State.network.getConnectedNodes(nodeId));
    const connEdges = new Set(State.network.getConnectedEdges(nodeId));

    // Строим lookup по vis-данным за один проход через getIds() вместо forEach.
    const nodeIds = State.nodesDS.getIds();
    const edgeIds = State.edgesDS.getIds();

    const nU = new Array(nodeIds.length);
    for (let i = 0; i < nodeIds.length; i++) {
      const id = nodeIds[i];
      const t  = id === nodeId || connNodes.has(id);
      const nd = State.nodesDS.get(id);
      nU[i] = { id,
        color:   { border: t ? (nd?._accent || COLOR.pulse) : "rgba(40,48,68,0.08)",
                   background: t ? COLOR.panel : "rgba(20,26,40,0.08)" },
        opacity: t ? 1 : 0.08 };
    }
    const eU = new Array(edgeIds.length);
    for (let i = 0; i < edgeIds.length; i++) {
      const id = edgeIds[i];
      const t  = connEdges.has(id);
      const ed = State.edgesDS.get(id);
      eU[i] = { id,
        color: { color: t ? (ed?._color || COLOR.pulse) : "rgba(40,48,68,0.02)",
                 opacity: t ? 0.95 : 0.02 } };
    }
    State.nodesDS.update(nU);
    State.edgesDS.update(eU);
  });
}

function highlightEdgePair(edgeId) {
  if (!State.edgesDS || !State.network) return;
  if (State.graphEdges.length > HIGHLIGHT_SKIP_THRESHOLD) return;

  if (_hlRafId) cancelAnimationFrame(_hlRafId);
  _hlRafId = requestAnimationFrame(() => {
    _hlRafId = null;
    if (!State.nodesDS || !State.edgesDS) return;
    const pairSet = new Set(State.network.getConnectedNodes(edgeId));

    const nodeIds = State.nodesDS.getIds();
    const edgeIds = State.edgesDS.getIds();

    const nU = nodeIds.map(id => ({ id, opacity: pairSet.has(id) ? 1 : 0.10 }));
    const eU = edgeIds.map(id => {
      const ed = State.edgesDS.get(id);
      return { id, color: {
        color:   id === edgeId ? (ed?._color || COLOR.pulse) : "rgba(40,48,68,0.02)",
        opacity: id === edgeId ? 1 : 0.02
      }};
    });
    State.nodesDS.update(nU);
    State.edgesDS.update(eU);
  });
}

function restoreDefaultColors() {
  if (!State.nodesDS || !State.edgesDS) return;
  if (_hlRafId) { cancelAnimationFrame(_hlRafId); _hlRafId = null; }

  // Используем кэш вместо повторного вычисления betweennessGlow для каждой ноды.
  if (!_defaultNodeColors) buildDefaultColorCache();

  const nU = [], eU = [];
  _defaultNodeColors.forEach(({ border, shadow }, id) => {
    nU.push({ id, color: { border, background: COLOR.panel }, opacity: 1, shadow });
  });
  _defaultEdgeColors.forEach((color, id) => {
    eU.push({ id, color: { color, opacity: 0.45 } });
  });
  if (nU.length) State.nodesDS.update(nU);
  if (eU.length) State.edgesDS.update(eU);
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
// BFS PATHFINDING (client-side fallback)
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

// Task 1: highlight path nodes+edges in neon
function highlightPath(path) {
  if (!State.nodesDS || !State.edgesDS || !path) return;
  const pathSet   = new Set(path);
  const pathEdges = new Set();
  for (let i = 0; i < path.length - 1; i++) {
    const lo = Math.min(path[i], path[i + 1]);
    const hi = Math.max(path[i], path[i + 1]);
    pathEdges.add(`${lo}_${hi}`);
  }
  // Используем getIds() вместо forEach — избегаем лишних object lookups.
  const nodeIds = State.nodesDS.getIds();
  const edgeIds = State.edgesDS.getIds();
  const nU = nodeIds.map(id => ({
    id,
    color:   { border: pathSet.has(id) ? COLOR.neon : "rgba(40,48,68,0.08)", background: COLOR.panel },
    opacity: pathSet.has(id) ? 1 : 0.12
  }));
  const eU = edgeIds.map(id => ({
    id,
    color: { color: pathEdges.has(id) ? COLOR.neon : "rgba(40,48,68,0.02)",
             opacity: pathEdges.has(id) ? 1 : 0.02 },
    width: pathEdges.has(id) ? 5 : undefined
  }));
  State.nodesDS.update(nU);
  State.edgesDS.update(eU);
}

function clearPathHighlight() {
  State.pathHighlight = null;
  restoreDefaultColors();
  if (els.pathResult) {
    els.pathResult.textContent = "";
    els.pathResult.className   = "path-result";
  }
  if (els.hopChain) els.hopChain.innerHTML = "";
}

// ════════════════════════════════════════════════════════════════════════════
// TASK 1: SERVER PATH ENDPOINT
// ════════════════════════════════════════════════════════════════════════════

async function runServerPath(fromName, toName) {
  if (State.pathInFlight) return;
  State.pathInFlight = true;

  // Show loading state in the path result area
  if (els.pathResult) {
    els.pathResult.className   = "path-result is-loading";
    els.pathResult.innerHTML   = `<span class="spinner"></span> Finding path…`;
  }
  if (els.hopChain) els.hopChain.innerHTML = "";

  const roles = [...State.activeFilters].join(",");
  const url   = `/api/v1/graph/path?from=${encodeURIComponent(fromName)}&to=${encodeURIComponent(toName)}&roles=${encodeURIComponent(roles)}`;

  try {
    const res  = await fetch(url);
    const data = res.ok ? await res.json() : null;

    if (!data || data.error) {
      const msg = data?.message || "No path found between these artists.";
      if (els.pathResult) {
        els.pathResult.className = "path-result is-error";
        els.pathResult.textContent = msg;
      }
      return;
    }

    // Merge returned nodes+edges into canvas
    if (data.nodes?.length) {
      mergePathData(data);
    }

    const path = data.path || [];
    if (!path.length) {
      if (els.pathResult) {
        els.pathResult.className   = "path-result is-error";
        els.pathResult.textContent = "No path found.";
      }
      return;
    }

    State.pathHighlight = path;
    highlightPath(path);

    const hops = path.length - 1;
    const nameById = {};
    State.graphNodes.forEach(n => { nameById[n.id] = n.name; });
    // Also use names from the response directly
    (data.nodes || []).forEach(n => { nameById[n.id] = n.name || n.label || ""; });

    const names = path.map(id => nameById[id] || String(id));

    if (els.pathResult) {
      els.pathResult.className   = "path-result";
      els.pathResult.textContent = `${hops} hop${hops === 1 ? "" : "s"}: ${names.join(" → ")}`;
    }

    // Task 1: render hop chain
    renderHopChain(path, data.edges || [], data.nodes || [], nameById);

  } catch (err) {
    if (els.pathResult) {
      els.pathResult.className   = "path-result is-error";
      els.pathResult.textContent = "Request failed: " + (err.message || "network error");
    }
  } finally {
    State.pathInFlight = false;
  }
}

// Merge path API response into State.graphNodes / graphEdges + vis datasets
function mergePathData(data) {
  const existingNodeIds  = new Set(State.graphNodes.map(n => n.id));
  const existingEdgeKeys = new Set(State.graphEdges.map(e => e.id));

  const nameById = {};

  const savedPositions = State.network ? State.network.getPositions() : {};

  for (const n of (data.nodes || [])) {
    nameById[n.id] = n.name || n.label || "";
    if (!existingNodeIds.has(n.id)) {
      const ns = buildNodeState(n, null, existingNodeIds, data);
      State.graphNodes.push(ns);
    } else {
      // Update betweenness on existing
      const ex = State.graphNodes.find(x => x.id === n.id);
      if (ex && n.betweenness_normalised != null) ex._betweennessNorm = n.betweenness_normalised;
    }
  }

  for (const e of (data.edges || [])) {
    const lo  = Math.min(e.from, e.to);
    const hi  = Math.max(e.from, e.to);
    const key = `${lo}_${hi}`;
    if (!existingEdgeKeys.has(key)) {
      State.graphEdges.push(buildEdgeState(e));
    }
  }

  computeNodeSizes();
  cacheNodeCollaborations();
  computeNodeDominantRoles();
  refreshNodeDimBorders();

  if (!State.hasRendered) {
    showGraphView();
    State.hasRendered = true;
  }

  if (!State.network) {
    initNetwork(null, nameById);
  } else {
    mergeNetwork(nameById, savedPositions);
  }

  updateStatus(data);
  updateStatusFilters();

  const newHash = graphHash();
  if (newHash !== State._bfsGraphHash) {
    State._bfsAdj       = null;
    State._bfsGraphHash = newHash;
  }
}

// Task 1: render step-by-step hop chain
function renderHopChain(path, edges, nodes, nameById) {
  if (!els.hopChain || path.length < 2) { if (els.hopChain) els.hopChain.innerHTML = ""; return; }

  // Build quick node lookup
  const nodeMap = new Map();
  State.graphNodes.forEach(n => nodeMap.set(n.id, n));
  nodes.forEach(n => {
    if (!nodeMap.has(n.id)) nodeMap.set(n.id, { id: n.id, name: n.name || n.label || "", imageUrl: n.image || "" });
  });

  // Build edge lookup by pair key
  const edgeMap = new Map();
  edges.forEach(e => {
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    edgeMap.set(`${lo}_${hi}`, e);
  });
  State.graphEdges.forEach(e => {
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    if (!edgeMap.has(`${lo}_${hi}`)) edgeMap.set(`${lo}_${hi}`, e);
  });

  const rows = [];
  for (let i = 0; i < path.length; i++) {
    const id   = path[i];
    const node = nodeMap.get(id);
    const name = node?.name || nameById[id] || String(id);
    const img  = node?.imageUrl || placeholderFor(name, false);

    // Songs connecting this node to the next
    let songsHtml = "";
    if (i < path.length - 1) {
      const nextId = path[i + 1];
      const lo     = Math.min(id, nextId);
      const hi     = Math.max(id, nextId);
      const edge   = edgeMap.get(`${lo}_${hi}`);
      // Path endpoint returns songs[] (array of title strings or objects)
      const songList = edge?.songs || edge?.collaborations || [];
      const titles   = songList.slice(0, 3).map(s =>
        typeof s === "string" ? s : (s.song || s.title || "Untitled")
      );
      if (titles.length) songsHtml = `<div class="hop-songs">${titles.map(t => escapeHtml(t)).join(" · ")}</div>`;
    }

    const arrowHtml = i < path.length - 1
      ? `<div class="hop-arrow">↓</div>` : "";

    rows.push(
      `<div class="hop-row">` +
      `<img class="hop-avatar" src="${escapeHtml(img)}" onerror="this.src='${placeholderFor(name,false)}'" alt="" />` +
      `<div class="hop-info"><div class="hop-name">${escapeHtml(name)}</div>${songsHtml}</div>` +
      `</div>` +
      arrowHtml
    );
  }
  els.hopChain.innerHTML = rows.join("");
}

// ════════════════════════════════════════════════════════════════════════════
// TASK 5: createGeniusAc() FACTORY — independent debounce per call site
// ════════════════════════════════════════════════════════════════════════════

function createGeniusAc() {
  return debounce(async (query, dropdownEl, onSelect) => {
    if (!query || query.length < 2) { dropdownEl.classList.remove("open"); return; }
    dropdownEl.innerHTML = `<div class="ac-spinner">Searching…</div>`;
    dropdownEl.classList.add("open");
    try {
      const res  = await fetch(`/api/v1/graph?artist=${encodeURIComponent(query)}&role_filter=featured,producer,writer,primary&__ac=1`);
      const data = res.ok ? await res.json() : null;
      const candidates = data?.ambiguous ? (data.candidates || []) : [];

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
              : ""}
          </div>
        </div>
      `).join("");

      dropdownEl.querySelectorAll(".ac-item").forEach(item => {
        item.addEventListener("mousedown", e => {
          e.preventDefault();
          const name = item.getAttribute("data-name");
          dropdownEl.classList.remove("open");
          onSelect(name);
        });
      });
    } catch { dropdownEl.classList.remove("open"); }
  }, 300);
}

function attachGeniusAutocomplete(inputEl, dropdownEl, onSelect, geniusAcFn) {
  const _ac = geniusAcFn || createGeniusAc();

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
    `).join("");
    dropdownEl.classList.add("open");

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

  inputEl.addEventListener("focus", () => {
    if (!inputEl.value.trim()) showHistoryDropdown();
  });

  inputEl.addEventListener("input", () => {
    const val = inputEl.value.trim();
    if (val) {
      _ac(val, dropdownEl, onSelect);
    } else {
      showHistoryDropdown();
    }
  });

  inputEl.addEventListener("blur", () => {
    setTimeout(() => dropdownEl.classList.remove("open"), 150);
  });

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

// Task 4: path inputs — node autocomplete (primary) with Genius fallback
function attachNodeAutocomplete(inputEl, dropdownEl, onSelect) {
  const _genius = createGeniusAc();

  const _showNodes = debounce(() => {
    const q = inputEl.value.trim().toLowerCase();
    if (!q) { dropdownEl.classList.remove("open"); return; }

    const matches = State.graphNodes
      .filter(n => n.name.toLowerCase().includes(q))
      .slice(0, 8);

    if (matches.length) {
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
    } else {
      // Fallback to Genius for names not in canvas
      _genius(inputEl.value.trim(), dropdownEl, name => {
        inputEl.value = name;
        onSelect(name);
      });
    }
  }, 80);

  inputEl.addEventListener("input", _showNodes);
  inputEl.addEventListener("focus", _showNodes);
  inputEl.addEventListener("blur",  () => { setTimeout(() => dropdownEl.classList.remove("open"), 150); });
  inputEl.addEventListener("keydown", e => {
    if (e.key === "Escape") dropdownEl.classList.remove("open");
  });
}

// ════════════════════════════════════════════════════════════════════════════
// TASK 4: PATH PANEL
// ════════════════════════════════════════════════════════════════════════════

function setupPathPanel() {
  // Toggle path panel
  els.btnFindPath?.addEventListener("click", () => {
    els.pathPanel.classList.toggle("show");
  });

  // Task 4: close button
  els.pathPanelClose?.addEventListener("click", () => {
    els.pathPanel.classList.remove("show");
  });

  const pathFromAc = $("path-from-ac");
  const pathToAc   = $("path-to-ac");
  if (pathFromAc) attachNodeAutocomplete(els.pathFromInput, pathFromAc, () => {});
  if (pathToAc)   attachNodeAutocomplete(els.pathToInput,   pathToAc,   () => {});

  els.btnRunPath?.addEventListener("click", async () => {
    const fromName = (els.pathFromInput.value || "").trim();
    const toName   = (els.pathToInput.value   || "").trim();
    if (!fromName || !toName) { showToast("Enter both artist names."); return; }

    // Try server endpoint first (Task 1)
    await runServerPath(fromName, toName);
  });

  // Task 4: clear path button
  els.btnClearPath?.addEventListener("click", () => {
    clearPathHighlight();
    if (els.hopChain) els.hopChain.innerHTML = "";
  });
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
  if (State._expandAnimId != null) {
    cancelAnimationFrame(State._expandAnimId);
    State._expandAnimId = null;
  }
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
  State.lastExpandedId = null;
  State._clickedNodeId = null;
  State.pendingExpand  = null;
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
  if (els.hopChain) els.hopChain.innerHTML = "";
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

  // Task 5: each call site gets its own fresh debounced Genius AC function
  const heroAc    = $("hero-ac");
  const dockAc    = $("dock-ac");
  const heroGacFn = createGeniusAc();
  const dockGacFn = createGeniusAc();

  if (heroAc) {
    attachGeniusAutocomplete(els.heroInput, heroAc, name => {
      els.heroInput.value = name;
      searchArtist(name, false, true);
    }, heroGacFn);
  }
  if (dockAc) {
    attachGeniusAutocomplete(els.dockInput, dockAc, name => {
      els.dockInput.value = name;
      searchArtist(name, false, true);
    }, dockGacFn);
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

  els.btnClearGraph ?.addEventListener("click", resetToHero);
  els.btnCopyLink   ?.addEventListener("click", copyShareableLink);
  els.btnFitView    ?.addEventListener("click", fitView);

  $("btn-node-search")?.addEventListener("click", openNodeSearch);

  loadArtistFromUrl();
  els.heroInput.focus();
}

window.addEventListener("DOMContentLoaded", init);
