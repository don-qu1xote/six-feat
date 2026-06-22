"use strict";
// ════════════════════════════════════════════════════════════════════════════
// Feature Atlas  ·  script.js  ·  FINAL — полный функционал + оптимизации
//
// Сохранено из v1 (оригинала):
//   • Полный sidebar: аватар, топ-3 трека по популярности, все роли
//   • Полный edge-tooltip: список треков с role-pill'ами
//   • Double-click expand (additive merge)
//   • Ctrl/Cmd+Click → Genius page
//   • Right-click / long-press → pin
//   • BFS path finder + neon highlight
//   • Cmd+K node search overlay
//   • Export PNG + JSON
//   • История поиска (localStorage, 5 записей)
//   • Shareable URL (?artist=...&role_filter=...)
//   • Keyboard shortcuts (Esc, F, +/-, Space, Cmd+K)
//   • Layout switcher (Force / Radial / Hierarchical)
//   • Status bar
//   • Clear graph → Hero reset
//
// Оптимизации из v2 (и новые):
//   [P-1]  Tooltip DOM-элемент строится ОДИН РАЗ и кэшируется в rawNode/_Edge.
//          При update передаём уже готовый элемент, без innerHTML rebuild.
//   [P-2]  DataSet обновляется только изменившимися полями (partial update).
//          hidden/physics вместо add/remove для фильтрации.
//   [P-3]  Physics tuned: damping 0.85, gravity -50, springLength 180,
//          avoidOverlap 0.9, centralGravity 0.03, nodeDistance 200.
//          Заморозка через 2 с после события "stabilized", а не таймер 18 с.
//   [P-4]  Фильтрация ролей — 100 % на бэкенде (role_filter param).
//          При смене тогла: debounced re-fetch того же артиста, merge mode
//          "filter" (позиции сохраняются, physics nudge, не рестарт).
//   [P-5]  BFS мемоизирован: кэш сбрасывается при каждом merge.
//   [P-6]  Обработка кликов: используем vis-native click + doubleClick.
//          Ctrl-check убран из таймера → нет задержки 260 мс на sidebar.
//   [P-7]  hoverWidth: 0 (пропускаем recompute ширины ребра на hover).
//          hideEdgesOnDrag / hideEdgesOnZoom: true (fps при drag).
//   [P-8]  cacheNodeCollaborations() вызывается один раз после merge,
//          не перестраивается при каждом highlight/restore.
// ════════════════════════════════════════════════════════════════════════════

// ── Константы ─────────────────────────────────────────────────────────────

const COLOR = {
  paper:  "#EDEFF4",
  mist:   "#8A94A6",
  line:   "#283044",
  panel:  "#141A28",
  signal: "#5EE6C5",
  pulse:  "#B98AFF",
  amber:  "#FFD27A",
  warn:   "#FF8FA3",
  neon:   "#FF2D78",
  ink:    "#0B0E14"
};

const ROLE_COLOR = {
  featured: COLOR.signal,
  producer: COLOR.pulse,
  writer:   COLOR.amber,
  primary:  COLOR.mist
};

const ROLE_PRIORITY = ["featured", "producer", "writer", "primary"];

const LAYOUTS = { FORCE: "force", RADIAL: "radial", HIERARCH: "hier" };

const MAX_HISTORY     = 5;
const FILTER_DEBOUNCE = 150;  // мс — debounce для смены role-фильтра [P-4]
const FREEZE_DELAY    = 2000; // мс после stabilized → physics off [P-3]
const NODE_MIN_R      = 14;
const NODE_MAX_R      = 48;

// ── Утилиты ───────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function initialOf(name) {
  const m = (name || "").trim().match(/[\p{L}\p{N}]/u);
  return (m ? m[0] : "?").toUpperCase();
}

function lerp(a, b, t) { return a + (b - a) * t; }

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Placeholder SVG-аватар (кэш по букве+seed) ────────────────────────────
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
    `font-size='52' font-weight='700' fill='${accent}'>${escapeHtml(letter)}</text></svg>`;
  const uri = "data:image/svg+xml," + encodeURIComponent(svg);
  _phCache.set(key, uri);
  return uri;
}

// ── Role helpers ──────────────────────────────────────────────────────────

function dominantRoleFromEdge(edge) {
  // Предпочитаем поле от бэкенда, fallback на вычисление из collaborations
  if (edge.dominant_role) return edge.dominant_role;
  if (edge.role_priority)  return edge.role_priority;
  // Вычисляем из массива collaborations (v1-совместимость)
  const roleSet = new Set();
  for (const c of (edge.collaborations || []))
    for (const r of (c.roles || [])) roleSet.add(r.toLowerCase());
  for (const r of ROLE_PRIORITY) if (roleSet.has(r)) return r;
  return "primary";
}

function allRolesFromCollabs(collaborations) {
  const s = new Set();
  for (const c of (collaborations || []))
    for (const r of (c.roles || [])) s.add(r.toLowerCase());
  return [...s];
}

function roleColor(role) { return ROLE_COLOR[role] || COLOR.mist; }

// ── Состояние ─────────────────────────────────────────────────────────────

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

  // Сырые данные для in-memory операций
  // rawNode: { id, name, imageUrl, geniusUrl, genres, isSeed,
  //            totalWeight, computedRadius,
  //            _topTracks, _rolesSet, _totalCollabs,   ← sidebar cache [P-8]
  //            _tooltipEl }                             ← cached DOM el [P-1]
  graphNodes: [],
  // rawEdge: { id, from, to, weight, collaboration_count,
  //            collaborations, dominantRole, _tooltipEl }
  graphEdges: [],

  // Быстрый lookup имён для tooltip'ов рёбер
  nameById: {},

  // Interaction
  focusedNodeId: null,
  pinnedNodes:   new Set(),
  pathHighlight: null,

  // Фильтры (sync'd с кнопками)
  activeFilters: new Set(["featured", "producer", "writer", "primary"]),

  // BFS memo [P-5]: Map<"lo_hi", path|null>, сбрасывается при каждом merge
  _bfsMemo: new Map(),
  // BFS adjacency (только видимые рёбра)
  _bfsAdj:  new Map(),

  // История
  history: []
};

