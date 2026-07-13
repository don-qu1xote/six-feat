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
  truncationBanner:       $("truncation-banner"),
  scanStatusBadge: $("scan-status-badge"),
  scanStatusText:  $("scan-status-text"),
  infoBtn:        $("info-btn"),
  infoPopover:    $("info-popover"),
  rateLimitBadge: $("rate-limit-badge"),
  helpBtn:        $("help-btn"),
  helpOverlay:    $("help-overlay"),
  helpClose:      $("help-close"),
  loading:    $("loading"),
  toast:      $("toast"),

  // [SF-WEB-14] Moved off the rail onto their own always-visible canvas
  // segment (see .role-filter-segment) — the rail's #filter-featured/
  // -producer/-writer buttons were the duplicate this ticket removes.
  canvasFilterFeatured: $("canvas-filter-featured"),
  canvasFilterProducer: $("canvas-filter-producer"),
  canvasFilterWriter:   $("canvas-filter-writer"),

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
  btnSearchOpen: $("btn-search-open"),

  // [SF-WEB-14] Compact zoom/fit cluster — the one control cluster the
  // redesign keeps directly on the canvas. #btn-fit-view moved here from
  // the rail (same id, same click handler in main.js); zoom-in/out/focus
  // never had a visible button before (only +/-/Esc keyboard shortcuts).
  canvasZoomCluster: $("canvas-zoom-cluster"),
  btnZoomIn:    $("btn-zoom-in"),
  btnZoomOut:   $("btn-zoom-out"),
  btnFitView:   $("btn-fit-view"),
  btnFocusSeed: $("btn-focus-seed"),

  // [SF-WEB-14] The other canvas-level cluster: role filters, always
  // visible (not tucked inside the rail's hover-to-expand icon stack).
  roleFilterSegment: $("role-filter-segment"),

  // [SF-WEB-14] Object action bar — mini-actions for the currently selected
  // node (expand / focus / open on Genius / pin), shown above the companion
  // panel instead of as global rail buttons. Populated per-node by
  // ui/sidebar.js::showArtistSidebar, hidden by hideArtistSidebar/
  // showEdgeSidebar (these actions only make sense for a single artist).
  objectActionBar:  $("object-action-bar"),
  objActionExpand:  $("obj-action-expand"),
  objActionFocus:   $("obj-action-focus"),
  objActionGenius:  $("obj-action-genius"),
  objActionPin:     $("obj-action-pin"),

  // [SF-WEB-12] companionPanel is the one shared card — #artist-sidebar and
  // #path-panel (below) are now plain content sections inside it, shown one
  // at a time, instead of two independently-styled floating panels.
  companionPanel: $("companion-panel"),

  artistSidebar:  $("artist-sidebar"),
  sidebarAvatar:  $("sidebar-avatar"),
  sidebarName:    $("sidebar-name"),
  sidebarMeta:    $("sidebar-meta"),
  sidebarTracks:  $("sidebar-tracks"),
  // [SF-WEB-12] Static tiles (index.html) — sidebar.js used to create these
  // on the fly via ensureTile(); now they always exist, just hidden/shown.
  sidebarRoleBreakdownTile: $("sidebar-rolebreakdown-tile"),
  sidebarRoleChips:         $("sidebar-role-chips"),
  sidebarPathTile:          $("sidebar-path-tile"),
  sidebarPathTrack:         $("sidebar-path-track"),
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
