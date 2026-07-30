const COLOR_DEFAULTS = {
  paper: "#EDEFF4",
  line: "#283044",
  panel: "#141A28",
  signal: "#5EE6C5",
  pulse: "#B98AFF",
  amber: "#FFD27A",
  warn: "#FF8FA3",
  neon: "#FF2D78",
  ink: "#0B0E14",
};

export function readCssVar(name, fallback) {
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

const MOTION_DEFAULTS = {
  fast: 120,
  base: 150,
  med: 200,
  slow: 280,
  slower: 320,
  xslow: 380,
  flight: 420,
  camera: 500,
  xxslow: 600,
  loop: 800,
};

function readCssVarMs(name, fallbackMs) {
  if (typeof document === "undefined" || !document.documentElement) return fallbackMs;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallbackMs;
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return fallbackMs;
  return raw.endsWith("ms") ? n : n * 1000;
}

export const MOTION = {};
for (const key of Object.keys(MOTION_DEFAULTS)) {
  Object.defineProperty(MOTION, key, {
    get: () => readCssVarMs(`--duration-${key}`, MOTION_DEFAULTS[key]),
    enumerable: true,
  });
}

export const VIS_EASING = "easeInOutQuad";

export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const SCALE_BASELINE = 1;
const SCALE_MIN = 0.35;
const SCALE_MAX = 3;
const DURATION_MULT_MIN = 0.6;
const DURATION_MULT_MAX = 2;

function _currentScale() {
  const net = State.network;
  if (!net || typeof net.getScale !== "function") return SCALE_BASELINE;
  const s = net.getScale();
  return Number.isFinite(s) && s > 0 ? s : SCALE_BASELINE;
}

function _durationMultiplier() {
  const scale = clamp(_currentScale(), SCALE_MIN, SCALE_MAX);
  const t = Math.log(scale / SCALE_BASELINE) / Math.log(SCALE_MAX / SCALE_BASELINE);
  const mult = t >= 0 ? 1 + t * (DURATION_MULT_MAX - 1) : 1 + t * (1 - DURATION_MULT_MIN);
  return clamp(mult, DURATION_MULT_MIN, DURATION_MULT_MAX);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function scaledDuration(durationMs) {
  return Math.round(durationMs * _durationMultiplier());
}

export function visAnimation(durationMs) {
  if (prefersReducedMotion()) return false;
  return { duration: scaledDuration(durationMs), easingFunction: VIS_EASING };
}

export const ROLE_STYLE = {
  featured: {
    dash: false,
    get color() {
      return COLOR.signal;
    },
  },
  producer: {
    dash: false,
    get color() {
      return COLOR.pulse;
    },
  },
  writer: {
    dash: false,
    get color() {
      return COLOR.amber;
    },
  },
  primary: {
    dash: false,
    get color() {
      return readCssVar("--primary2", "#8FA6C9");
    },
  },
};

export const ROLE_ICON = {
  featured: '<use href="#icon-mic"></use>',
  producer: '<use href="#icon-sliders"></use>',
  writer: '<use href="#icon-pen"></use>',
  primary: '<use href="#icon-mic"></use>',
};

export const ROLE_PRIORITY = ["featured", "primary", "producer", "writer"];

export const MAX_HISTORY = 5;
export const SEARCH_DEBOUNCE = 300;

export const GRAPH_DEFAULT_LIMIT = 40;
export const GRAPH_LOAD_MORE_STEP = 40;
export const GRAPH_MAX_LIMIT = 50;

export const DIM_LEVELS = {
  deep: 0.08,
  mid: 0.45,
  off: 1,
};

export const PATH_HIGHLIGHT_LEVELS = {
  onPath: {
    opacity: 1,
    border: "bright",
    width: 5,
    edgeOpacity: 1,
    edgeWidth: 5,
  },
  expandedOffPath: {
    opacity: 0.45,
    border: "normal",
    width: 2,
    edgeOpacity: 0.35,
    edgeWidth: 2,
  },
  neverTouched: {
    opacity: 0.08,
    border: "dim",
    width: 1,
    edgeOpacity: 0.02,
    edgeWidth: 1,
  },
};

export const PHYSICS_SETTLE_MS = 1500;
export const PHYSICS_EXPAND_MS = 800;
export const STABILIZE_ITERATIONS = 200;

const graphSlice = {
  network: null,
  nodesDS: null,
  edgesDS: null,
  currentSeedId: null,
  hasRendered: false,
  nodes: [],
  edges: [],
  expandedNodes: new Set(),
  lastExpandedId: null,

  collabLimit: null,

  truncated: false,
  shownSongCount: 0,
  songLimit: 0,
};

const interactionSlice = {
  focusedNodeId: null,
  selectedEdgeId: null,
  selectedNodeId: null,
  pathHighlight: null,

  compareMode: false,
  compareModeStartId: null,

  _isDragging: false,

  _clickTimer: null,
  _lastClickNode: null,
  _clickedNodeId: null,

  activeFilters: new Set(["featured", "producer", "writer"]),
  history: [],

  heroMode: "explore",

  theme: "dark",

  surface: "graph",

  bubbleSetsEnabled: false,
};

const gameSlice = {
  mode: false,

  clickRouter: null,

  homeParent: null,

  connect: {
    startName: "",
    goalName: "",
    game: null,
    photos: {},
    ids: {},
    frontier: null,
    rivalBanner: null,
    par: null,
    seasonId: null,
    submitted: false,
    unresolved: {},
  },
};

const netFetchSlice = {
  inFlight: false,
  pendingExpand: null,
  pathInFlight: false,
  deepenInFlight: false,

  _abortController: null,
  _pathAbortController: null,

  _enrichmentPoller: null,
};

const cacheSlice = {
  _bfsAdj: null,
  _bfsGraphHash: "",

  _graphCache: new Map(),
};

const animSlice = {
  toastTimer: null,
  physicsTimer: null,

  _expandAnimId: null,
};

export const State = {
  graph: graphSlice,
  interaction: interactionSlice,
  game: gameSlice,
  netFetch: netFetchSlice,
  cache: cacheSlice,
  anim: animSlice,
};

function bridge(flatName, slice, sliceKey = flatName) {
  Object.defineProperty(State, flatName, {
    get() {
      return slice[sliceKey];
    },
    set(v) {
      slice[sliceKey] = v;
    },
    enumerable: true,
    configurable: true,
  });
}

bridge("network", graphSlice);
bridge("nodesDS", graphSlice);
bridge("edgesDS", graphSlice);
bridge("currentSeedId", graphSlice);
bridge("hasRendered", graphSlice);
bridge("graphNodes", graphSlice, "nodes");
bridge("graphEdges", graphSlice, "edges");
bridge("expandedNodes", graphSlice);
bridge("lastExpandedId", graphSlice);
bridge("collabLimit", graphSlice);
bridge("truncated", graphSlice);
bridge("shownSongCount", graphSlice);
bridge("songLimit", graphSlice);

bridge("focusedNodeId", interactionSlice);
bridge("selectedEdgeId", interactionSlice);
bridge("selectedNodeId", interactionSlice);
bridge("compareMode", interactionSlice);
bridge("compareModeStartId", interactionSlice);
bridge("pathHighlight", interactionSlice);
bridge("_isDragging", interactionSlice);
bridge("_clickTimer", interactionSlice);
bridge("_lastClickNode", interactionSlice);
bridge("_clickedNodeId", interactionSlice);
bridge("activeFilters", interactionSlice);
bridge("history", interactionSlice);
bridge("heroMode", interactionSlice);
bridge("theme", interactionSlice);
bridge("surface", interactionSlice);
bridge("bubbleSetsEnabled", interactionSlice);

bridge("connect", gameSlice);

bridge("inFlight", netFetchSlice);
bridge("pendingExpand", netFetchSlice);
bridge("pathInFlight", netFetchSlice);
bridge("deepenInFlight", netFetchSlice);
bridge("_abortController", netFetchSlice);
bridge("_pathAbortController", netFetchSlice);
bridge("_enrichmentPoller", netFetchSlice);

bridge("_bfsAdj", cacheSlice);
bridge("_bfsGraphHash", cacheSlice);
bridge("_graphCache", cacheSlice);

bridge("toastTimer", animSlice);
bridge("physicsTimer", animSlice);
bridge("_expandAnimId", animSlice);

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

export function setGameMode(on, { clickRouter = null, homeParent = null } = {}) {
  gameSlice.mode = !!on;
  gameSlice.clickRouter = on ? clickRouter : null;
  if (on || homeParent === null) gameSlice.homeParent = on ? homeParent : null;
}

export function setTruncation(graph) {
  graphSlice.truncated = graph.truncated === true;
  graphSlice.shownSongCount = graph.shown_song_count ?? 0;
  graphSlice.songLimit = graph.song_limit ?? 0;
}

export function addNodes(nodes) {
  if (nodes.length) graphSlice.nodes.push(...nodes);
}

export function addEdges(edges) {
  if (edges.length) graphSlice.edges.push(...edges);
}

export function setPathHighlight(path) {
  interactionSlice.pathHighlight = path;
}

export function resetExpansionState() {
  graphSlice.expandedNodes.clear();
  graphSlice.lastExpandedId = null;
  interactionSlice._clickedNodeId = null;
  interactionSlice.compareMode = false;
  interactionSlice.compareModeStartId = null;
  netFetchSlice.pendingExpand = null;
  cacheSlice._bfsAdj = null;
  cacheSlice._bfsGraphHash = "";

  clearTimeout(animSlice.physicsTimer);
  animSlice.physicsTimer = null;
  clearTimeout(interactionSlice._clickTimer);
  interactionSlice._clickTimer = null;
  interactionSlice._lastClickNode = null;
}

export function resetGraphState({ resetHasRendered = true } = {}) {
  if (graphSlice.network) graphSlice.network.destroy();
  graphSlice.network = null;
  graphSlice.nodesDS = null;
  graphSlice.edgesDS = null;
  graphSlice.nodes = [];
  graphSlice.edges = [];
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

export const GRAPH_CACHE_MAX = 20;

export function setGraphCacheEntry(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  if (cache.size >= GRAPH_CACHE_MAX) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, value);
  return cache;
}
