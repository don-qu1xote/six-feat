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

// [SF-WEB-47] Exported so dom/transition.js can read --ease-emphasized the
// same live way COLOR/MOTION read their own tokens, instead of hardcoding
// the cubic-bezier() string a second time.
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

// [SF-WEB-47] MOTION — same live-getter-onto-CSS-variable pattern as COLOR
// above, for the duration tokens (styles/tokens.css). Every
// network.fit()/focus()/moveTo()/RAF-flyout duration used to be its own
// hardcoded number, independently picked in physics.js/render.js/several
// ui/*.js call sites (220/400/420/500/600/700ms) — the exact same
// "scattered literal" problem tokens.css's own Motion section already
// solved for CSS. MOTION reads the CSS custom properties directly rather
// than duplicating their values as JS constants, so a token edit in one
// place (tokens.css) moves every consumer, CSS or JS, together — it can
// never fall out of sync the way two independent numbers could.
const MOTION_DEFAULTS = {
  fast:   120, base: 150, med: 200, slow: 280, slower: 320,
  xslow:  380, flight: 420, camera: 500, xxslow: 600, loop: 800,
};

function readCssVarMs(name, fallbackMs) {
  if (typeof document === "undefined" || !document.documentElement) return fallbackMs;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallbackMs;
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return fallbackMs;
  return raw.endsWith("ms") ? n : n * 1000; // tokens.css durations are all "Nms", but tolerate "Ns" too
}

export const MOTION = {};
for (const key of Object.keys(MOTION_DEFAULTS)) {
  Object.defineProperty(MOTION, key, {
    get: () => readCssVarMs(`--duration-${key}`, MOTION_DEFAULTS[key]),
    enumerable: true,
  });
}

// vis.js's own animation.easingFunction is a fixed keyword string (its
// internal easing table), not a CSS easing value — it can't read
// --ease-standard's cubic-bezier() the way MOTION reads --duration-*, so
// this stays a plain exported constant instead of a live getter. Centralized
// here (instead of the literal "easeInOutQuad" typed out at every
// network.fit()/focus()/moveTo() call site) purely to kill the copy-pasted-
// string flavor of the same "scattered literal" problem.
export const VIS_EASING = "easeInOutQuad";

// [SF-WEB-47] Single shared prefers-reduced-motion check — previously
// reimplemented independently in vis-adapter/physics.js and
// dom/transition.js (two copies of the same matchMedia query). vis.js
// network animations (fit/focus/moveTo) didn't check it AT ALL before this
// ticket — see visAnimation() below, which is what actually wires this into
// every one of those call sites.
export function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// [SF-WEB-53] Масштаб (network.getScale()) не влияет на длительность
// анимации 1:1 — иначе на очень мелком zoom-out анимация станет неоправданно
// долгой, а на очень крупном zoom-in — неоправданно короткой. clamp() держит
// множитель в разумном коридоре: на «крупном плане» (scale выше базового
// SCALE_BASELINE, т.е. картинка сильнее «кроплена») то же перемещение в
// координатах графа покрывает больше экранных пикселей за кадр — там дольше
// длящаяся анимация даёт больше кадров на тот же путь и заметно меньше «рвёт
// глаз»; на мелком zoom-out то же перемещение — единицы экранных пикселей,
// и там урезанная длительность незаметна и не тратит время пользователя
// впустую. SCALE_MIN/MAX ограничивают влияние сверху и снизу, чтобы крайние
// значения scale (глубокий зум в толпу листьев / общий обзор всего графа) не
// давали анимацию, ощутимо длиннее ~2x или короче ~0.6x исходной MOTION-
// длительности.
const SCALE_BASELINE = 1;
const SCALE_MIN = 0.35;
const SCALE_MAX = 3;
const DURATION_MULT_MIN = 0.6;
const DURATION_MULT_MAX = 2;

// Читает текущий zoom сети (если она уже смонтирована — State.network может
// быть ещё null при самом первом рендере, тогда просто используем baseline,
// т.е. никакого масштабирования длительности).
function _currentScale() {
  const net = State.network;
  if (!net || typeof net.getScale !== "function") return SCALE_BASELINE;
  const s = net.getScale();
  return Number.isFinite(s) && s > 0 ? s : SCALE_BASELINE;
}

