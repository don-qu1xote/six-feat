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
//   modals.js              — search modal + node-search overlay + path-panel
//                            open/close state (isPathPanelOpen/openPathPanel/
//                            closePathPanel/isSearchModalOpen/openSearchModal/
//                            closeSearchModal/forceCloseSearchModal/
//                            setupSearchModal/openNodeSearch/closeNodeSearch/
//                            renderNodeSearchResults/updateNodeSearchResults/
//                            setupNodeSearch/setupDockedPanels)
//   docked-panel.js        — [SF-WEB-24] shared docked-panel shell
//                            mechanics (registerDockedPanel/
//                            closeOtherDockedPanels) the three surfaces
//                            above are built on — not re-exported here,
//                            only modals.js/path-panel.js call it directly
//   sidebar.js             — showArtistSidebar / showEdgeSidebar /
//                            hideArtistSidebar
//   path-result.js         — runServerPath / mergePathData / renderHopChain
//   path-panel.js          — setupPathPanel / setupHeroModeSwitch /
//                            setupHeroPathFinder
//   canvas-controls.js     — setupFilterToggles / setupSeedCard /
//                            setupHelpOverlay / setupLoadMoreCollabs /
//                            fitView / focusSeed / zoomIn /
//                            zoomOut / setupKeyboard / clearCanvas / updateStatus
//   canvas-states.js        — [SF-WEB-19] renderEmptyState / renderLoadingState /
//                            renderErrorState / clearCanvasState
//   compare-panel.js        — [SF-WEB-20] showComparePanel / closeComparePanel /
//                            computeCommonCollaborators (picked graph-natively
//                            via vis-adapter/compare-mode.js, SF-WEB-47)
//   router.js               — [SF-WEB-25] parseSurfaceFromHash / getCurrentSurface /
//                            navigateToSurface / restoreSurfaceFromUrl / onSurfaceChange
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

// [SF-WEB-41] Портал плавающих слоёв + помощники открытия/закрытия дропдаунов
// (для не-автокомплитных мест, которые тоже гасят дропдаун — см. main.js).
export {
  overlayRoot, openDropdown, closeDropdown
} from "./overlay-root.js";

export {
  isPathPanelOpen, openPathPanel, closePathPanel,
  isSearchModalOpen, openSearchModal, closeSearchModal, forceCloseSearchModal,
  setupSearchModal,
  openNodeSearch, closeNodeSearch, renderNodeSearchResults,
  updateNodeSearchResults, setupNodeSearch, setupDockedPanels
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
  setupFilterToggles, setupSeedCard, setupHelpOverlay, setupLoadMoreCollabs,
  fitView, focusSeed, zoomIn, zoomOut, setupKeyboard,
  clearCanvas, goHome, updateStatus, updateRateLimitIndicator, updateTruncationBanner,
  updateScanStatus, exportGraphPng, exportGraphJson, buildGraphExportData
} from "./canvas-controls.js";

export {
  renderEmptyState, renderLoadingState, renderErrorState, clearCanvasState
} from "./canvas-states.js";

export {
  neighboursOf, computeCommonCollaborators,
  isComparePanelOpen, closeComparePanel, showComparePanel
} from "./compare-panel.js";

export {
  SURFACE_GRAPH, SURFACE_GAME, DEFAULT_SURFACE,
  parseSurfaceFromHash, getCurrentSurface, onSurfaceChange,
  navigateToSurface, restoreSurfaceFromUrl
} from "./router.js";

export { renderGraphA11yList } from "./graph-a11y-list.js";

export { setTheme, setupThemeToggle } from "./theme.js";