// ── DOM refs ──────────────────────────────────────────────────────────────

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

  filterFeatured: $("filter-featured"),
  filterProducer: $("filter-producer"),
  filterWriter:   $("filter-writer"),

  layoutForce:  $("layout-force"),
  layoutRadial: $("layout-radial"),
  layoutHier:   $("layout-hier"),

  btnExportPng:  $("btn-export-png"),
  btnExportJson: $("btn-export-json"),
  btnClearGraph: $("btn-clear-graph"),
  btnCopyLink:   $("btn-copy-link"),
  btnFindPath:   $("btn-find-path"),
  btnFitView:    $("btn-fit-view"),

  historyList: $("history-list"),

  artistSidebar: $("artist-sidebar"),
  sidebarAvatar: $("sidebar-avatar"),
  sidebarName:   $("sidebar-name"),
  sidebarMeta:   $("sidebar-meta"),
  sidebarTracks: $("sidebar-tracks"),
  sidebarRoles:  $("sidebar-roles"),
  sidebarGenius: $("sidebar-genius-btn"),
  sidebarClose:  $("sidebar-close"),

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
// TOOLTIP BUILDERS  [P-1]
// DOM-элемент строится один раз и хранится в ._tooltipEl.
// vis-network принимает Element напрямую — innerHTML не трогается при update.
// ════════════════════════════════════════════════════════════════════════════

function makeEl(tag, cls, html) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html) el.innerHTML = html;
  return el;
}

function buildNodeTooltipEl(node) {
  const wrap = makeEl("div", "tt");
  // Имя + seed-badge
  const head = makeEl("div", "tt-name",
    escapeHtml(node.name) +
    (node.isSeed ? ' <span class="tt-seed">focus</span>' : "")
  );
  wrap.appendChild(head);
  // Кол-во коллабораций
  if (node.totalWeight) {
    wrap.appendChild(makeEl("div", "tt-meta",
      `${node.totalWeight} collab${node.totalWeight === 1 ? "" : "s"}`
    ));
  }
  // Hint
  wrap.appendChild(makeEl("div", "tt-hint",
    "click → info · dbl-click → expand · RMB → pin · Ctrl+click → Genius"
  ));
  return wrap;
}

// Полный edge-tooltip со списком треков и role-pill'ами (v1-совместимый) [P-1]
function buildEdgeTooltipEl(edge, nameById) {
  const fromName = nameById[edge.from] || "?";
  const toName   = nameById[edge.to]   || "?";
  const collabs  = Array.isArray(edge.collaborations) ? edge.collaborations : [];
  const count    = Number(edge.weight) > 0 ? Number(edge.weight) : collabs.length;

  const wrap = makeEl("div", "tt");

  // Заголовок: имена артистов
  wrap.appendChild(makeEl("div", "tt-head",
    `<span class="tt-name">${escapeHtml(fromName)}</span>` +
    `<span class="tt-x"> × </span>` +
    `<span class="tt-name">${escapeHtml(toName)}</span>`
  ));

  // Счётчик треков
  wrap.appendChild(makeEl("div", "tt-meta",
    `${count} shared track${count === 1 ? "" : "s"}`
  ));

  // Список треков с ролями
  const ul = makeEl("ul", "tt-list");
  if (collabs.length) {
    for (const c of collabs) {
      const roles = Array.isArray(c.roles) ? c.roles : [];
      const pills = roles.map(r => {
        const slug = String(r).toLowerCase().replace(/[^a-z0-9]/g, "");
        return `<span class="tt-role tt-role--${slug}">${escapeHtml(r)}</span>`;
      }).join("");
      const li = makeEl("li", "tt-row",
        `<span class="tt-song">${escapeHtml(c.song || "Untitled")}</span>` +
        `<span class="tt-roles">${pills}</span>`
      );
      ul.appendChild(li);
    }
  } else {
    ul.appendChild(makeEl("li", "tt-empty", "No track details available."));
  }
  wrap.appendChild(ul);
  return wrap;
}

// ════════════════════════════════════════════════════════════════════════════
// NODE SIZING  [P-3 / v1]
// Радиус масштабируется по суммарному collaboration_count через sqrt-lerp.
// ════════════════════════════════════════════════════════════════════════════

