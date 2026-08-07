import { els, $ } from "./dom/dom.js";
import { searchArtist } from "./api/api.js";
import {
  loadHistory,
  setupFilterToggles,
  setupNodeSearch,
  setupPathPanel,
  setupHeroPathFinder,
  setupHeroModeSwitch,
  createGeniusAc,
  attachGeniusAutocomplete,
  closeDropdown,
  loadArtistFromUrl,
  copyShareableLink,
  openNodeSearch,
  clearCanvas,
  goHome,
  hideArtistSidebar,
  hideCandidatePicker,
  setupKeyboard,
  fitView,
  zoomIn,
  zoomOut,
  focusSeed,
  setupSearchModal,
  setupSeedCard,
  setupHelpOverlay,
  setupLoadMoreCollabs,
  renderChips,
  showChipsIfHistory,
  setupChipsVisibility,
  exportGraphPng,
  exportGraphJson,
  initTheme,
  setupSettingsPanel,
  setupPlaylistsPanel,
  setupDockedPanels,
  restoreSurfaceFromUrl,
  setupBubbleSetsToggle,
  getCurrentSurface,
  isGameSurface,
  closeAllDropdowns,
  onSurfaceChange,
} from "./ui/index.js";
import { clearFocus, setupCompareModeToggle } from "./vis-adapter/index.js";
import { checkAuth, initLogout } from "./api/auth.js";
import { initI18n } from "./i18n/i18n.js";
import { setupCanvasDecorator, startCanvasDecorator } from "./dom/canvas-decorator.js";
import { setupConnectMode, setupGameLandingPanel } from "./game/connect.js";
import { setupGameWindows } from "./game/game-windows.js";

export function init() {
  const missingCritical = [];
  if (!els.heroForm) missingCritical.push("heroForm");
  if (!els.heroInput) missingCritical.push("heroInput");
  if (missingCritical.length) {
    throw new Error(
      `[init] Missing required DOM element(s): ${missingCritical.join(", ")}. App cannot start.`,
    );
  }

  initTheme();
  initI18n();

  restoreSurfaceFromUrl();

  onSurfaceChange(closeAllDropdowns);

  loadHistory();
  renderChips();
  showChipsIfHistory();
  setupFilterToggles();
  setupKeyboard();
  setupDockedPanels();
  setupSettingsPanel();
  setupPlaylistsPanel();
  setupNodeSearch();
  setupPathPanel();
  setupHeroPathFinder();
  setupHeroModeSwitch();
  setupSearchModal();
  setupSeedCard();
  setupHelpOverlay();
  setupLoadMoreCollabs();
  setupCompareModeToggle();
  setupBubbleSetsToggle();
  setupConnectMode();
  setupGameLandingPanel();
  setupGameWindows();

  setupCanvasDecorator();
  startCanvasDecorator();

  const heroAc = $("hero-ac");
  const heroGacFn = createGeniusAc();

  if (heroAc) {
    attachGeniusAutocomplete(
      els.heroInput,
      heroAc,
      (name) => {
        els.heroInput.value = name;
        searchArtist(name, false, true);
      },
      heroGacFn,
      { showHistory: false },
    );
  }

  els.heroForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (heroAc) closeDropdown(heroAc);
    searchArtist(els.heroInput.value, false, true);
  });

  if (els.chips) {
    els.chips.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const name = chip.getAttribute("data-artist");
      els.heroInput.value = name;
      searchArtist(name, false, true);
    });
  } else {
    console.warn("[init] #chips element not found; chip click handling disabled.");
  }

  if (els.brand) {
    els.brand.addEventListener("click", goHome);
  } else {
    console.warn("[init] .brand element not found; brand-click-to-home disabled.");
  }

  if (els.sidebarClose) {
    els.sidebarClose.addEventListener("click", () => {
      hideArtistSidebar();
      clearFocus();
    });
  } else {
    console.warn("[init] sidebarClose element not found; sidebar close button disabled.");
  }

  els.candidateClose?.addEventListener("click", hideCandidatePicker);
  els.candidateOverlay?.addEventListener("click", (e) => {
    if (e.target === els.candidateOverlay) hideCandidatePicker();
  });

  els.btnClearGraph?.addEventListener("click", clearCanvas);
  els.btnCopyLink?.addEventListener("click", copyShareableLink);
  els.btnExportPng?.addEventListener("click", exportGraphPng);
  els.btnExportJson?.addEventListener("click", exportGraphJson);
  els.btnFitView?.addEventListener("click", fitView);
  els.btnZoomIn?.addEventListener("click", zoomIn);
  els.btnZoomOut?.addEventListener("click", zoomOut);
  els.btnFocusSeed?.addEventListener("click", focusSeed);

  $("btn-node-search")?.addEventListener("click", openNodeSearch);

  loadArtistFromUrl();
  checkAuth();
  initLogout();
  if (!isGameSurface(getCurrentSurface())) els.heroInput.focus();

  // [SF-WEB-78] After the auto-focus above, not before — a listener
  // attached first would treat that programmatic focus like a real one
  // and pop the chips open on every landing, exactly the "shows by
  // default" behavior this was meant to fix.
  setupChipsVisibility();
}

window.addEventListener("DOMContentLoaded", init);
