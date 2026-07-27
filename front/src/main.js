// ════════════════════════════════════════════════════════════════════════════
// main.js — Entry point: DOMContentLoaded → init()
// ════════════════════════════════════════════════════════════════════════════
import { els, $ } from "./dom/dom.js";
import { searchArtist } from "./api/api.js";
import {
  loadHistory, setupFilterToggles, setupNodeSearch, setupPathPanel,
  setupHeroPathFinder, setupHeroModeSwitch,
  createGeniusAc, attachGeniusAutocomplete, closeDropdown,
  loadArtistFromUrl, copyShareableLink, openNodeSearch, clearCanvas, goHome,
  hideArtistSidebar, hideCandidatePicker, setupKeyboard, fitView,
  zoomIn, zoomOut, focusSeed,
  setupSearchModal, setupSeedCard, setupHelpOverlay, setupLoadMoreCollabs,
  renderChips, exportGraphPng, exportGraphJson, setupThemeToggle, setupDockedPanels,
  restoreSurfaceFromUrl, setupBubbleSetsToggle, getCurrentSurface, isGameSurface,
  closeAllDropdowns, onSurfaceChange
} from "./ui/index.js";
import { clearFocus, setupCompareModeToggle } from "./vis-adapter/index.js";
import { checkAuth, initLogout } from "./api/auth.js";
import { setupCanvasDecorator, startCanvasDecorator } from "./dom/canvas-decorator.js";
import { setupConnectMode, setupGameLandingPanel } from "./game/connect.js";
import { setupGameWindows } from "./game/game-windows.js";


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

  // [SF-WEB-25] Restores the active surface (#/graph, #/game — game not
  // built yet) from the URL hash before anything else touches routing/
  // history state below. Current graph behavior is unchanged: a missing or
  // unrecognized hash resolves to the "graph" default, same as before this
  // ticket existed.
  restoreSurfaceFromUrl();

  // [SF-GAME-51] Плавающие слои переживают смену поверхности, потому что
  // живут в общем #overlay-root, а не внутри поверхности (см.
  // ui/overlay-root.js::closeAllDropdowns). Гасим их ОДИН раз здесь, на
  // уровне приложения, а не в каждом onSurfaceChange-подписчике: поверхностей
  // уже шесть, и каждая новая иначе приносила бы этот баг заново.
  onSurfaceChange(closeAllDropdowns);

  loadHistory();
  renderChips();
  setupFilterToggles();
  setupKeyboard();
  // [SF-WEB-24] Registers the three docked-panel surfaces (docked search-
  // modal, node-search overlay, find-path panel) with the shared shell —
  // mutual exclusivity/outside-click — before wiring each one's own
  // content-specific behaviour below.
  setupDockedPanels();
  setupNodeSearch();
  setupPathPanel();
  setupHeroPathFinder();
  setupHeroModeSwitch();
  setupSearchModal();
  setupSeedCard();
  setupHelpOverlay();
  setupLoadMoreCollabs();
  // [SF-WEB-47] Compare's graph-native rail toggle — click two nodes to
  // open the Compare panel for that pair.
  setupCompareModeToggle();
  // [SF-WEB-61] Manual BubbleSet toggle — off by default, user-controlled.
  setupBubbleSetsToggle();
  // [SF-GAME-01] "Connect" game surface (#/game) — wires its endpoint/hop
  // pickers and subscribes to surface changes. No-op if the surface markup
  // isn't present. Called after restoreSurfaceFromUrl() above, so it syncs
  // the initial surface itself.
  setupConnectMode();
  // [design: challenge setup on the landing page] Game's own hero panel —
  // separate from setupConnectMode() above (that one owns the #/game
  // surface itself; this one owns the landing-page entry point into it).
  setupGameLandingPanel();
  // [design: routed game windows] The game's non-play surfaces —
  // #/game/leaderboard and #/game/profile — plus the shared game nav.
  setupGameWindows();

  // ТЗ-D8: idle starfield shown while #network is empty (first visit /
  // after clearCanvas). Mounted once, then just toggled via opacity.
  // [SF-WEB-19] The onboarding card (canvas-controls.js::clearCanvas) is
  // NOT shown here on first visit — only after the user explicitly clears
  // an existing graph. The landing hero modal already is the first-visit
  // onboarding; showing a second one behind it would be redundant (and,
  // before this ticket's own fix, was actually unreachable — the modal
  // has no dismiss path pre-search).
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
    if (heroAc) closeDropdown(heroAc);
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
    // [fix] Was clearCanvas() — the same handler as the rail's dedicated
    // "Clear graph" button — which (SF-WEB-19) deliberately stays on the
    // graph page with an empty-state card. The logo is expected to behave
    // like an actual "back to home" action instead, landing straight on
    // the full-screen search experience. See goHome()'s own comment.
    els.brand.addEventListener("click", goHome);
  } else {
    console.warn("[init] .brand element not found; brand-click-to-home disabled.");
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
  els.btnExportJson ?.addEventListener("click", exportGraphJson);
  els.btnFitView    ?.addEventListener("click", fitView);
  // [SF-WEB-14] Compact zoom/fit cluster.
  els.btnZoomIn     ?.addEventListener("click", zoomIn);
  els.btnZoomOut    ?.addEventListener("click", zoomOut);
  els.btnFocusSeed  ?.addEventListener("click", focusSeed);

  $("btn-node-search")?.addEventListener("click", openNodeSearch);

  loadArtistFromUrl();
  checkAuth();
  initLogout();
  // [fix] Only autofocus the landing hero search when the landing/graph
  // surface is actually the one showing. Deep-linking straight to #/game
  // (a shared challenge link) used to still focus the (now-hidden) hero
  // input, which popped its "recent searches" dropdown over the game
  // surface. The hero input's own autocomplete has a focus->history
  // behaviour; don't trigger it when the hero isn't even visible.
  if (!isGameSurface(getCurrentSurface())) els.heroInput.focus();
}

window.addEventListener("DOMContentLoaded", init);