function computeNodeSizes() {
  if (!State.graphNodes.length) return;
  const weightMap = new Map();
  for (const e of State.graphEdges) {
    const w = e.collaboration_count != null ? e.collaboration_count : (e.weight || 1);
    weightMap.set(e.from, (weightMap.get(e.from) || 0) + w);
    weightMap.set(e.to,   (weightMap.get(e.to)   || 0) + w);
  }
  const maxW = Math.max(...weightMap.values(), 1);
  for (const n of State.graphNodes) {
    const w = weightMap.get(n.id) || 1;
    n.totalWeight    = w;
    n.computedRadius = n.isSeed
      ? NODE_MAX_R
      : Math.round(lerp(NODE_MIN_R, NODE_MAX_R * 0.78, Math.sqrt(w) / Math.sqrt(maxW)));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SIDEBAR CACHE  [P-8]
// Строим _topTracks / _rolesSet / _totalCollabs один раз после merge.
// ════════════════════════════════════════════════════════════════════════════

function cacheNodeCollaborations() {
  for (const n of State.graphNodes) {
    const edgesForNode = State.graphEdges.filter(e => e.from === n.id || e.to === n.id);
    const allCollabs   = edgesForNode.flatMap(e => e.collaborations || []);
    const scored = allCollabs.map(c => ({
      ...c, _popularity: Number(c.popularity || c.views || 0)
    })).sort((a, b) => b._popularity - a._popularity);

    n._topTracks    = scored.slice(0, 3);
    n._rolesSet     = new Set(edgesForNode.flatMap(e => allRolesFromCollabs(e.collaborations)));
    n._totalCollabs = edgesForNode.reduce((s, e) => s + (e.collaboration_count || e.weight || 1), 0);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// NODE / EDGE VISUAL BUILDERS
// ════════════════════════════════════════════════════════════════════════════

function nodeVisual(n) {
  const radius    = n.computedRadius || (n.isSeed ? NODE_MAX_R : 20);
  const accent    = n.isSeed ? COLOR.signal : COLOR.pulse;
  const dimBorder = n.isSeed ? "rgba(94,230,197,0.30)" : "rgba(185,138,255,0.25)";
  const isPinned  = State.pinnedNodes.has(n.id);
  const image     = n.imageUrl || placeholderFor(n.name, n.isSeed);

  // [P-1] Пересоздаём tooltip только если ещё нет или изменился вес/seed-статус
  if (!n._tooltipEl || n._tooltipElWeight !== n.totalWeight || n._tooltipElSeed !== n.isSeed) {
    n._tooltipEl        = buildNodeTooltipEl(n);
    n._tooltipElWeight  = n.totalWeight;
    n._tooltipElSeed    = n.isSeed;
  }

  return {
    id: n.id,
    // Поля для restoreDefaultColors
    _accent:    accent,
    _dimBorder: dimBorder,
    isSeed:     n.isSeed,
    imageUrl:   n.imageUrl || "",
    label:      isPinned ? "📌" : "",
    shape:      "circularImage",
    image,
    brokenImage: placeholderFor(n.name, n.isSeed),
    size:        radius,
    borderWidth: n.isSeed ? 5 : 2,
    borderWidthSelected: n.isSeed ? 7 : 3,
    color: {
      border:    dimBorder,
      background: COLOR.panel,
      highlight: { border: COLOR.paper, background: COLOR.panel },
      hover:     { border: accent,      background: COLOR.panel }
    },
    font: {
      color:   isPinned ? accent : "#00000000",
      size:    isPinned ? 11 : 0,
      vadjust: radius + 6,
      align:   "center"
    },
    title:  n._tooltipEl,        // [P-1] кэшированный DOM-элемент
    shadow: n.isSeed
      ? { enabled: true, color: "rgba(94,230,197,0.40)", size: 22, x: 0, y: 0 }
      : { enabled: false },
    fixed:  isPinned ? { x: true, y: true } : false,
    hidden: false,
    physics: !isPinned
  };
}

function edgeVisual(e) {
  const weight  = Number(e.weight) > 0 ? Number(e.weight) : 1;
  const color   = roleColor(e.dominantRole);

  // [P-1] Edge tooltip — полный список треков с роль-пилюлями, строим один раз
  if (!e._tooltipEl) {
    e._tooltipEl = buildEdgeTooltipEl(e, State.nameById);
  }

  return {
    id:    e.id,
    from:  e.from,
    to:    e.to,
    width: Math.min(1 + Math.sqrt(weight) * 1.8, 9),
    title: e._tooltipEl,          // [P-1]
    color: { color, opacity: 0.35, inherit: false },
    _role:  e.dominantRole,
    _color: color,
    hidden: false,
    physics: true,
    smooth: { enabled: true, type: "continuous", roundness: 0.5 },
    hoverWidth:     0,            // [P-7] no width recompute on hover
    selectionWidth: 1
  };
}

// ════════════════════════════════════════════════════════════════════════════
// NETWORK OPTIONS  [P-3]
// ════════════════════════════════════════════════════════════════════════════

function networkOptions(layout) {
  const base = {
    autoResize: true,
    layout:  { improvedLayout: false },
    nodes:   { shapeProperties: { interpolation: true, useBorderWithImage: true } },
    edges: {
      color:          { inherit: false },
      hoverWidth:     0,    // [P-7]
      selectionWidth: 1,
      smooth:         { enabled: true, type: "continuous", roundness: 0.5 }
    },
    interaction: {
      hover:               true,
      dragNodes:           true,
      dragView:            true,
      zoomView:            true,
      tooltipDelay:        60,
      hoverConnectedEdges: false,
      hideEdgesOnDrag:     true,   // [P-7] fps при drag
      hideEdgesOnZoom:     true,   // [P-7] fps при zoom
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
          centralGravity: 0.03,  // [P-3]
          springLength:   200,
          springConstant: 0.04,
          nodeDistance:   200,   // [P-3]
          damping:        0.85   // [P-3]
        },
        stabilization: { enabled: true, iterations: 150, fit: true }
      }
    };
  }

  // Default: forceAtlas2Based [P-3]
  return {
    ...base,
    physics: {
      enabled: true,
      solver:  "forceAtlas2Based",
      forceAtlas2Based: {
        gravitationalConstant: -50,   // [P-3]
        centralGravity:        0.03,  // [P-3]
        springLength:          180,   // [P-3]
        springConstant:        0.08,
        damping:               0.85,  // [P-3]
        avoidOverlap:          0.9    // [P-3]
      },
      stabilization: { enabled: true, iterations: 200, fit: true },
      minVelocity: 0.7,
      timestep:    0.4
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PHYSICS CONTROL  [P-3]
// ════════════════════════════════════════════════════════════════════════════

function scheduleFreeze(ms = FREEZE_DELAY) {
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

// nudge: мягкое пробуждение без полной стабилизации (для filter/expand)
function nudgePhysics(freezeAfterMs = 1500) {
  if (!State.network) return;
  State.network.setOptions({ physics: { enabled: true, stabilization: false } });
  State.physicsActive = true;
  syncPhysicsButton();
  scheduleFreeze(freezeAfterMs);
}

function unfreezePhysics() {
  if (!State.network) return;
  State.network.setOptions({ physics: { enabled: true, stabilization: false } });
  State.physicsActive = true;
  syncPhysicsButton();
  scheduleFreeze(FREEZE_DELAY);
}

function togglePhysics() {
  if (State.physicsActive) freezePhysics();
  else unfreezePhysics();
}

function syncPhysicsButton() {
  const btn = $("btn-physics");
  if (!btn) return;
  btn.textContent = State.physicsActive ? "⏸" : "▶";
  btn.title = State.physicsActive ? "Space — freeze" : "Space — unfreeze";
  btn.classList.toggle("active", !State.physicsActive);
}

// ════════════════════════════════════════════════════════════════════════════
// FETCH & GRAPH BUILD  [P-4]
// ════════════════════════════════════════════════════════════════════════════

// [P-4] Debounced повторный запрос при смене role-фильтра
const _filterFetch = debounce(() => {
  if (!els.dockInput.value.trim()) return;
  _doFetch(els.dockInput.value.trim(), "filter");
}, FILTER_DEBOUNCE);

function searchArtist(name, isExpansion = false) {
  const artist = (name || "").trim();
  if (!artist || State.inFlight) return;
  _doFetch(artist, isExpansion ? "expand" : "new");
}

async function _doFetch(artist, mode) {
  if (State.inFlight) return;

  // "new" — уничтожаем старый граф
  if (mode === "new" && State.network) destroyNetwork();

  State.inFlight = true;
  showLoading(true);
  hideToast();

  // [P-4] role_filter всегда идёт на бэкенд
  const roles  = [...State.activeFilters].sort().join(",");
  const url    = `/api/v1/graph?artist=${encodeURIComponent(artist)}&role_filter=${encodeURIComponent(roles)}`;

  let followUpId = null;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      let msg = `Request failed (HTTP ${res.status}).`;
      if (res.status === 502) msg = "Genius недоступен. Проверьте API-токен.";
      if (res.status === 400) msg = "Введите имя артиста.";
      throw new Error(msg);
    }

    const graph = await res.json();

    // Disambig: бэкенд вернул кандидатов
    if (graph.ambiguous) {
      const best = graph.candidates?.[0];
      if (!best) { showToast("Ничего не найдено — уточните запрос."); return; }
      showToast(`Показываем результаты для "${best.name}"`, 3000, true);
      followUpId = best.id;
      return;
    }

    if (!graph.nodes?.length) {
      showToast(`Коллаборации не найдены для "${artist}".`);
      return;
    }

    applyGraph(graph, mode);
    pushHistory(graph.seed || artist);
    updateShareableUrl(graph.seed || artist);

  } catch (err) {
    showToast(err.message || "Что-то пошло не так. Попробуйте ещё раз.");
  } finally {
    State.inFlight = false;
    showLoading(false);
  }

  // Разрешаем disambig вне try/finally, чтобы не мешать inFlight
  if (followUpId != null) {
    const rolesFb = [...State.activeFilters].sort().join(",");
    const urlFb   = `/api/v1/graph?id=${encodeURIComponent(followUpId)}&role_filter=${encodeURIComponent(rolesFb)}`;
    State.inFlight = true; showLoading(true);
    try {
      const res2  = await fetch(urlFb);
      const graph2 = await res2.json();
      if (graph2.nodes?.length) {
        applyGraph(graph2, "new");
        pushHistory(graph2.seed || artist);
        updateShareableUrl(graph2.seed || artist);
      }
    } catch(e) { showToast(e.message); }
    finally { State.inFlight = false; showLoading(false); }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// APPLY GRAPH  (merge в три режима)
//
//  "new"    — чистый старт: все данные заменяются, полная стабилизация
//  "expand" — additive: новые узлы/рёбра добавляются, старые остаются
//  "filter" — [P-4] ре-фетч того же артиста: видимость меняется через
//             hidden/physics, позиции не сбрасываются, nudge вместо restart
// ════════════════════════════════════════════════════════════════════════════

function applyGraph(graph, mode) {
  const seedId   = graph.seed_id != null ? graph.seed_id : graph.nodes[0]?.id;
  const isReplace = (mode === "new" || mode === "filter");

  // ── Строим/обновляем nameById ──────────────────────────────────────────
  graph.nodes.forEach(n => {
    State.nameById[n.id] = n.label || n.name || "";
  });

  // ── Наборы входящих id ─────────────────────────────────────────────────
  const incomingNodeIds = new Set(graph.nodes.map(n => n.id));
  const incomingEdgeIds = new Set();
  graph.edges.forEach(e => {
    incomingEdgeIds.add(`${Math.min(e.from,e.to)}_${Math.max(e.from,e.to)}`);
  });

  const existingNodeIds  = new Set(State.graphNodes.map(n => n.id));
  const existingEdgeIds  = new Set(State.graphEdges.map(e => e.id));

  // ── Merge raw nodes ───────────────────────────────────────────────────
  for (const n of graph.nodes) {
    const isSeed = (n.id === seedId);
    if (existingNodeIds.has(n.id)) {
      const ex = State.graphNodes.find(x => x.id === n.id);
      if (ex) {
        ex.isSeed    = isSeed;
        ex.imageUrl  = ex.imageUrl  || n.image      || "";
        ex.geniusUrl = ex.geniusUrl || n.genius_url || n.url || "";
        // Сбрасываем кэш tooltip при смене seed-статуса
        if (ex._tooltipElSeed !== isSeed) ex._tooltipEl = null;
      }
    } else {
      State.graphNodes.push({
        id:        n.id,
        name:      n.label || n.name || "",
        imageUrl:  n.image      || "",
        geniusUrl: n.genius_url || n.url || "",
        genres:    Array.isArray(n.genres) ? n.genres : [],
        isSeed,
        totalWeight: 0, computedRadius: NODE_MIN_R,
        _tooltipEl: null
      });
    }
  }

  // ── Merge raw edges ───────────────────────────────────────────────────
  for (const e of graph.edges) {
    const lo  = Math.min(e.from, e.to);
    const hi  = Math.max(e.from, e.to);
    const key = `${lo}_${hi}`;
    if (!existingEdgeIds.has(key)) {
      State.graphEdges.push({
        id:                  key,
        from:                e.from,
        to:                  e.to,
        weight:              e.weight || 1,
        collaboration_count: e.collaboration_count || e.weight || 1,
        collaborations:      e.collaborations || [],
        dominantRole:        dominantRoleFromEdge(e),
        _tooltipEl:          null   // построится при первом edgeVisual
      });
    }
  }

  // Помечаем seed
  State.graphNodes.forEach(n => { n.isSeed = (n.id === seedId); });

  // Пересчитываем размеры
  computeNodeSizes();

  // [P-8] Кэшируем данные для sidebar
  cacheNodeCollaborations();

  // [P-5] Сбрасываем BFS-кэш при любом изменении структуры
  State._bfsMemo.clear();

  // ── Первый рендер ──────────────────────────────────────────────────────
  if (!State.hasRendered) {
    showGraphView();
    State.hasRendered = true;
  }

  const firstInit = (State.network === null);
  if (firstInit) {
    _initNetwork(seedId);
  } else {
    _updateNetwork(seedId, mode, incomingNodeIds, incomingEdgeIds);
  }

  State.currentSeedId = seedId;
  updateStatus(graph);
  els.dockInput.value = graph.seed || "";
  renderHistoryList();
}

// ── Первичная инициализация vis Network ──────────────────────────────────

function _initNetwork(seedId) {
  const nodeItems = State.graphNodes.map(n => nodeVisual(n));
  const edgeItems = State.graphEdges.map(e => edgeVisual(e));

  State.nodesDS = new vis.DataSet(nodeItems);
  State.edgesDS = new vis.DataSet(edgeItems);
  State.network = new vis.Network(
    els.network,
    { nodes: State.nodesDS, edges: State.edgesDS },
    networkOptions(State.currentLayout)
  );

  // [P-3] Заморозка через 2 с после события stabilized, а не фиксированный таймер
  State.network.on("stabilized", () => scheduleFreeze(FREEZE_DELAY));
  State.physicsActive = true;
  syncPhysicsButton();

  attachNetworkEvents();
}

// ── Обновление существующего Network [P-2] ────────────────────────────────

function _updateNetwork(seedId, mode, incomingNodeIds, incomingEdgeIds) {
  const isReplace = (mode === "new" || mode === "filter");

  // Добавляем новые узлы и рёбра
  const newNodeItems = State.graphNodes
    .filter(n => !State.nodesDS.get(n.id))
    .map(n => nodeVisual(n));
  const newEdgeItems = State.graphEdges
    .filter(e => !State.edgesDS.get(e.id))
    .map(e => edgeVisual(e));
  if (newNodeItems.length) State.nodesDS.add(newNodeItems);
  if (newEdgeItems.length) State.edgesDS.add(newEdgeItems);

  // [P-2] Partial update: размер + seed-визуал + tooltip
  const sizeUpdates = State.graphNodes.map(n => {
    const isPinned = State.pinnedNodes.has(n.id);
    const radius   = n.computedRadius;
    const accent   = n.isSeed ? COLOR.signal : COLOR.pulse;
    const dimBorder = n.isSeed ? "rgba(94,230,197,0.30)" : "rgba(185,138,255,0.25)";
    // [P-2] Только поля, которые могут измениться
    return {
      id:      n.id,
      size:    radius,
      title:   n._tooltipEl || buildNodeTooltipEl(n),
      borderWidth: n.isSeed ? 5 : 2,
      borderWidthSelected: n.isSeed ? 7 : 3,
      shadow:  n.isSeed
        ? { enabled: true, color: "rgba(94,230,197,0.40)", size: 22, x: 0, y: 0 }
        : { enabled: false },
      color: {
        border:    dimBorder,
        background: COLOR.panel,
        highlight: { border: COLOR.paper, background: COLOR.panel },
        hover:     { border: accent,      background: COLOR.panel }
      },
      font: {
        color:   isPinned ? accent : "#00000000",
        size:    isPinned ? 11 : 0,
        vadjust: radius + 6,
        align:   "center"
      },
      _accent: accent, _dimBorder: dimBorder
    };
  });
  State.nodesDS.update(sizeUpdates);

  // [P-2] Для режима filter/new: скрываем узлы и рёбра вне incoming-set
  if (isReplace) {
    const nodeVisUpdates = [];
    State.nodesDS.forEach(nd => {
      const rn      = State.graphNodes.find(n => n.id === nd.id);
      const visible = rn?.isSeed || incomingNodeIds.has(nd.id);
      nodeVisUpdates.push({ id: nd.id, hidden: !visible, physics: visible && !State.pinnedNodes.has(nd.id) });
    });
    State.nodesDS.update(nodeVisUpdates);

    const edgeVisUpdates = [];
    State.edgesDS.forEach(ed => {
      const visible = incomingEdgeIds.has(ed.id);
      const re      = State.graphEdges.find(e => e.id === ed.id);
      edgeVisUpdates.push({
        id:     ed.id,
        hidden: !visible,
        physics: visible,
        color:  visible
          ? { color: roleColor(re?.dominantRole || "primary"), opacity: 0.35, inherit: false }
          : { color: "rgba(0,0,0,0)", opacity: 0, inherit: false }
      });
    });
    State.edgesDS.update(edgeVisUpdates);
  }

  // [P-3] Physics: для filter — nudge, для expand — nudge, для new не попадём сюда
  nudgePhysics(mode === "filter" ? 1200 : 2000);

  // Rebuild BFS adjacency
  rebuildBfsAdj();
}

// ════════════════════════════════════════════════════════════════════════════
// NETWORK EVENTS  [P-6]
// ════════════════════════════════════════════════════════════════════════════

function attachNetworkEvents() {
  const net = State.network;

  // [P-6] Нативные click + doubleClick без кастомного таймера
  // click → sidebar + focus (нет fetch)
  // doubleClick → expand (fetch)
  // Ctrl+Click → Genius

  net.on("click", function(params) {
    if (!params.nodes?.length) { clearFocus(); return; }
    const nodeId  = params.nodes[0];
    const ctrlKey = params.event?.ctrlKey || params.event?.metaKey
                 || params.event?.srcEvent?.ctrlKey
                 || params.event?.srcEvent?.metaKey;

    if (ctrlKey) { openGeniusPage(nodeId); return; }

    // Одинарный клик: sidebar + highlight (без fetch, без задержки)
    setFocus(nodeId);
    showArtistSidebar(nodeId);
  });

  // [P-6] Двойной клик → expand
  net.on("doubleClick", function(params) {
    if (!params.nodes?.length) return;
    const nodeId = params.nodes[0];
    const gn     = State.graphNodes.find(n => n.id === nodeId);
    if (gn) searchArtist(gn.name, true);
  });

  // ПКМ → pin
  net.on("oncontext", function(params) {
    params.event.preventDefault();
    const nodeId = params.nodes?.length
      ? params.nodes[0]
      : State.network.getNodeAt(params.pointer.DOM);
    if (nodeId == null) return;
    togglePin(nodeId);
  });

  // Long-press (mobile) → pin
  net.on("hold", function(params) {
    const nodeId = params.nodes?.[0] ?? State.network.getNodeAt(params.pointer?.DOM);
    if (nodeId == null) return;
    togglePin(nodeId);
  });

  // Hover highlight
  net.on("hoverNode", function(params) {
    els.network.style.cursor = "pointer";
    if (!State.focusedNodeId) highlightNeighborhood(params.node);
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

  // [P-3] Заморозка через FREEZE_DELAY после stabilized
  net.on("stabilized", () => scheduleFreeze(FREEZE_DELAY));
}

// ════════════════════════════════════════════════════════════════════════════
// SIDEBAR  (полный v1 функционал)
// ════════════════════════════════════════════════════════════════════════════

function showArtistSidebar(nodeId) {
  const node = State.graphNodes.find(n => n.id === nodeId);
  if (!node) return;

  els.pathPanel?.classList.remove("show");

  els.sidebarAvatar.src = node.imageUrl || placeholderFor(node.name, node.isSeed);
  els.sidebarAvatar.alt = node.name;
  els.sidebarName.textContent = node.name;

  const collab = node._totalCollabs || node.totalWeight || 0;
  const genres = (node.genres || []).slice(0, 3).join(", ");
  els.sidebarMeta.textContent =
    `${collab} collab${collab === 1 ? "" : "s"}` + (genres ? ` · ${genres}` : "");

  // Топ-3 трека
  const tracks = node._topTracks || [];
  if (tracks.length) {
    els.sidebarTracks.innerHTML = tracks.map(t => {
      const roles   = t.roles || [];
      const mainRole = (roles[0] || "primary").toLowerCase().replace(/[^a-z0-9]/g, "");
      return `<div class="sidebar-track">` +
        `<span class="sidebar-track-name">${escapeHtml(t.song || "Untitled")}</span>` +
        `<span class="sidebar-track-role role-chip--${mainRole}">${escapeHtml(roles[0] || "primary")}</span>` +
        `</div>`;
    }).join("");
  } else {
    els.sidebarTracks.innerHTML =
      `<div style="color:var(--mist);font-size:12px;">No track data cached.</div>`;
  }

  // Все роли
  const roles = [...(node._rolesSet || [])];
  els.sidebarRoles.innerHTML = roles.length
    ? roles.map(r =>
        `<span class="sidebar-role-chip role-chip--${r.replace(/[^a-z0-9]/g,"")}">${escapeHtml(r)}</span>`
      ).join("")
    : `<span style="color:var(--mist);font-size:11px;">—</span>`;

  els.sidebarGenius.onclick = () => openGeniusPage(nodeId);
  els.artistSidebar?.classList.add("show");
}

function hideArtistSidebar() {
  els.artistSidebar?.classList.remove("show");
}

// ════════════════════════════════════════════════════════════════════════════
// FOCUS & HIGHLIGHT  [P-2]
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
  const connectedNodes = new Set(State.network.getConnectedNodes(nodeId));
  const connectedEdges = new Set(State.network.getConnectedEdges(nodeId));

  const nUp = [], eUp = [];

  State.nodesDS.forEach(nd => {
    if (nd.hidden) return;
    const isTarget = nd.id === nodeId || connectedNodes.has(nd.id);
    nUp.push({
      id:      nd.id,
      color:   {
        border:     isTarget ? (nd._accent || COLOR.pulse) : "rgba(40,48,68,0.10)",
        background: isTarget ? COLOR.panel : "rgba(20,26,40,0.12)"
      },
      opacity: isTarget ? 1 : 0.1
    });
  });

  State.edgesDS.forEach(ed => {
    if (ed.hidden) return;
    const isTarget = connectedEdges.has(ed.id);
    eUp.push({
      id:    ed.id,
      color: {
        color:   isTarget ? (ed._color || COLOR.pulse) : "rgba(40,48,68,0.02)",
        opacity: isTarget ? 0.95 : 0.02
      }
    });
  });

  State.nodesDS.update(nUp);
  State.edgesDS.update(eUp);
}

function highlightEdge(edgeId) {
  if (!State.edgesDS) return;
  const eUp = [];
  State.edgesDS.forEach(ed => {
    if (ed.hidden) return;
    eUp.push({
      id:    ed.id,
      color: {
        color:   ed.id === edgeId ? (ed._color || COLOR.pulse) : "rgba(40,48,68,0.03)",
        opacity: ed.id === edgeId ? 1.0 : 0.03
      }
    });
  });
  State.edgesDS.update(eUp);
}

function restoreDefaultColors() {
  if (!State.nodesDS || !State.edgesDS) return;
  const nUp = [], eUp = [];

  State.nodesDS.forEach(nd => {
    if (nd.hidden) return;
    nUp.push({
      id:      nd.id,
      color:   { border: nd._dimBorder || "rgba(185,138,255,0.25)", background: COLOR.panel },
      opacity: 1
    });
  });

  State.graphEdges.forEach(e => {
    if (!State.edgesDS.get(e.id) || State.edgesDS.get(e.id).hidden) return;
    eUp.push({
      id:    e.id,
      width: Math.min(1 + Math.sqrt(e.weight || 1) * 1.8, 9), // сброс ширины BFS
      color: { color: roleColor(e.dominantRole), opacity: 0.35, inherit: false }
    });
  });

  State.nodesDS.update(nUp);
  State.edgesDS.update(eUp);
}

// ════════════════════════════════════════════════════════════════════════════
// PIN
// ════════════════════════════════════════════════════════════════════════════

function togglePin(nodeId) {
  const isPinned = State.pinnedNodes.has(nodeId);
  if (isPinned) {
    State.pinnedNodes.delete(nodeId);
    // [P-2] Только нужные поля
    State.nodesDS.update([{ id: nodeId, fixed: false, physics: true, label: "", font: { color: "#00000000", size: 0 } }]);
  } else {
    const pos = State.network?.getPositions([nodeId])?.[nodeId];
    State.pinnedNodes.add(nodeId);
    const rn = State.graphNodes.find(n => n.id === nodeId);
    State.nodesDS.update([{
      id:     nodeId,
      fixed:  pos ? { x: true, y: true } : true,
      physics: false,
      x:      pos?.x, y: pos?.y,
      label:  "📌",
      font:   { color: COLOR.signal, size: 11, vadjust: (rn?.computedRadius || 20) + 6, align: "center" }
    }]);
    if (pos) State.network.moveNode(nodeId, pos.x, pos.y);
  }
  showToast(!isPinned ? "📌 Закреплён — ПКМ для открепления" : "Откреплён", 2000);
}

// ════════════════════════════════════════════════════════════════════════════
// GENIUS PAGE
// ════════════════════════════════════════════════════════════════════════════

function openGeniusPage(nodeId) {
  const node = State.graphNodes.find(n => n.id === nodeId);
  if (!node) return;
  const url = node.geniusUrl ||
    `https://genius.com/artists/${encodeURIComponent(node.name.replace(/\s+/g,"-").toLowerCase())}`;
  window.open(url, "_blank", "noopener");
}

// ════════════════════════════════════════════════════════════════════════════
// ROLE FILTER TOGGLES  [P-4]
// Смена тогла → debounced re-fetch (бэкенд возвращает отфильтрованный граф)
// ════════════════════════════════════════════════════════════════════════════

function setupFilterToggles() {
  function makeToggle(role, btn) {
    if (!btn) return;
    btn.classList.add("active");
    btn.addEventListener("click", () => {
      if (State.activeFilters.has(role)) {
        State.activeFilters.delete(role);
        btn.classList.remove("active");
      } else {
        State.activeFilters.add(role);
        btn.classList.add("active");
      }
      // [P-4] Re-fetch у бэкенда, не клиентская фильтрация
      _filterFetch();
    });
  }
  makeToggle("featured", els.filterFeatured);
  makeToggle("producer", els.filterProducer);
  makeToggle("writer",   els.filterWriter);
}

// ════════════════════════════════════════════════════════════════════════════
// LAYOUT SWITCHER  [P-3]
// ════════════════════════════════════════════════════════════════════════════

function switchLayout(layout) {
  State.currentLayout = layout;
  if (!State.network) return;

  State.network.setOptions({ physics: { enabled: false } });
  State.network.setOptions(networkOptions(layout));

  if (layout !== LAYOUTS.HIERARCH) {
    setTimeout(() => {
      nudgePhysics(2000);
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
// BFS PATH FINDER  [P-5] — мемоизированный
// ════════════════════════════════════════════════════════════════════════════

function rebuildBfsAdj() {
  State._bfsAdj.clear();
  State._bfsMemo.clear();
  for (const e of State.graphEdges) {
    // Учитываем только видимые рёбра (не hidden)
    const visItem = State.edgesDS?.get(e.id);
    if (visItem?.hidden) continue;
    if (!State._bfsAdj.has(e.from)) State._bfsAdj.set(e.from, []);
    if (!State._bfsAdj.has(e.to))   State._bfsAdj.set(e.to,   []);
    State._bfsAdj.get(e.from).push(e.to);
    State._bfsAdj.get(e.to).push(e.from);
  }
}

function bfsPath(fromId, toId) {
  const key = `${Math.min(fromId,toId)}_${Math.max(fromId,toId)}`;
  if (State._bfsMemo.has(key)) return State._bfsMemo.get(key);

  const adj = State._bfsAdj;
  if (!adj.has(fromId) || !adj.has(toId)) { State._bfsMemo.set(key, null); return null; }

  const visited = new Set([fromId]);
  const queue   = [[fromId, [fromId]]];
  let result    = null;

  outer: while (queue.length) {
    const [curr, path] = queue.shift();
    for (const nbr of (adj.get(curr) || [])) {
      if (nbr === toId) { result = [...path, toId]; break outer; }
      if (!visited.has(nbr)) { visited.add(nbr); queue.push([nbr, [...path, nbr]]); }
    }
  }

  State._bfsMemo.set(key, result);
  // Кэшируем обратный путь бесплатно
  const revKey = `${Math.min(toId,fromId)}_${Math.max(toId,fromId)}`;
  if (revKey !== key) State._bfsMemo.set(revKey, result ? [...result].reverse() : null);
  return result;
}

function highlightPath(path) {
  if (!State.nodesDS || !State.edgesDS || !path) return;
  const pathSet   = new Set(path);
  const pathEdges = new Set();
  for (let i = 0; i < path.length - 1; i++) {
    pathEdges.add(`${Math.min(path[i],path[i+1])}_${Math.max(path[i],path[i+1])}`);
  }

  const nUp = [], eUp = [];

  State.nodesDS.forEach(nd => {
    if (nd.hidden) return;
    nUp.push({
      id:      nd.id,
      color:   { border: pathSet.has(nd.id) ? COLOR.neon : "rgba(40,48,68,0.08)", background: COLOR.panel },
      opacity: pathSet.has(nd.id) ? 1 : 0.12
    });
  });
  State.edgesDS.forEach(ed => {
    if (ed.hidden) return;
    const inPath = pathEdges.has(ed.id);
    eUp.push({
      id:    ed.id,
      width: inPath ? 5 : undefined,
      color: { color: inPath ? COLOR.neon : "rgba(40,48,68,0.02)", opacity: inPath ? 1 : 0.02, inherit: false }
    });
  });
  State.nodesDS.update(nUp);
  State.edgesDS.update(eUp);
}

function clearPathHighlight() {
  State.pathHighlight = null;
  restoreDefaultColors();
  if (els.pathResult) els.pathResult.textContent = "";
}

function setupPathPanel() {
  els.btnFindPath?.addEventListener("click", () => {
    hideArtistSidebar();
    els.pathPanel?.classList.toggle("show");
  });

  els.btnRunPath?.addEventListener("click", () => {
    const fromName = (els.pathFromInput?.value || "").trim();
    const toName   = (els.pathToInput?.value   || "").trim();
    if (!fromName || !toName) { showToast("Введите имена обоих артистов."); return; }

    const fromNode = State.graphNodes.find(n => n.name.toLowerCase() === fromName.toLowerCase());
    const toNode   = State.graphNodes.find(n => n.name.toLowerCase() === toName.toLowerCase());

    if (!fromNode) { showToast(`"${fromName}" не загружен в граф.`); return; }
    if (!toNode)   { showToast(`"${toName}" не загружен в граф.`);   return; }

    // Перестраиваем adj при первом запросе (если ещё нет)
    if (!State._bfsAdj.size) rebuildBfsAdj();

    const path = bfsPath(fromNode.id, toNode.id);  // [P-5]
    if (!path) {
      if (els.pathResult) els.pathResult.textContent = "Путь не найден — артисты могут не быть связаны.";
      restoreDefaultColors();
      return;
    }

    State.pathHighlight = { from: fromNode.id, to: toNode.id, path };
    highlightPath(path);

    const names = path.map(id => State.graphNodes.find(n => n.id === id)?.name || String(id));
    const hops  = path.length - 1;
    if (els.pathResult)
      els.pathResult.textContent = `${hops} шаг${hops===1?"":"а"}: ${names.join(" → ")}`;
  });

  els.btnClearPath?.addEventListener("click", clearPathHighlight);
}

// ════════════════════════════════════════════════════════════════════════════
// NODE SEARCH  (Cmd+K)
// ════════════════════════════════════════════════════════════════════════════

function openNodeSearch() {
  if (!State.hasRendered) return;
  els.nodeSearchOverlay?.classList.add("show");
  if (els.nodeSearchInput) { els.nodeSearchInput.value = ""; els.nodeSearchInput.focus(); }
  renderNodeSearchResults("");
}
function closeNodeSearch() { els.nodeSearchOverlay?.classList.remove("show"); }

function renderNodeSearchResults(query) {
  if (!els.nodeSearchResults) return;
  const q = query.toLowerCase().trim();
  const results = State.graphNodes
    .filter(n => !q || n.name.toLowerCase().includes(q))
    .slice(0, 12);

  els.nodeSearchResults.innerHTML = results.map(n =>
    `<div class="ns-item" data-id="${n.id}">` +
    `<span class="ns-name">${escapeHtml(n.name)}</span>` +
    `<span class="ns-weight">${n.totalWeight} collab${n.totalWeight===1?"":"s"}</span>` +
    `</div>`
  ).join("") || `<div class="ns-empty">Нет совпадений</div>`;

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
  els.nodeSearchInput?.addEventListener("input",
    debounce(e => renderNodeSearchResults(e.target.value), 120)
  );
  els.nodeSearchInput?.addEventListener("keydown", e => { if (e.key === "Escape") closeNodeSearch(); });
  els.nodeSearchOverlay?.addEventListener("click", e => {
    if (e.target === els.nodeSearchOverlay) closeNodeSearch();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// HISTORY (localStorage)
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
  renderHistoryList();
}

function renderHistoryList() {
  if (!els.historyList) return;
  if (!State.history.length) {
    els.historyList.innerHTML = `<span class="hist-empty">Нет недавних поисков</span>`;
    return;
  }
  els.historyList.innerHTML =
    State.history.map(name =>
      `<div class="hist-item">` +
      `<span class="hist-name" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</span>` +
      `<button class="hist-btn" data-artist="${escapeHtml(name)}">↻</button>` +
      `</div>`
    ).join("") +
    `<button class="dock-btn hist-clear-btn" id="btn-hist-clear">Очистить</button>`;

  els.historyList.querySelectorAll("[data-artist]").forEach(el => {
    el.addEventListener("click", () => searchArtist(el.getAttribute("data-artist"), false));
  });
  $("btn-hist-clear")?.addEventListener("click", () => {
    State.history = []; saveHistory(); renderHistoryList();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// SHAREABLE URL
// ════════════════════════════════════════════════════════════════════════════

function updateShareableUrl(artistName) {
  if (!artistName) return;
  const url = new URL(window.location.href);
  url.searchParams.set("artist", artistName);
  const roles = [...State.activeFilters].filter(r => r !== "primary").sort().join(",");
  if (roles) url.searchParams.set("role_filter", roles);
  else url.searchParams.delete("role_filter");
  history.replaceState(null, "", url.toString());
}

function loadArtistFromUrl() {
  const params     = new URLSearchParams(window.location.search);
  const artist     = params.get("artist");
  const roleFilter = params.get("role_filter") || params.get("roles"); // backward compat

  if (roleFilter) {
    const incoming = new Set(roleFilter.split(",").map(r => r.trim()).filter(Boolean));
    // Восстанавливаем: primary всегда включён
    State.activeFilters = new Set(["primary", ...incoming]);
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
  navigator.clipboard.writeText(window.location.href)
    .then(() => showToast("🔗 Ссылка скопирована!", 2000, true))
    .catch(() => showToast(`Скопируйте вручную: ${window.location.href}`, 6000));
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════════════════════

function exportPng() {
  if (!State.network) { showToast("Сначала постройте граф."); return; }
  try {
    const canvas = els.network.querySelector("canvas");
    if (!canvas) { showToast("Canvas не найден."); return; }
    const out = document.createElement("canvas");
    out.width  = canvas.width;
    out.height = canvas.height;
    const ctx  = out.getContext("2d");
    ctx.fillStyle = COLOR.ink;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0);
    const link    = document.createElement("a");
    link.download = "feature-atlas.png";
    link.href     = out.toDataURL("image/png");
    link.click();
  } catch(e) { showToast("Ошибка экспорта: " + e.message); }
}

function exportJson() {
  if (!State.graphNodes.length) { showToast("Сначала постройте граф."); return; }
  const data = {
    exported:   new Date().toISOString(),
    seedArtist: els.dockInput.value,
    nodes: State.graphNodes.map(n => ({ id: n.id, name: n.name, imageUrl: n.imageUrl, genres: n.genres })),
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

// ════════════════════════════════════════════════════════════════════════════
// VIEW HELPERS
// ════════════════════════════════════════════════════════════════════════════

function fitView() {
  State.network?.fit({ animation: { duration: 500, easingFunction: "easeInOutQuad" } });
}

function focusSeed() {
  if (State.network && State.currentSeedId != null) {
    State.network.focus(State.currentSeedId, { scale: 1.2, animation: { duration: 500, easingFunction: "easeInOutQuad" } });
    clearFocus();
  }
}

function zoomIn()  { State.network?.moveTo({ scale: (State.network.getScale() || 1) * 1.25, animation: { duration: 220, easingFunction: "easeInOutQuad" } }); }
function zoomOut() { State.network?.moveTo({ scale: (State.network.getScale() || 1) * 0.8,  animation: { duration: 220, easingFunction: "easeInOutQuad" } }); }

// ════════════════════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════════════════════════════

function setupKeyboard() {
  document.addEventListener("keydown", e => {
    const tag     = document.activeElement?.tagName;
    const inInput = tag === "INPUT" || tag === "TEXTAREA";

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (els.nodeSearchOverlay?.classList.contains("show")) closeNodeSearch();
      else openNodeSearch();
      return;
    }
    if (inInput) return;

    switch (e.key) {
      case "Escape":
        if (els.nodeSearchOverlay?.classList.contains("show")) { closeNodeSearch(); break; }
        if (State.pathHighlight) { clearPathHighlight(); break; }
        focusSeed();
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
// LIFECYCLE
// ════════════════════════════════════════════════════════════════════════════

function showGraphView() {
  els.hero.classList.add("is-hidden");
  els.graphView.hidden = false;
  requestAnimationFrame(() => els.graphView.classList.add("is-visible"));
  if (els.status) els.status.hidden = false;
}

function destroyNetwork() {
  clearTimeout(State.physicsTimer);
  State.physicsTimer = null;
  if (State.network) { State.network.destroy(); State.network = null; }
  State.nodesDS       = null;
  State.edgesDS       = null;
  State.graphNodes    = [];
  State.graphEdges    = [];
  State.nameById      = {};
  State.currentSeedId = null;
  State.focusedNodeId = null;
  State.pinnedNodes.clear();
  State.pathHighlight = null;
  State.hasRendered   = false;
  State.physicsActive = true;
  State._bfsMemo.clear();
  State._bfsAdj.clear();
  hideArtistSidebar();
}

function resetToHero() {
  els.graphView.classList.remove("is-visible");
  setTimeout(() => {
    els.graphView.hidden = true;
    if (els.status) els.status.hidden = true;
  }, 420);
  els.hero.classList.remove("is-hidden");
  els.heroInput.value = "";
  els.heroInput.focus();
  hideToast();
  hideArtistSidebar();
  els.pathPanel?.classList.remove("show");
  destroyNetwork();
  history.replaceState(null, "", window.location.pathname);
}

function updateStatus(graph) {
  let visible = 0, visEdge = 0;
  State.nodesDS?.forEach(nd => { if (!nd.hidden) visible++; });
  State.edgesDS?.forEach(ed => { if (!ed.hidden) visEdge++; });
  if (!State.nodesDS) { visible = (graph.nodes||[]).length; visEdge = (graph.edges||[]).length; }
  const seed = graph.seed || "—";
  if (els.statusSeed)
    els.statusSeed.textContent =
      `${seed} · ${visible} артист${visible===1?"":"а"} · ${visEdge} связь${visEdge===1?"":"и"}`;
}

function showLoading(on) { els.loading?.classList.toggle("show", !!on); }

function showToast(msg, ms = 4800, isInfo = false) {
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.classList.toggle("toast--info", isInfo);
  els.toast.classList.add("show");
  if (State.toastTimer) clearTimeout(State.toastTimer);
  State.toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  els.toast?.classList.remove("show","toast--info");
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

  els.heroForm?.addEventListener("submit", e => { e.preventDefault(); searchArtist(els.heroInput.value, false); });
  els.dockForm?.addEventListener("submit", e => { e.preventDefault(); searchArtist(els.dockInput.value, false); els.dockInput.blur(); });

  els.chips?.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    els.heroInput.value = chip.getAttribute("data-artist");
    searchArtist(chip.getAttribute("data-artist"), false);
  });

  els.brand?.addEventListener("click", resetToHero);
  els.sidebarClose?.addEventListener("click", () => { hideArtistSidebar(); clearFocus(); });

  els.layoutForce?.addEventListener("click",  () => switchLayout(LAYOUTS.FORCE));
  els.layoutRadial?.addEventListener("click", () => switchLayout(LAYOUTS.RADIAL));
  els.layoutHier?.addEventListener("click",   () => switchLayout(LAYOUTS.HIERARCH));

  els.btnExportPng?.addEventListener("click",  exportPng);
  els.btnExportJson?.addEventListener("click", exportJson);
  els.btnClearGraph?.addEventListener("click", resetToHero);
  els.btnCopyLink?.addEventListener("click",   copyShareableLink);
  els.btnFitView?.addEventListener("click",    fitView);

  $("btn-physics")?.addEventListener("click", togglePhysics);
  $("btn-node-search")?.addEventListener("click", openNodeSearch);

  loadArtistFromUrl();
  els.heroInput.focus();
}

window.addEventListener("DOMContentLoaded", init);
window._featureAtlas = { State, searchArtist, bfsPath };
