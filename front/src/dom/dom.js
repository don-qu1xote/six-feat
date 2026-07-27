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
  // [SF-WEB-19] Unified empty/loading/error surface — see ui/canvas-states.js.
  canvasState: $("canvas-state"),
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

  // IDEA-41 + [design: 3-way switch]: segmented Explore/Connect/Game mode
  // switch above the hero search, replacing the old btnFindPathToggle/
  // heroPathPanel toggle+panel. [design: challenge setup on landing]
  // Game now gets its own in-place panel too, same as Explore/Connect —
  // navigation to #/game only happens once "Start challenge" is pressed
  // inside it (see path-panel.js's setupHeroModeSwitch).
  heroModeSwitch:       $("hero-mode-switch"),
  heroModeTabExplore:   $("hero-mode-tab-explore"),
  heroModeTabConnect:   $("hero-mode-tab-connect"),
  heroModeTabGame:      $("hero-mode-tab-game"),
  heroModePanelExplore: $("hero-mode-panel-explore"),
  heroModePanelConnect: $("hero-mode-panel-connect"),
  heroModePanelGame:    $("hero-mode-panel-game"),

  heroPathFromInput:  $("hero-path-from-input"),
  heroPathToInput:    $("hero-path-to-input"),
  btnHeroRunPath:     $("btn-hero-run-path"),
  btnHeroSwapPath:    $("btn-hero-swap-path"),
  btnHeroClearPath:   $("btn-hero-clear-path"),
  heroHopChain:       $("hero-hop-chain"),

  // [design: challenge setup on landing] Game panel's own "vs" duel —
  // see game/connect.js's setupGameLandingPanel.
  heroGameFromInput:      $("hero-game-from-input"),
  heroGameFromAc:         $("hero-game-from-ac"),
  heroGameFromAvatar:     $("hero-game-from-avatar"),
  heroGameToInput:        $("hero-game-to-input"),
  heroGameToAc:           $("hero-game-to-ac"),
  heroGameToAvatar:       $("hero-game-to-avatar"),
  btnHeroGameSwap:      $("btn-hero-game-swap"),   // [SF-GAME-59]
  btnHeroStartChallenge:  $("btn-hero-start-challenge"),

  // [design: Today's Challenge + or pick a rival] Real GET .../challenge?
  // daily=1 + GET .../leaderboard?challenge_id= data — see
  // game/connect.js's setupGameLandingPanel.
  heroGameDaily:          $("hero-game-daily"),
  heroGameDailyFromAvatar: $("hero-game-daily-from-avatar"),
  heroGameDailyFromName:  $("hero-game-daily-from-name"),
  heroGameDailyToAvatar:  $("hero-game-daily-to-avatar"),
  heroGameDailyToName:    $("hero-game-daily-to-name"),
  heroGameDailyPair:    $("hero-game-daily-pair"),   // [SF-GAME-60]
  heroGameDailyState:   $("hero-game-daily-state"),
  btnHeroDailyRetry:    $("btn-hero-daily-retry"),
  btnHeroPlayDaily:       $("btn-hero-play-daily"),
  heroGameRivals:         $("hero-game-rivals"),
  heroGameRivalsList:     $("hero-game-rivals-list"),
  heroGameDivider:        $("hero-game-divider"),

  themeToggle: $("theme-toggle"),

  btnClearGraph: $("btn-clear-graph"),
  btnCopyLink:   $("btn-copy-link"),
  btnExportPng:  $("btn-export-png"),
  btnExportJson: $("btn-export-json"),
  btnFindPath:   $("btn-find-path"),
  // [SF-WEB-47] Graph-native Compare mode toggle — see vis-adapter/compare-mode.js.
  btnCompareMode: $("btn-compare-mode"),
  // [SF-WEB-61] Manual BubbleSet toggle — see ui/canvas-controls.js::setupBubbleSetsToggle.
  btnBubbleSets: $("btn-bubble-sets"),
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

  // [SF-WEB-27] Object action bar — mini-actions for the currently selected
  // node (expand / focus / open on Genius), the last row of #sidebar-body's
  // grid (was a separately-floating bar above the whole companion panel,
  // plus a now-removed standalone Genius button — merged into this one
  // row). Populated per-node by ui/sidebar.js:: showArtistSidebar, hidden
  // by hideArtistSidebar/showEdgeSidebar (these actions only make sense for
  // a single artist). [SF-WEB-47] The fourth action (pin) is gone — it
  // only ever existed to gate Compare's old pinned-pair selection.
  objectActionBar:  $("object-action-bar"),
  objActionExpand:  $("obj-action-expand"),
  objActionFocus:   $("obj-action-focus"),
  objActionGenius:  $("obj-action-genius"),

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
  // [SF-WEB-33] Edge-only tile — both endpoints of the selected edge.
  sidebarEndpointsTile:  $("sidebar-endpoints-tile"),
  sidebarEndpointsTrack: $("sidebar-endpoints-track"),
  sidebarClose:   $("sidebar-close"),

  candidateOverlay: $("candidate-overlay"),
  candidateList:    $("candidate-list"),
  candidateClose:   $("candidate-close"),

  pathPanel:      $("path-panel"),
  pathPanelClose: $("path-panel-close"),
  pathFromInput:  $("path-from-input"),
  pathToInput:    $("path-to-input"),
  btnSwapPath:    $("btn-swap-path"),
  btnRunPath:     $("btn-run-path"),
  btnClearPath:   $("btn-clear-path"),
  hopChain:       $("hop-chain"),

  // [SF-WEB-20] Compare mode — common collaborators of two picked artists
  // (see btnCompareMode above / vis-adapter/compare-mode.js).
  comparePanel:      $("compare-panel"),
  comparePanelClose: $("compare-panel-close"),
  compareTitle:      $("compare-title"),
  // [fix] The two compared artists themselves, shown above the trace.
  comparePair:       $("compare-pair"),
  // [fix] The trace between them (renderHopChain, reused from the
  // six-degrees path result) — shown above the shared-collaborators list.
  compareTraceLabel: $("compare-trace-label"),
  compareHopChain:   $("compare-hop-chain"),
  compareList:       $("compare-list"),

  nodeSearchOverlay: $("node-search-overlay"),
  nodeSearchInput:   $("node-search-input"),
  nodeSearchResults: $("node-search-results"),
  nodeSearchStatus:  $("node-search-status"),
  btnNodeSearch:     $("btn-node-search"),

  // F-43: hidden-but-accessible DOM twin of the canvas graph.
  graphA11yNodeList:         $("graph-a11y-node-list"),
  graphA11yNeighborList:     $("graph-a11y-neighbor-list"),
  graphA11yNeighborsHeading: $("graph-a11y-neighbors-heading"),

  // [SF-GAME-01] "Connect" game surface (#/game) — see src/game/connect.js.
  // [design: Split · Graph + Track] graph explorer (left) + "Your line" panel (right).
  connectSurface:       $("connect-surface"),
  connectTitleStart:       $("connect-title-start"),
  connectTitleGoal:        $("connect-title-goal"),
  connectParPill:          $("connect-par-pill"),
  connectParValue:         $("connect-par-value"),
  connectRivalPill:        $("connect-rival-pill"),
  connectRivalText:        $("connect-rival-text"),
  connectTimerValue:    $("connect-timer-value"),
  connectHopsValue:     $("connect-hops-value"),
  connectPoleFrom:      $("connect-pole-from"),      // [SF-GAME-55]
  connectPoleFromName:  $("connect-pole-from-name"),
  connectPoleTo:        $("connect-pole-to"),
  connectPoleToName:    $("connect-pole-to-name"),
  connectProgress:      $("connect-progress"),      // [SF-GAME-54]
  connectPips:          $("connect-pips"),
  connectProgressLabel: $("connect-progress-label"),
  connectEndpoints:     $("connect-endpoints"),
  connectEndpointsSummary: $("connect-endpoints-summary"),
  connectStartBtn:      $("connect-start-btn"),   // [SF-GAME-47]
  connectStartInput:    $("connect-start-input"),
  connectStartAc:       $("connect-start-ac"),
  connectGoalInput:     $("connect-goal-input"),
  connectGoalAc:        $("connect-goal-ac"),
  connectCanvas:        $("connect-canvas"),
  connectStageEmpty:    $("connect-stage-empty"),
  connectZoomIn:        $("connect-zoom-in"),
  connectZoomOut:       $("connect-zoom-out"),
  connectFit:           $("connect-fit"),
  connectAddInput:      $("connect-add-input"),
  connectAddAc:         $("connect-add-ac"),
  connectAddBtn:        $("connect-add-btn"),
  connectLineList:      $("connect-line-list"),
  connectBrowse:        $("connect-browse"),
  connectBrowseLabel:   $("connect-browse-label"),
  connectBrowseChips:   $("connect-browse-chips"),
  connectUndo:          $("connect-undo"),
  connectReset:         $("connect-reset"),
  connectGiveUp:        $("connect-give-up"),
  connectShare:         $("connect-share"),
  connectLockin:        $("connect-lockin"),
  connectFinishLabel:   $("connect-finish-label"),
  connectFinishScore:   $("connect-finish-score"),
  connectFinishDetail:  $("connect-finish-detail"),
  connectLeaderboard:   $("connect-leaderboard"),

  // [design: routed game windows] Leaderboard + Profile screens — see
  // src/game/game-windows.js.
  gameLeaderboardSurface: $("game-leaderboard-surface"),
  lbTabSeason:          $("lb-tab-season"),
  lbTabChallenge:       $("lb-tab-challenge"),
  lbScopeLabel:         $("lb-scope-label"),
  lbList:               $("lb-list"),
  lbEmpty:              $("lb-empty"),
  gameProfileSurface:   $("game-profile-surface"),
  profileSignedOut:     $("profile-signed-out"),
  profileCard:          $("profile-card"),
  pfAvatar:             $("pf-avatar"),
  pfName:               $("pf-name"),
  pfRank:               $("pf-rank"),
  pfElo:                $("pf-elo"),
  pfGames:              $("pf-games"),
  pfBadges:             $("pf-badges"),
  pfBadgeList:          $("pf-badge-list"),
  pfBadgesEmpty:        $("pf-badges-empty"),
  pfHistory:            $("pf-history"),
  pfHistoryEmpty:       $("pf-history-empty"),
  // [design: ЛК] Personal-cabinet actions — rename + share.
  pfEditName:           $("pf-edit-name"),
  pfShare:              $("pf-share"),

  // [admin] Owner-only panel embedded in the Profile screen — see
  // src/game/game-windows.js (revealed only when /api/v1/game/admin allows).
  adminPanel:           $("admin-panel"),
  adminFromInput:       $("admin-from-input"),
  adminFromAc:          $("admin-from-ac"),
  adminToInput:         $("admin-to-input"),
  adminToAc:            $("admin-to-ac"),
  adminPublishDaily:    $("admin-publish-daily"),
  adminStatus:          $("admin-status"),

  // [game #3] Challenge browser (#/game/challenges).
  gameChallengesSurface: $("game-challenges-surface"),
  chTabAll:             $("ch-tab-all"),
  chTabDaily:           $("ch-tab-daily"),
  chTabCustom:          $("ch-tab-custom"),
  chGrid:               $("ch-grid"),
  chEmpty:              $("ch-empty"),
  chMore:               $("ch-more"),
  // [SF-GAME-46] Поиск челленджа по артисту.
  chSearchInput:        $("ch-search-input"),
  chSearchClear:        $("ch-search-clear"),

  // [game #4] Season & achievements hub (#/game/season).
  gameSeasonSurface:    $("game-season-surface"),
  snName:               $("sn-name"),
  snCountdown:          $("sn-countdown"),
  snYou:                $("sn-you"),
  snProgressFill:       $("sn-progress-fill"),
  snDates:              $("sn-dates"),
  snPodium:             $("sn-podium"),
  snPodiumEmpty:        $("sn-podium-empty"),
  snAchCount:           $("sn-ach-count"),
  snAchHint:            $("sn-ach-hint"),
  snAchGrid:            $("sn-ach-grid")
};
