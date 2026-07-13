// ════════════════════════════════════════════════════════════════════════════
// ui/index.js — public barrel re-export.
//
// ui.js (1522 lines) was split into submodules by responsibility:
//   toast.js             — showToast / hideToast
//   loading.js            — showLoading
//   candidate-picker.js   — showCandidatePicker / hideCandidatePicker
//   history.js            — loadHistory / saveHistory / pushHistory /
//                            renderChips / updateShareableUrl /
//                            loadArtistFromUrl / copyShareableLink
//   autocomplete.js        — createGeniusAc / attachGeniusAutocomplete /
//                            attachNodeAutocomplete
//   modals.js              — search modal + command palette (⌘K, was just a
//                            node-search overlay) + path-panel open/close
//                            state (isPathPanelOpen/openPathPanel/
//                            closePathPanel/isSearchModalOpen/openSearchModal/
//                            closeSearchModal/forceCloseSearchModal/
//                            setupSearchModal/openNodeSearch/closeNodeSearch/
//                            renderNodeSearchResults/updateNodeSearchResults/
//                            setupNodeSearch) — [SF-WEB-21] renderNodeSearch-
//                            Results now renders command rows + the new-seed
//                            search row alongside graph-node results, one
//                            unified arrow-navigable list.
//   sidebar.js             — showArtistSidebar / showEdgeSidebar /
//                            hideArtistSidebar
//   path-result.js         — runServerPath / mergePathData / renderHopChain
//   path-panel.js          — setupPathPanel / setupHeroModeSwitch /
//                            setupHeroPathFinder
//   canvas-controls.js     — setupFilterToggles / toggleRoleFilter /
//                            setupSeedCard / setupHelpOverlay /
//                            openHelpOverlay / closeHelpOverlay /
//                            setupLoadMoreCollabs / fitView / focusSeed /
//                            zoomIn / zoomOut / setupKeyboard / clearCanvas /
//                            updateStatus
//
// This file re-exports the exact same public names the old flat ui.js
// exposed, so existing imports elsewhere (api.js, graph.js, main.js,
// vis-adapter/*.js, analytics-client.js) keep working unchanged — only
// `from "./ui.js"` → `from "./ui/index.js"` needs to change at the call
// sites, and nothing about the exported function signatures does.
// ════════════════════════════════════════════════════════════════════════════

export { showToast, hideToast, showRetryToast } from "./toast.js";

export { showLoading } from "./loading.js";

export { showCandidatePicker, hideCandidatePicker } from "./candidate-picker.js";

export {
  loadHistory, saveHistory, pushHistory, renderChips,
  updateShareableUrl, loadArtistFromUrl, copyShareableLink
} from "./history.js";

export {
  createGeniusAc, attachGeniusAutocomplete, attachNodeAutocomplete
} from "./autocomplete.js";

export {
  isPathPanelOpen, openPathPanel, closePathPanel,
  isSearchModalOpen, openSearchModal, closeSearchModal, forceCloseSearchModal,
  setupSearchModal,
  openNodeSearch, closeNodeSearch, renderNodeSearchResults,
  updateNodeSearchResults, setupNodeSearch
} from "./modals.js";

export {
  showArtistSidebar, showEdgeSidebar, hideArtistSidebar
} from "./sidebar.js";

export {
  runServerPath, mergePathData, renderHopChain
} from "./path-result.js";

export {
  setupPathPanel, setupHeroModeSwitch, setupHeroPathFinder
} from "./path-panel.js";

export {
  setupFilterToggles, toggleRoleFilter, setupSeedCard,
  setupHelpOverlay, openHelpOverlay, closeHelpOverlay, setupLoadMoreCollabs,
  fitView, focusSeed, zoomIn, zoomOut, setupKeyboard,
  clearCanvas, updateStatus, updateRateLimitIndicator, updateTruncationBanner,
  exportGraphPng
} from "./canvas-controls.js";

export { renderGraphA11yList } from "./graph-a11y-list.js";

export { setTheme, setupThemeToggle } from "./theme.js";