// Множитель длительности как функция текущего zoom: линейно по log(scale)
// (используем log, а не сам scale, потому что зум типично меняется в разы —
// 0.5x/2x/4x — а не на константу, так что "на сколько кропнута картинка"
// естественнее мерить в логарифмической шкале), затем зажат в
// [DURATION_MULT_MIN, DURATION_MULT_MAX].
function _durationMultiplier() {
  const scale = clamp(_currentScale(), SCALE_MIN, SCALE_MAX);
  const t = Math.log(scale / SCALE_BASELINE) / Math.log(SCALE_MAX / SCALE_BASELINE);
  // t ∈ [-1, 1] относительно baseline; проецируем в [MIN, MAX] вокруг 1.0
  const mult = t >= 0
    ? 1 + t * (DURATION_MULT_MAX - 1)
    : 1 + t * (1 - DURATION_MULT_MIN);
  return clamp(mult, DURATION_MULT_MIN, DURATION_MULT_MAX);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// [SF-WEB-53] Тот же множитель длительности, что и внутри visAnimation() —
// вынесен отдельной экспортируемой функцией для вызовов, которые не
// проходят через vis.js animation-option (например, RAF-полёт нод в
// physics.js::runFlyoutAnimation), но должны точно так же удлиняться на
// крупном плане и укорачиваться на общем обзоре. prefers-reduced-motion
// сюда не встроен намеренно — у не-vis.js вызывающих кода (RAF-цикл) нет
// vis.js-эквивалента animation:false ("один кадр"), они сами решают, как
// коротко считать анимацию неотличимой от мгновенной, поэтому здесь только
// zoom-множитель, а не полная политика reduced-motion.
export function scaledDuration(durationMs) {
  return Math.round(durationMs * _durationMultiplier());
}

// Builds the {duration, easingFunction} object every network.fit()/
// focus()/moveTo() call passes as its `animation` option — or `false` (vis.js's
// own "skip the animation entirely" value) under prefers-reduced-motion, so
// the camera/view jumps straight to its destination in one frame instead of
// animating there. `durationMs` is meant to be one of MOTION's own values
// (e.g. `visAnimation(MOTION.camera)`), not a fresh literal.
// [SF-WEB-53] Длительность дополнительно масштабируется по текущему zoom
// сети (см. _durationMultiplier) — «на большом растоянии [сильный zoom-in]
// малое количество кадров заметнее, чем на маленьком [zoom-out]».
export function visAnimation(durationMs) {
  if (prefersReducedMotion()) return false;
  return { duration: scaledDuration(durationMs), easingFunction: VIS_EASING };
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

  // [SF-WEB-47] Graph-native Compare mode: click two nodes to compare them,
  // instead of the old pin-to-select mechanic (physics.js's node-position
  // pin was removed along with it — it only ever existed to gate Compare).
  // compareModeStartId is the first node picked, or null before any pick /
  // after a completed pick has fired the panel. See vis-adapter/compare-mode.js.
  compareMode:        false,
  compareModeStartId: null,

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

  // [SF-WEB-25] Which top-level "surface" is active — "graph" (default,
  // current/only real behavior) or "game" (not built yet; this is just the
  // routing groundwork for it). Driven by ui/router.js's URL hash
  // (#/graph, #/game), never set directly outside that module.
  surface: "graph",

  // [SF-WEB-61] BubbleSets are now a manual, user-controlled toggle — OFF by
  // default, never auto-shown/hidden by node count (the old
  // CONTOUR_MAX_TOTAL_MEMBERS LOD threshold from SF-WEB-58/59 is removed;
  // see bubble-contours.js). Session-only, mirrors theme's "no persistence"
  // spirit. See ui/canvas-controls.js's toggle button.
  bubbleSetsEnabled: false,
};

// game — [SF-GAME-30 / ADR-0008] Игровой режим. Раньше это жило двумя
// свойствами, которые дописывались на State в рантайме из game-board.js
// (`State.graphGameMode`/`State.gameClick`) и читались в горячем пути клика
// в vis-adapter/events.js, минуя декларацию слайсов и bridge() — то есть
// связность Explorer↔Game держалась на мутабельном глобале, которого нет ни
// в одном списке полей. Теперь это обычный слайс, как compareMode рядом.
const gameSlice = {
  // Включён ли ограниченный игровой режим движка графа. Владелец перехода —
  // vis-adapter/game-mode.js (enterGameMode/exitGameMode), не игровой модуль.
  mode: false,

  // Роутер кликов, который game-mode.js ставит на время режима: пока mode
  // включён, events.js отдаёт сюда каждый клик по узлу вместо собственного
  // expand/select. null вне режима.
  clickRouter: null,

  // Где живёт #network вне игры (#app-canvas). Запоминается на входе в
  // режим, чтобы выход вернул узел ровно туда же.
  homeParent: null,

  // Состояние текущего раунда Connect. Раньше создавалось ad-hoc внутри
  // connect.js::slice() как State.connect = {...} при первом обращении —
  // тот же класс «поля нет в state.js, но оно есть». Форма не изменилась,
  // поэтому все существующие обращения к State.connect работают как были
  // (см. bridge("connect", ...) ниже).
  connect: {
    startName: "", goalName: "", game: null,
    photos: {}, ids: {}, frontier: null,
    rivalBanner: null, par: null, seasonId: null, submitted: false,
    // [SF-GAME-34 / ADR-0009] Имена, которые НЕ удалось разрешить в реальный
    // Genius id (map name→true). Раньше такое имя молча получало
    // синтетический отрицательный id и рисовалось как полноценный узел —
    // отсюда «набрано, но не выбрано» и случайная пара в админке. Теперь
    // нерешённое имя не рисуется вовсе, а вью показывает честное состояние.
    unresolved: {},
  },
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
  game:        gameSlice,
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
bridge("compareMode",        interactionSlice);
bridge("compareModeStartId", interactionSlice);
bridge("pathHighlight",  interactionSlice);
bridge("_isDragging",    interactionSlice);
bridge("_clickTimer",    interactionSlice);
bridge("_lastClickNode", interactionSlice);
bridge("_clickedNodeId", interactionSlice);
bridge("activeFilters",  interactionSlice);
bridge("history",        interactionSlice);
bridge("heroMode",       interactionSlice);
bridge("theme",          interactionSlice);
bridge("surface",        interactionSlice);
bridge("bubbleSetsEnabled", interactionSlice);

// [SF-GAME-30] State.connect keeps working unchanged at every existing call
// site (game/connect*.js) — it's just a declared field now, not one invented
// at runtime. graphGameMode/gameClick deliberately get NO bridge: they were
// never a public contract, and their only two readers (events.js, game-board
// .js) now go through vis-adapter/game-mode.js instead (ADR-0008).
bridge("connect", gameSlice);

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

// [SF-GAME-30 / ADR-0008] Игровой режим движка: три поля, которые обязаны
// двигаться вместе (включён / кто роутит клики / куда вернуть #network) —
// ровно тот случай, ради которого в этом файле вообще есть мутаторы. Пишется
// только из vis-adapter/game-mode.js; всё остальное читает State.game.mode
// через isGameModeActive().
export function setGameMode(on, { clickRouter = null, homeParent = null } = {}) {
  gameSlice.mode = !!on;
  gameSlice.clickRouter = on ? clickRouter : null;
  // homeParent переживает выход из режима только пока идёт сам выход —
  // game-mode.js читает его, чтобы вернуть узел, и сразу обнуляет.
  if (on || homeParent === null) gameSlice.homeParent = on ? homeParent : null;
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
  // [SF-WEB-47] A fresh (non-expansion) search draws a brand-new graph — a
  // half-picked Compare-mode start node from the graph being replaced
  // doesn't carry meaning onto the new one. The rail toggle/markers
  // themselves are cleared by vis-adapter/compare-mode.js's own
  // exitCompareMode() at every explicit exit; this is the data-model safety
  // net for the graph being replaced out from under an in-progress pick
  // some other way (e.g. a fresh search).
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
