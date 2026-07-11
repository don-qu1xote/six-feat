// ════════════════════════════════════════════════════════════════════════════
// state.js — Constants, colour palette, State singleton
// ════════════════════════════════════════════════════════════════════════════

// IDEA-23: light/dark theme support. The hex literals below are the dark-
// theme (default) fallback values — also what index.html's :root defines
// for the same custom properties. COLOR's properties are live getters onto
// those CSS variables (see readCssVar/defineColorProps below) rather than
// static strings, so switching <html data-theme> (setupThemeToggle,
// src/ui/theme.js) is picked up by every COLOR.xxx read — including inside
// vis-adapter — without a second, redundant "which theme is active" source
// of truth. The fallback also keeps this working outside a browser (jsdom
// test env has no rendered stylesheet, so getComputedStyle returns "").
const COLOR_DEFAULTS = {
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

function readCssVar(name, fallback) {
  if (typeof document === "undefined" || !document.documentElement) return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export const COLOR = {};
for (const key of Object.keys(COLOR_DEFAULTS)) {
  Object.defineProperty(COLOR, key, {
    get: () => readCssVar(`--${key}`, COLOR_DEFAULTS[key]),
    enumerable: true,
  });
}

// Все линии сплошные — dashes при большом числе рёбер нечитаемы
// и значительно замедляют рендер (canvas fillRect на каждый сегмент).
// Роли различаются только цветом.
//
// Баг "серые рёбра/иконки при наведении/клике": "primary" — самая частая
// dominant-роль (все коллаборации без явного featured/producer/writer тега
// схлопываются в неё, см. computeNodeDominantRoles/resolveEdgeDominantRole),
// а раньше была покрашена в COLOR.line (#283044) — тёмно-серый цвет линий
// самой канвы. Хайлайт-функции (applyDimState/_applyHoverEdge/
// _applyHoverNode) переиспользуют именно этот "акцентный" цвет ребра/ноды
// на полной непрозрачности вместо затемнённой версии — поэтому "яркая
// подсветка" primary-рёбер/нод физически не могла стать цветной: она лишь
// поднимала прозрачность у того же самого серого. Теперь primary —
// самостоятельный блёкло-голубой акцент (#8FA6C9), не занятый
// featured/producer/writer: на подсветке читается как явно "яркий", а в
// приглушённом дефолтном состоянии (opacity .40) по-прежнему выглядит
// нейтрально, как задумано.
// `color` is a getter (not a snapshot) for the same reason as COLOR above —
// callers do `roleStyle(role).color` at render time, so it needs to reflect
// whichever theme is active *then*, not whichever was active when this
// module first evaluated.
export const ROLE_STYLE = {
  featured: { dash: false, get color() { return COLOR.signal; } },
  producer: { dash: false, get color() { return COLOR.pulse; } },
  writer:   { dash: false, get color() { return COLOR.amber; } },
  primary:  { dash: false, get color() { return readCssVar("--primary2", "#8FA6C9"); } }
};

// ТЗ-C: SVG icons now used instead of emoji.
// ROLE_ICON returns just the <use> element, styling handled by CSS .role-icon class
export const ROLE_ICON = {
  featured: '<use href="#icon-mic"></use>',
  producer: '<use href="#icon-sliders"></use>',
  writer:   '<use href="#icon-pen"></use>',
  primary:  '<use href="#icon-mic"></use>'
};

export const ROLE_PRIORITY = ["featured", "primary", "producer", "writer"];

export const MAX_HISTORY     = 5;
export const SEARCH_DEBOUNCE = 300;

// IDEA-22: songs-limit-fg server default (static_config.yaml) — the
// baseline "Show more collaborations" steps up from, capped at
// GRAPH_MAX_LIMIT (must stay <= handler-graph's max-limit-override).
export const GRAPH_DEFAULT_LIMIT  = 40;
export const GRAPH_LOAD_MORE_STEP = 40;
export const GRAPH_MAX_LIMIT      = 50;

// ТЗ-204: Единая таблица уровней прозрачности/затемнения для applyDimState().
// Раньше эти же числа (0.08, 0.10, 0.12, 0.02) были разбросаны магическими
// литералами по highlightNeighborhood/highlightEdgePair/highlightPath/
// restoreDefaultColors — теперь одно место правки для любого будущего ТЗ
// вроде ТЗ-201/ТЗ-203.
export const DIM_LEVELS = {
  deep: 0.08,   // "никогда не тронутый" узел/ребро — глубокое затемнение
  mid:  0.45,   // приглушённый, но видимый (expanded-off-path и т.п.)
  off:  1       // полная видимость — активный/on-path/сфокусированный элемент
};

// ТЗ-201: Уровни затемнения для path highlight с поддержкой expanded-веток
export const PATH_HIGHLIGHT_LEVELS = {
  onPath: {
    opacity: 1,
    border: "bright",      // neon/accent color
    width: 5,              // толстый бордер
    edgeOpacity: 1,
    edgeWidth: 5
  },
  expandedOffPath: {
    opacity: 0.45,         // видимы, но приглушены
    border: "normal",      // обычный цвет бордера
    width: 2,
    edgeOpacity: 0.35,
    edgeWidth: 2
  },
  neverTouched: {
    opacity: 0.08,         // глубокое затемнение
    border: "dim",         // очень приглушённый бордер
    width: 1,
    edgeOpacity: 0.02,
    edgeWidth: 1
  }
};

// Physics timing constants
// SETTLE: время работы физики при первом открытии (stabilization уже отработал,
// это запасной таймер).
// EXPAND: время физики при expand — ноды уже расставлены, нужно чуть-чуть.
export const PHYSICS_SETTLE_MS    = 1500;
export const PHYSICS_EXPAND_MS    = 800;
export const STABILIZE_ITERATIONS = 200;

// ────────────────────────────────────────────────────────────────────────────
// State — was a single ~30-field flat object written directly from 20+
// modules. Grouped here into per-subsystem slices so each family of related
// fields has one owner and (for the invariants that matter — graph shape,
// seed, path highlight) one mutator function instead of scattered
// assignments. `State.<field>` access below is preserved via getter/setter
// bridges so existing call sites (vis-adapter/*, ui/*, graph.js, api.js)
// keep working unchanged; new code can also reach into the slices directly
// (State.graph, State.interaction, State.netFetch, State.cache, State.anim).
// ────────────────────────────────────────────────────────────────────────────

// graph — the current graph's data + vis.Network wiring.
const graphSlice = {
  network:        null,
  nodesDS:        null,
  edgesDS:        null,
  currentSeedId:  null,
  hasRendered:    false,
  nodes:          [],
  edges:          [],
  expandedNodes:  new Set(),
  lastExpandedId: null,

  // IDEA-22: songs-limit-fg override currently in effect for the seed
  // (null = server default). Bumped by "Show more collaborations"; reset
  // whenever the seed changes (see setSeed below).
  collabLimit: null,

  // IDEA-50: FG truncation signal from the last graph response — see
  // graph_handler.cpp's "truncated"/"shown_song_count"/"song_limit" fields.
  // Set by setTruncation() (called from finalizeGraphState), read by
  // ui/canvas-controls.js's updateTruncationBanner.
  truncated:      false,
  shownSongCount: 0,
  songLimit:      0,
};

// interaction — focus/selection/click/drag/path-highlight/filters/history.
const interactionSlice = {
  focusedNodeId:  null,
  selectedEdgeId: null,
  // SF-WEB-15: persistent single-node selection marker, analogous to
  // selectedEdgeId — set by selectNode()/cleared by clearSelectedNode()
  // (vis-adapter/highlight.js), independent of the hover-neighborhood
  // highlight driven by focusedNodeId/highlightNeighborhood.
  selectedNodeId: null,
  pathHighlight:  null,

  // Баг "тряска графа подвисает": флаг активного перетаскивания ноды —
  // используется, чтобы на время drag'а глушить hover-подсветку и держать
  // физику выключенной вместо пересчёта сил на каждом промежуточном кадре
  // (см. attachNetworkEvents dragStart/dragEnd в vis-adapter.js).
  _isDragging: false,

  _clickTimer:    null,
  _lastClickNode: null,
  _clickedNodeId: null,

  activeFilters: new Set(["featured", "producer", "writer"]),
  history: [],

  // IDEA-41: which hero mode is active — "explore" (single-artist graph
  // search) or "connect" (from/to path finder). Drives the segmented
  // switch's aria-selected/thumb position; see setupHeroModeSwitch.
  heroMode: "explore",

  // IDEA-23: "dark" (default) or "light" — mirrors <html data-theme>.
  // Session-only (no localStorage): reset to the prefers-color-scheme
  // read on the next load instead of persisting. See setupThemeToggle.
  theme: "dark",
};

// netFetch — in-flight graph/path requests, their AbortControllers, pollers.
const netFetchSlice = {
  inFlight:      false,
  pendingExpand: null,
  pathInFlight:  false,

  // AbortControllers for cancellable fetch requests (ТЗ-4).
  _abortController:     null,
  _pathAbortController: null,

  _enrichmentPoller: null,
};

// cache — BFS adjacency memo + client-side graph response cache (ТЗ-5).
const cacheSlice = {
  _bfsAdj:       null,
  _bfsGraphHash: "",

  // Key: artistId (number), value: { graph, timestamp }. Max 20 entries;
  // oldest evicted when 21st is added (see setGraphCacheEntry below).
  _graphCache: new Map(),
};

// anim — timers/RAF handles for toasts and graph physics.
const animSlice = {
  toastTimer:   null,
  physicsTimer: null,

  // RAF handle for the expand fly-in animation (rule 3); cancellable.
  _expandAnimId: null,
};

export const State = {
  graph:       graphSlice,
  interaction: interactionSlice,
  netFetch:    netFetchSlice,
  cache:       cacheSlice,
  anim:        animSlice,
};

// Backward-compatible flat field: State.<flatName> reads/writes
// slice[sliceKey] directly, so `State.network = x` / `State.graphNodes.push`
// etc. keep behaving exactly as before the grouping.
function bridge(flatName, slice, sliceKey = flatName) {
  Object.defineProperty(State, flatName, {
    get()  { return slice[sliceKey]; },
    set(v) { slice[sliceKey] = v; },
    enumerable: true,
    configurable: true,
  });
}

bridge("network",        graphSlice);
bridge("nodesDS",        graphSlice);
bridge("edgesDS",        graphSlice);
bridge("currentSeedId",  graphSlice);
bridge("hasRendered",    graphSlice);
bridge("graphNodes",     graphSlice, "nodes");
bridge("graphEdges",     graphSlice, "edges");
bridge("expandedNodes",  graphSlice);
bridge("lastExpandedId", graphSlice);
bridge("collabLimit",    graphSlice);
bridge("truncated",      graphSlice);
bridge("shownSongCount", graphSlice);
bridge("songLimit",      graphSlice);

bridge("focusedNodeId",  interactionSlice);
bridge("selectedEdgeId", interactionSlice);
bridge("selectedNodeId", interactionSlice);
bridge("pathHighlight",  interactionSlice);
bridge("_isDragging",    interactionSlice);
bridge("_clickTimer",    interactionSlice);
bridge("_lastClickNode", interactionSlice);
bridge("_clickedNodeId", interactionSlice);
bridge("activeFilters",  interactionSlice);
bridge("history",        interactionSlice);
bridge("heroMode",       interactionSlice);
bridge("theme",          interactionSlice);

bridge("inFlight",             netFetchSlice);
bridge("pendingExpand",        netFetchSlice);
bridge("pathInFlight",         netFetchSlice);
bridge("_abortController",     netFetchSlice);
bridge("_pathAbortController", netFetchSlice);
bridge("_enrichmentPoller",    netFetchSlice);

bridge("_bfsAdj",       cacheSlice);
bridge("_bfsGraphHash", cacheSlice);
bridge("_graphCache",   cacheSlice);

bridge("toastTimer",    animSlice);
bridge("physicsTimer",  animSlice);
bridge("_expandAnimId", animSlice);

// ────────────────────────────────────────────────────────────────────────────
// Explicit mutators for invariant-bearing graph transitions.
//
// Point-in-time local flags (timers, drag/click bookkeeping, filters) are
// still fine as direct `State.<field> = ...` assignments — these mutators
// exist for the transitions where several fields have to move together to
// keep the graph in a valid shape (seed ↔ focus, node/edge arrays, path
// highlight, full-graph reset).
// ────────────────────────────────────────────────────────────────────────────

// Sets the current seed and clears any pinned focus — the two always change
// together (see finalizeGraphState in graph.js).
export function setSeed(seedId) {
  graphSlice.currentSeedId = seedId;
  interactionSlice.focusedNodeId = null;
  graphSlice.collabLimit = null;
}

export function setNodes(nodes) {
  graphSlice.nodes = nodes;
}

export function setEdges(edges) {
  graphSlice.edges = edges;
}

// IDEA-50: mirrors a graph response's truncation fields into State so
// ui/canvas-controls.js's updateTruncationBanner can decide whether to show
// the "not all collaborations shown" indicator. Called from
// finalizeGraphState for both a fresh replaceGraph and a merge (IDEA-22
// "Show more collaborations"), so the banner always reflects the latest
// fetch's actual limit/song count.
export function setTruncation(graph) {
  graphSlice.truncated      = graph.truncated === true;
  graphSlice.shownSongCount = graph.shown_song_count ?? 0;
  graphSlice.songLimit      = graph.song_limit ?? 0;
}

// Appends newly-built node/edge state objects (see buildNodeState/
// buildEdgeState in graph.js) onto the current graph, e.g. when expanding a
// node merges its neighbours into the existing graph.
export function addNodes(nodes) {
  if (nodes.length) graphSlice.nodes.push(...nodes);
}

export function addEdges(edges) {
  if (edges.length) graphSlice.edges.push(...edges);
}

export function setPathHighlight(path) {
  interactionSlice.pathHighlight = path;
}

// Reverts the expand-tracking bookkeeping that a fresh (non-expansion)
// search invalidates: previously-expanded nodes, the BFS memo, and any
// in-flight click/physics timers from the graph being replaced.
export function resetExpansionState() {
  graphSlice.expandedNodes.clear();
  graphSlice.lastExpandedId = null;
  interactionSlice._clickedNodeId = null;
  netFetchSlice.pendingExpand = null;
  cacheSlice._bfsAdj = null;
  cacheSlice._bfsGraphHash = "";

  clearTimeout(animSlice.physicsTimer);
  animSlice.physicsTimer = null;
  clearTimeout(interactionSlice._clickTimer);
  interactionSlice._clickTimer = null;
  interactionSlice._lastClickNode = null;
}

// Full graph reset: tears down the vis.Network instance and every field
// describing "what graph is currently drawn". Used when leaving the graph
// view entirely (destroyNetwork) or wiping the canvas for a fresh
// six-degrees path render (clearGraphForPathSearch) — the two differ only
// in whether `hasRendered` (the hero↔graph scene flag) should reset too.
export function resetGraphState({ resetHasRendered = true } = {}) {
  if (graphSlice.network) graphSlice.network.destroy();
  graphSlice.network = null;
  graphSlice.nodesDS = null;
  graphSlice.edgesDS = null;
  graphSlice.nodes   = [];
  graphSlice.edges   = [];
  if (resetHasRendered) graphSlice.hasRendered = false;
  graphSlice.expandedNodes.clear();
  graphSlice.lastExpandedId = null;

  setSeed(null);
  setPathHighlight(null);
  interactionSlice._clickedNodeId = null;

  netFetchSlice.pendingExpand = null;

  clearTimeout(animSlice.physicsTimer);
  animSlice.physicsTimer = null;
  if (animSlice._expandAnimId != null) cancelAnimationFrame(animSlice._expandAnimId);
  animSlice._expandAnimId = null;

  cacheSlice._bfsAdj = null;
  cacheSlice._bfsGraphHash = "";
}

// LRU-подобный set с вытеснением самой старой записи (insertion-order,
// т.к. Map хранит порядок вставки, а re-set не переносится в конец —
// см. логику ниже, где старый ключ удаляется перед set()).
// Вынесено из api.js::_doSearch в отдельную тестируемую функцию.
export const GRAPH_CACHE_MAX = 20;

export function setGraphCacheEntry(cache, key, value) {
  // Re-inserting an existing key refreshes its recency (moves it to the end
  // of Map's insertion order) rather than leaving it in its old slot.
  if (cache.has(key)) cache.delete(key);
  if (cache.size >= GRAPH_CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, value);
  return cache;
}
