// ════════════════════════════════════════════════════════════════════════════
// dom.js — DOM element refs (els) and small DOM helpers
// ════════════════════════════════════════════════════════════════════════════

export const $ = id => document.getElementById(id);

export const els = {
  // ТЗ-D8: the modal search prompt (was .hero — now an overlay, not a page)
  searchModal: $("search-modal"),
  heroForm:   $("hero-form"),
  heroInput:  $("hero-input"),
  chips:      $("chips"),
  chipsLabel: $("chips-label"),

  // ТЗ-D8: always-on UI chrome (was .graph-view — no longer a hidden page)
  canvasChrome: $("canvas-chrome"),
  appCanvas:    $("app-canvas"),
  canvasDecorator: $("canvas-decorator"),
  brand:      $("brand"),

  btnRoleFilters: $("btn-role-filters"),
  filterBar:      $("filter-bar"),

  network:    $("network"),
  status:     $("status"),
  seedCard:       $("seed-card"),
  seedCardAvatar: $("seed-card-avatar"),
  seedCardName:   $("seed-card-name"),
  btnLoadMoreCollabs: $("btn-load-more-collabs"),
  truncationBanner:       $("truncation-banner"),
  truncationBannerText:   $("truncation-banner-text"),
  truncationBannerAction: $("truncation-banner-action"),
  infoBtn:        $("info-btn"),
  infoPopover:    $("info-popover"),
  rateLimitBadge: $("rate-limit-badge"),
  helpBtn:        $("help-btn"),
  helpOverlay:    $("help-overlay"),
  helpClose:      $("help-close"),
  loading:    $("loading"),
  toast:      $("toast"),

  filterFeatured: $("filter-featured"),
  filterProducer: $("filter-producer"),
  filterWriter:   $("filter-writer"),

  // Search settings on the landing hero (ТЗ: same logic as the rail's
  // role filters + find path, surfaced before a graph even exists).
  // "Include roles" — всегда видна (не за кнопкой).
  heroFilterFeatured: $("hero-filter-featured"),
  heroFilterProducer: $("hero-filter-producer"),
  heroFilterWriter:   $("hero-filter-writer"),

  // IDEA-41: segmented Explore/Connect mode switch above the hero search,
  // replacing the old btnFindPathToggle/heroPathPanel toggle+panel.
  heroModeSwitch:       $("hero-mode-switch"),
  heroModeTabExplore:   $("hero-mode-tab-explore"),
  heroModeTabConnect:   $("hero-mode-tab-connect"),
  heroModePanelExplore: $("hero-mode-panel-explore"),
  heroModePanelConnect: $("hero-mode-panel-connect"),

  heroPathFromInput:  $("hero-path-from-input"),
  heroPathToInput:    $("hero-path-to-input"),
  btnHeroRunPath:     $("btn-hero-run-path"),
  btnHeroSwapPath:    $("btn-hero-swap-path"),
  btnHeroClearPath:   $("btn-hero-clear-path"),
  heroPathResult:     $("hero-path-result"),
  heroHopChain:       $("hero-hop-chain"),

  themeToggle: $("theme-toggle"),

  btnClearGraph: $("btn-clear-graph"),
  btnCopyLink:   $("btn-copy-link"),
  btnExportPng:  $("btn-export-png"),
  btnFindPath:   $("btn-find-path"),
  btnFitView:    $("btn-fit-view"),
  btnSearchOpen: $("btn-search-open"),

  artistSidebar:  $("artist-sidebar"),
  sidebarAvatar:  $("sidebar-avatar"),
  sidebarName:    $("sidebar-name"),
  sidebarMeta:    $("sidebar-meta"),
  sidebarTracks:  $("sidebar-tracks"),
  sidebarGenius:  $("sidebar-genius-btn"),
  sidebarClose:   $("sidebar-close"),

  candidateOverlay: $("candidate-overlay"),
  candidateList:    $("candidate-list"),
  candidateClose:   $("candidate-close"),

  pathPanel:      $("path-panel"),
  pathPanelClose: $("path-panel-close"),
  pathFromInput:  $("path-from-input"),
  pathToInput:    $("path-to-input"),
  btnRunPath:     $("btn-run-path"),
  btnClearPath:   $("btn-clear-path"),
  pathResult:     $("path-result"),
  hopChain:       $("hop-chain"),

  nodeSearchOverlay: $("node-search-overlay"),
  nodeSearchInput:   $("node-search-input"),
  nodeSearchResults: $("node-search-results"),
  nodeSearchStatus:  $("node-search-status"),
  btnNodeSearch:     $("btn-node-search"),

  // F-43: hidden-but-accessible DOM twin of the canvas graph.
  graphA11yNodeList:         $("graph-a11y-node-list"),
  graphA11yNeighborList:     $("graph-a11y-neighbor-list"),
  graphA11yNeighborsHeading: $("graph-a11y-neighbors-heading")
};
