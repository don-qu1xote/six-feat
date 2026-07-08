// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/index.js — public barrel re-export.
//
// vis-adapter.js was split into submodules by responsibility:
//   visuals.js   — node/edge visual-object builders (nodeVisual/edgeVisual),
//                  sizing, vis.Network options
//   tooltips.js  — tooltip HTML builders + viewport-collision guard
//   render.js    — vis.Network lifecycle (init/refresh/destroy), Genius
//                  page link, canvas↔graph scene transition
//   physics.js   — expand/path layout placement (dandelion/euler), physics
//                  timing helpers (freeze/nudge), flyout animation, mergeNetwork
//   highlight.js — applyDimState and the hover/edge/path/default dim state
//                  machine (DIM_LEVELS / PATH_HIGHLIGHT_LEVELS from state.js)
//   events.js    — attachNetworkEvents (click/dblclick/hover/drag handlers),
//                  setFocus/clearFocus
//
// This file re-exports the exact same public names the old flat
// vis-adapter.js exposed, so existing imports elsewhere (api.js imports
// restoreDefaultColors, graph.js imports computeNodeSizes/initNetwork/etc,
// ui/*.js imports a dozen of these, main.js imports clearFocus) keep working
// unchanged — only `from "./vis-adapter.js"` → `from "./vis-adapter/index.js"`
// (or just "./vis-adapter", since bundlers/Node both resolve the directory
// index) needs to change at the call sites, and nothing about the exported
// function signatures does.
// ════════════════════════════════════════════════════════════════════════════

export {
  // ── visuals.js ─────────────────────────────────────────────────────────
  FIXED_NODE_RADIUS,
  EXPIRED_NODE_RADIUS,
  computeNodeSizes,
  labelFont,
  nodeVisual,
  edgeWidthForWeight,
  edgeVisual,
  resolveEdgeDominantRole,
  networkOptions,
} from "./visuals.js";

export {
  // ── tooltips.js ────────────────────────────────────────────────────────
  ensureTooltipCollisionGuard,
  buildNodeTooltip,
  buildEdgeTooltip,
} from "./tooltips.js";

export {
  // ── render.js ──────────────────────────────────────────────────────────
  initNetwork,
  _attachZoomThrottle,
  refreshNetwork,
  openGeniusPage,
  initGraphOnCanvas,
  destroyNetwork,
  clearGraphForPathSearch,
} from "./render.js";

export {
  // ── physics.js ─────────────────────────────────────────────────────────
  scheduleFreeze,
  updateEdgeRenderMode,
  nudgePhysics,
  _fitToExpandedCluster,
  mergeNetwork,
  runFlyoutAnimation,
} from "./physics.js";

export {
  // ── layout.js ──────────────────────────────────────────────────────────
  placeExpandedNodes,
  placePathNodes,
} from "./layout.js";

export {
  // ── highlight.js ───────────────────────────────────────────────────────
  invalidateColorCache,
  buildDefaultColorCache,
  resetHoverState,
  clearHoverHighlight,
  applyDimState,
  highlightNeighborhood,
  highlightEdgePair,
  highlightPath,
  restoreDefaultColors,
  selectEdge,
  clearSelectedEdge,
} from "./highlight.js";

export {
  // ── events.js ──────────────────────────────────────────────────────────
  attachNetworkEvents,
  setFocus,
  clearFocus,
} from "./events.js";
