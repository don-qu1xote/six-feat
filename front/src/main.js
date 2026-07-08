// ════════════════════════════════════════════════════════════════════════════
// main.js — Entry point: DOMContentLoaded → init()
// ════════════════════════════════════════════════════════════════════════════
import { els, $ } from "./dom/dom.js";
import { searchArtist } from "./api/api.js";
import {
  loadHistory, setupFilterToggles, setupNodeSearch, setupPathPanel,
  setupHeroPathFinder, setupHeroModeSwitch,
  createGeniusAc, attachGeniusAutocomplete,
  loadArtistFromUrl, copyShareableLink, openNodeSearch, clearCanvas,
  hideArtistSidebar, hideCandidatePicker, setupKeyboard, fitView,
  setupSearchModal, setupSeedCard, setupHelpOverlay, setupLoadMoreCollabs,
  renderChips, exportGraphPng, setupThemeToggle
} from "./ui/index.js";
import { clearFocus } from "./vis-adapter/index.js";
import { checkAuth, initLogout } from "./api/auth.js";
import { setupCanvasDecorator, startCanvasDecorator } from "./dom/canvas-decorator.js";


export function init() {
  const missingCritical = [];
  if (!els.heroForm) missingCritical.push("heroForm");
  if (!els.heroInput) missingCritical.push("heroInput");
  if (missingCritical.length) {
    throw new Error(`[init] Missing required DOM element(s): ${missingCritical.join(", ")}. App cannot start.`);
  }

  // IDEA-23: applies prefers-color-scheme before anything else paints — the
  // page's CSP has no 'unsafe-inline' for scripts, so this can't run any
  // earlier than the bundle itself (see ui/theme.js for why there's no
  // inline pre-paint script).
  setupThemeToggle();

  loadHistory();
  renderChips();
  setupFilterToggles();
  setupKeyboard();
  setupNodeSearch();
  setupPathPanel();
  setupHeroPathFinder();
  setupHeroModeSwitch();
  setupSearchModal();
  setupSeedCard();
  setupHelpOverlay();
  setupLoadMoreCollabs();

  // ТЗ-D8: idle starfield shown while #network is empty (first visit /
  // after clearCanvas). Mounted once, then just toggled via opacity.
  setupCanvasDecorator();
  startCanvasDecorator();

  // ТЗ-D8: a single search field now serves both the first-visit modal and
  // the ⌘K/rail-icon search over an already-loaded graph — one input, one
  // autocomplete instance (the old hero+dock duplication is gone).
  const heroAc    = $("hero-ac");
  const heroGacFn = createGeniusAc();

  if (heroAc) {
    attachGeniusAutocomplete(els.heroInput, heroAc, name => {
      els.heroInput.value = name;
      searchArtist(name, false, true);
    }, heroGacFn);
  }

  els.heroForm.addEventListener("submit", e => {
    e.preventDefault();
    heroAc?.classList.remove("open");
    searchArtist(els.heroInput.value, false, true);
  });

  if (els.chips) {
    els.chips.addEventListener("click", e => {
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
    els.brand.addEventListener("click", clearCanvas);
  } else {
    console.warn("[init] .brand element not found; brand-click-to-clear disabled.");
  }

  if (els.sidebarClose) {
    els.sidebarClose.addEventListener("click", () => { hideArtistSidebar(); clearFocus(); });
  } else {
    console.warn("[init] sidebarClose element not found; sidebar close button disabled.");
  }

  els.candidateClose?.addEventListener("click", hideCandidatePicker);
  els.candidateOverlay?.addEventListener("click", e => {
    if (e.target === els.candidateOverlay) hideCandidatePicker();
  });

  els.btnClearGraph ?.addEventListener("click", clearCanvas);
  els.btnCopyLink   ?.addEventListener("click", copyShareableLink);
  els.btnExportPng  ?.addEventListener("click", exportGraphPng);
  els.btnFitView    ?.addEventListener("click", fitView);

  $("btn-node-search")?.addEventListener("click", openNodeSearch);

  loadArtistFromUrl();
  checkAuth();
  initLogout();
  els.heroInput.focus();
}

window.addEventListener("DOMContentLoaded", init);
