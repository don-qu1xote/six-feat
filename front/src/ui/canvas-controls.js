// ════════════════════════════════════════════════════════════════════════════
// ui/canvas-controls.js — Viewport controls (fit/zoom/focus-seed), keyboard
//                         shortcuts, seed card + help overlay, role-filter
//                         toggles, clearCanvas (ТЗ-D8), updateStatus
// ════════════════════════════════════════════════════════════════════════════
import { State, MOTION, visAnimation } from "../state/state.js";
import { placeholderFor } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { searchArtist, showMoreCollaborations } from "../api/api.js";
import { clearFocus, resetCanvasToEmpty, networkOptions, isCompareModeActive, exitCompareMode } from "../vis-adapter/index.js";
import { clearPathHighlight } from "../api/analytics-client.js";
import { startCanvasDecorator } from "../dom/canvas-decorator.js";
import { showToast, hideToast } from "./toast.js";
import { updateShareableUrl } from "./history.js";
import {
  isSearchModalOpen, closeSearchModal, openSearchModal,
  isPathPanelOpen, closePathPanel,
  closeNodeSearch, openNodeSearch
} from "./modals.js";
import { hideArtistSidebar } from "./sidebar.js";
import { hideCandidatePicker } from "./candidate-picker.js";
import { renderEmptyState } from "./canvas-states.js";
import { navigateToSurface, SURFACE_GRAPH } from "./router.js";

// ════════════════════════════════════════════════════════════════════════════
// Role filter toggles
// ════════════════════════════════════════════════════════════════════════════

export function setupFilterToggles() {
  // Каждая роль теперь может иметь несколько кнопок-переключателей —
  // те же в .rail (доступны после построения графа) и новые в
  // .include-roles-row на лендинге (видны до построения графа). Обе группы
  // читают/пишут один и тот же State.activeFilters, так что достаточно
  // держать классы .active в синхроне между всеми кнопками одной роли.
  function makeToggle(role, btns) {
    const buttons = btns.filter(Boolean);
    if (!buttons.length) return;

    function syncButtons() {
      const isActive = State.activeFilters.has(role);
      buttons.forEach(btn => btn.classList.toggle("active", isActive));
    }

    buttons.forEach(btn => {
      btn.addEventListener("click", () => {
        if (State.activeFilters.has(role)) {
          if (State.activeFilters.size <= 1) {
            showToast("At least one role filter must be active.", 2200);
            return;
          }
          State.activeFilters.delete(role);
        } else {
          State.activeFilters.add(role);
        }
        syncButtons();
        updateShareableUrl(els.heroInput.value);
        const artist = (els.heroInput.value || "").trim();
        if (artist) searchArtist(artist, false, true);
      });
    });
    syncButtons();
  }
  // [SF-WEB-14] els.filterFeatured/-Producer/-Writer (the rail's own role
  // filters) were removed — canvasFilterFeatured/-Producer/-Writer (the new
  // always-visible canvas segment) took over their spot in this list.
  makeToggle("featured", [els.canvasFilterFeatured, els.heroFilterFeatured]);
  makeToggle("producer", [els.canvasFilterProducer, els.heroFilterProducer]);
  makeToggle("writer",   [els.canvasFilterWriter,   els.heroFilterWriter]);
}

// Note: active role-filters are no longer duplicated in the status card —
// they're already visible via active state on the rail icons (ТЗ-D2).

// ════════════════════════════════════════════════════════════════════════════
// Seed card & help overlay
// ════════════════════════════════════════════════════════════════════════════

export function setupSeedCard() {
  if (!els.seedCard) return;
  els.seedCard.addEventListener("click", () => {
    focusSeed();
  });
}

// IDEA-22: seed-only "show more collaborations" action — re-fetches the
// current seed's graph with a bumped ?limit= and merges it into the canvas.
// [style pass] The truncation-banner icon IS the trigger now (was a
// separately-built action button nested inside an expanded pill).
export function setupLoadMoreCollabs() {
  if (!els.truncationBanner) return;
  els.truncationBanner.addEventListener("click", showMoreCollaborations);
}

// ════════════════════════════════════════════════════════════════════════════
// IDEA-50: FG-truncation indicator — shown only when the last graph response
// reported truncated=true (the songs-limit-fg fetch hit its cap, so some
// collaborations for a dense seed are very likely missing). Reflects
// State.truncated/shownSongCount/songLimit (see state.js::setTruncation),
// which is refreshed on every replaceGraph/mergeGraph via finalizeGraphState
// — including after "Show more collaborations" merges a bigger-limit fetch,
// so the banner updates/hides itself once the new limit isn't truncated.
// ════════════════════════════════════════════════════════════════════════════
export function updateTruncationBanner() {
  if (!els.truncationBanner) return;

  if (!State.truncated) {
    els.truncationBanner.hidden = true;
    return;
  }

  // [style pass] Collapsed to a single plus-icon button — clicking it calls
  // showMoreCollaborations() directly (see setupLoadMoreCollabs above), so
  // this text only needs to reach the user via hover/focus, through the
  // same native `title` idiom #help-btn already uses for its own tooltip.
  const text = `Showing top ${State.shownSongCount} collaborations — there may be more. `
    + `Click to show ${State.shownSongCount} more.`;
  els.truncationBanner.title = text;
  els.truncationBanner.setAttribute("aria-label", text);

  els.truncationBanner.hidden = false;
}

// ════════════════════════════════════════════════════════════════════════════
// SF-WEB-05: inline data-completeness indicator — depth/partial/background-
// enrichment status, driven by /api/v1/status/stream events (see
// pollEnrichment in api.js, which calls this on every SSE message). Lives
// next to seed-card in #status (over the canvas) rather than only in the
// companion — it needs to be visible even with nothing selected, since a
// partial graph is a property of the whole canvas, not of one node/edge.
// Hidden once depth reaches Full (2) — the data IS complete at that point,
// nothing left to explain.
// ════════════════════════════════════════════════════════════════════════════
export function updateScanStatus(status) {
  if (!els.scanStatusBadge) return;
  const depth = status?.depth ?? 0;

  if (depth >= 2) {
    els.scanStatusBadge.hidden = true;
    return;
  }

  const enriching = !!status?.enriching;
  const text = enriching
    ? "Background scan running — more collaborations may still appear."
    : "Partial data — some collaborations may be missing.";

  if (els.scanStatusText) els.scanStatusText.textContent = enriching ? "Scanning…" : "Partial";
  els.scanStatusBadge.title = text;
  els.scanStatusBadge.setAttribute("aria-label", text);
  els.scanStatusBadge.classList.toggle("scan-status-badge--enriching", enriching);
  els.scanStatusBadge.hidden = false;
}

export function setupHelpOverlay() {
  if (!els.helpBtn || !els.helpOverlay) return;
  const open  = () => els.helpOverlay.classList.add("show");
  const close = () => els.helpOverlay.classList.remove("show");
  els.helpBtn.addEventListener("click", open);
  els.helpClose?.addEventListener("click", close);
  els.helpOverlay.addEventListener("click", e => {
    if (e.target === els.helpOverlay) close();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Canvas controls & navigation
// ════════════════════════════════════════════════════════════════════════════

// [SF-WEB-47] Every network.fit()/focus()/moveTo() below used to hardcode
// its own {duration, easingFunction} literal and never checked
// prefers-reduced-motion at all — visAnimation(MOTION.x) covers both.
export function fitView() {
  if (State.network) State.network.fit({ animation: visAnimation(MOTION.camera) });
}

export function focusSeed() {
  if (State.network && State.currentSeedId != null) {
    State.network.focus(State.currentSeedId, { scale: 1.2, locked: false, animation: visAnimation(MOTION.camera) });
    clearFocus();
  }
}

export function zoomIn() {
  if (!State.network) return;
  State.network.moveTo({ scale: State.network.getScale() * 1.25, animation: visAnimation(MOTION.med) });
}

export function zoomOut() {
  if (!State.network) return;
  State.network.moveTo({ scale: State.network.getScale() * 0.8, animation: visAnimation(MOTION.med) });
}

// ════════════════════════════════════════════════════════════════════════════
// IDEA-20 — export rendered graph as a PNG (client-only, no backend)
// SF-WEB-04 — export the underlying graph data as JSON, same rail, same kit
// ════════════════════════════════════════════════════════════════════════════

// Shared by both export formats — "seed name" is the one piece of the
// filename either format cares about identifying.
function _graphExportSlug() {
  const seedNode = State.currentSeedId != null
    ? State.graphNodes.find(n => n.id === State.currentSeedId)
    : null;
  const rawName = seedNode?.name || els.heroInput.value || "graph";
  return rawName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "graph";
}

function _downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadPngBlob(blob) {
  _downloadBlob(blob, `six-feet-${_graphExportSlug()}.png`);
}

// SF-WEB-04: stable, plain-JSON-serializable snapshot of the current graph —
// deliberately NOT a raw dump of State.graphNodes/graphEdges (those carry
// internal bookkeeping fields — _isNew, _dimBorder, _accent, _dominantRole,
// _expandParent, etc. — that are rendering/layout implementation detail, not
// graph data, and would make the export format an accidental, unstable
// coupling to internal state shape). The field set mirrors what
// buildNodeState/buildEdgeState (graph.js) treat as the graph's actual
// public data — the same fields the backend's /api/v1/graph response
// carries, not vis-adapter's derived visuals.
export function buildGraphExportData() {
  const seedNode = State.currentSeedId != null
    ? State.graphNodes.find(n => n.id === State.currentSeedId)
    : null;
  return {
    seed:       seedNode?.name ?? null,
    seedId:     State.currentSeedId ?? null,
    exportedAt: new Date().toISOString(),
    nodes: State.graphNodes.map(n => ({
      id:        n.id,
      name:      n.name,
      imageUrl:  n.imageUrl || null,
      geniusUrl: n.geniusUrl || null,
      isSeed:    !!n.isSeed,
    })),
    edges: State.graphEdges.map(e => ({
      id:                  e.id,
      from:                e.from,
      to:                  e.to,
      weight:              e.weight,
      dominantRole:        e.dominantRole,
      collaboration_count: e.collaboration_count ?? null,
      songs:               e.songs || [],
      collaborations:      e.collaborations || [],
    })),
  };
}

export function exportGraphJson() {
  if (!State.graphNodes.length) {
    showToast("Nothing to export yet — build a graph first.", 2400);
    return;
  }
  const data = buildGraphExportData();
  const dateStr = data.exportedAt.slice(0, 10); // YYYY-MM-DD
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  _downloadBlob(blob, `six-feet-${_graphExportSlug()}-${dateStr}.json`);
}

// vis-network paints node avatars straight from Genius's CDN without
// requesting CORS, so #network's live <canvas> flips to "tainted" the
// instant the first real photo is drawn on it — and per spec that flag
// never resets, so that canvas can never be handed to toBlob() again
// (SecurityError, in every browser, permanently, once any avatar has
// rendered). The only way to get pixels out is a second, disposable
// vis.Network — same nodes/edges/positions, but every avatar routed
// through this origin instead of Genius's CDN directly.
//
// [SF-WEB-32] Real photos now go through /api/v1/image?url=... (SF-API-12
// — a same-origin proxy that re-serves the allowlisted Genius CDN bytes
// from THIS origin) instead of always falling back to the local
// placeholder — that was the only way to avoid tainting before this proxy
// existed. A same-origin image never taints the canvas, so the shadow
// network can now draw real photos and still export cleanly. Nodes with
// no real Genius photo (graphNode.imageUrl empty — already normalized to
// "" for Genius's own default-avatar placeholder, see graph.js) still get
// the local placeholderFor icon, same as before. brokenImage is always
// the local placeholder either way — if the proxy itself 400s/502s,
// vis.js falls back to it exactly like any other broken image load.
const EXPORT_MIN_SETTLE_MS   = 150; // unchanged baseline for placeholder-only exports
// [SF-WEB-32 follow-up] 3000ms wasn't enough for a dense graph: every photo
// is now an extra same-origin round trip (browser -> /api/v1/image -> Genius
// CDN) instead of a direct CDN fetch, and browsers cap concurrent
// connections per origin at ~6 — so a 50-60 node graph queues most of its
// photos behind that cap. Observed in practice: a chunk of nodes still
// mid-flight got cut off at 3s and fell back to their placeholder icon.
// 3000 -> 10000 gives queued requests enough headroom to actually finish
// instead of racing the clock; a slow export is still strictly better than
// a wrong one, and every proxied response is cached long-term (see
// image_proxy_handler.cpp's Cache-Control), so repeat exports of the same
// graph are fast regardless of this value.
const EXPORT_IMAGE_TIMEOUT_MS = 10000; // upper bound on waiting for proxied photos

// Pure data-shaping step (no vis.Network/DOM involved) — kept separate so
// it's directly testable. Returns the same per-node shape exportGraphPng
// always built, plus the list of proxy URLs it used (so the caller knows
// what to wait on before redraw/toBlob).
export function buildShadowNodes(nodeItems, graphNodes, positions) {
  const proxyUrls = [];
  const shadowNodes = nodeItems.map(n => {
    const graphNode   = graphNodes.find(g => g.id === n.id);
    const placeholder = placeholderFor(graphNode?.name, graphNode?.isSeed);
    const image = graphNode?.imageUrl
      ? `/api/v1/image?url=${encodeURIComponent(graphNode.imageUrl)}`
      : placeholder;
    if (graphNode?.imageUrl) proxyUrls.push(image);
    const pos = positions[n.id];
    return {
      ...n,
      shape: "circularImage",
      image,
      brokenImage: placeholder,
      x: pos ? pos.x : n.x,
      y: pos ? pos.y : n.y,
      fixed: { x: true, y: true }
    };
  });
  return { shadowNodes, proxyUrls };
}

// [SF-WEB-32] Resolves once every proxied photo has either loaded or
// failed (never rejects — one broken photo shouldn't block the whole
// export) or after timeoutMs, whichever comes first — plus the same fixed
// settle delay the old placeholder-only export always waited out (vis.js
// still loads even local data: URIs through an async Image.onload before
// its first real redraw). Preloading through our OWN Image objects (same
// URL vis.js's internal circularImage loader will request) means the
// browser's HTTP cache already has the bytes by the time vis.js asks for
// them — waiting on vis.js's own internal loader isn't possible, it's a
// private implementation detail, so this is the practical way to know
// "the pixels are actually available" before grabbing a frame.
export function waitForImages(urls, timeoutMs = EXPORT_IMAGE_TIMEOUT_MS) {
  const minDelay = new Promise(resolve => setTimeout(resolve, EXPORT_MIN_SETTLE_MS));
  if (!urls.length) return minDelay;

  const loaders = urls.map(url => new Promise(resolve => {
    const img = new Image();
    img.onload  = resolve;
    img.onerror = resolve;
    img.src = url;
  }));
  const timeout = new Promise(resolve => setTimeout(resolve, timeoutMs));

  return Promise.all([minDelay, Promise.race([Promise.all(loaders), timeout])]);
}

export function exportGraphPng() {
  if (!State.network || !State.nodesDS || !State.edgesDS || !els.network?.querySelector("canvas")) {
    showToast("Nothing to export yet — build a graph first.", 2400);
    return;
  }

  const liveCanvas  = els.network.querySelector("canvas");
  const positions   = State.network.getPositions();
  const viewPosition = State.network.getViewPosition();
  const scale       = State.network.getScale();

  const { shadowNodes, proxyUrls } = buildShadowNodes(State.nodesDS.get(), State.graphNodes, positions);

  const holder = document.createElement("div");
  holder.style.cssText = `position:fixed; left:-99999px; top:0; width:${liveCanvas.clientWidth}px; height:${liveCanvas.clientHeight}px;`;
  document.body.appendChild(holder);

  const shadowNetwork = new vis.Network(
    holder,
    { nodes: new vis.DataSet(shadowNodes), edges: new vis.DataSet(State.edgesDS.get()) },
    { ...networkOptions(), physics: false }
  );
  shadowNetwork.moveTo({ position: viewPosition, scale, animation: false });

  const cleanup = () => { shadowNetwork.destroy(); holder.remove(); };

  waitForImages(proxyUrls).then(() => {
    shadowNetwork.redraw();
    const canvas = holder.querySelector("canvas");
    canvas.toBlob(blob => {
      cleanup();
      if (!blob) {
        showToast("PNG export failed.", 2400);
        return;
      }
      downloadPngBlob(blob);
    }, "image/png");
  });
}

// ════════════════════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════════════════════════════

export function setupKeyboard() {
  document.addEventListener("keydown", e => {
    const tag     = document.activeElement?.tagName;
    const inInput = tag === "INPUT" || tag === "TEXTAREA";

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      els.nodeSearchOverlay.classList.contains("show") ? closeNodeSearch() : openNodeSearch();
      return;
    }

    if (e.key === "Escape") {
      // [SF-WEB-47] Highest priority: Compare mode takes over click
      // semantics while active, so Escape's first job is handing them back,
      // ahead of any overlay/panel that happens to also be open.
      if (isCompareModeActive())                            { exitCompareMode();       return; }
      if (els.helpOverlay?.classList.contains("show"))      { els.helpOverlay.classList.remove("show"); return; }
      if (els.candidateOverlay?.classList.contains("show")) { hideCandidatePicker(); return; }
      if (els.nodeSearchOverlay.classList.contains("show")) { closeNodeSearch();      return; }
      if (State.hasRendered && isSearchModalOpen())         { closeSearchModal();     return; }
      if (isPathPanelOpen())                                { closePathPanel();       return; }
      if (State.pathHighlight)                              { clearPathHighlight();   return; }
      focusSeed(); return;
    }

    if (inInput) return;

    switch (e.key) {
      case "f": case "F": fitView(); break;
      case "+": case "=": zoomIn();  break;
      case "-": case "_": zoomOut(); break;
      case "?": els.helpOverlay?.classList.add("show"); break;
    }
  });
}


// ════════════════════════════════════════════════════════════════════════════
// ТЗ-D8 — clearCanvas (was resetToHero)
// ────────────────────────────────────────────────────────────────────────────
// Раньше это скрывало .graph-view и показывало отдельную .hero "страницу".
// Затем — уничтожало граф и открывало search-modal поверх пустого canvas
// (морф "назад в hero"). [SF-WEB-19] Модалка/переход на главную убраны: Clear
// теперь ТОЛЬКО чистит холст и остаётся на странице графа (rail/status-чром
// не трогаются, body.view-graph не снимается) — единый empty-state
// (renderEmptyState) показывается прямо на канвасе вместо повторного
// показа лендинг-модалки. Открыть поиск снова — обычный rail-докнутый
// поиск (та же кнопка, что и над уже нарисованным графом), не полноэкранная
// домашняя модалка.
// ════════════════════════════════════════════════════════════════════════════
// [fix] resetCanvasToEmpty() (called by clearCanvas() below) deliberately
// KEEPS State.hasRendered true — SF-WEB-19's "Clear stays on the graph
// page" design assumes the canvas is still "on scene". But the empty-state
// action and goHome() both open the FULL-SCREEN (non-docked) landing
// modal — conceptually "back to the start" — and graph.js's render
// pipeline only calls initGraphOnCanvas() (which is what closes the
// search modal again, via forceCloseSearchModal()) `if (!State.
// hasRendered)`. Leaving the flag true meant that gate never fired on the
// next successful search, so the modal stayed open on top of the newly
// drawn graph (reported: "после Map it поиск не сворачивается"). Reset it
// here so the next search is treated as a genuine first render again.
function openFullSearchFromEmpty() {
  State.hasRendered = false;
  openSearchModal();
}

export function clearCanvas() {
  // [SF-WEB-47] Same reasoning as resetExpansionState clearing
  // State.compareMode — an in-progress first/second pick doesn't carry
  // meaning onto the graph resetCanvasToEmpty() is about to leave behind.
  if (isCompareModeActive()) exitCompareMode({ silent: true });
  resetCanvasToEmpty();
  els.status.hidden = true;
  if (els.truncationBanner) els.truncationBanner.hidden = true;
  if (els.scanStatusBadge) els.scanStatusBadge.hidden = true;
  startCanvasDecorator();
  // [fix] Was docked search (`openSearchModal({ docked: true })`, per
  // SF-WEB-19's original "Clear never leaves the graph page" framing) —
  // the docked flow's own history/autocomplete dropdown isn't styled for
  // being shown over a blank canvas (reported as an unstyled floating
  // list). The full-screen landing modal already exists and is properly
  // styled for exactly this "nothing on the canvas yet" moment, so the
  // empty-state card's own action now opens that instead (see
  // openFullSearchFromEmpty()'s own comment for why hasRendered resets).
  renderEmptyState(els.canvasState, { onAction: openFullSearchFromEmpty });
  els.heroInput.value = "";
  hideToast();
  hideArtistSidebar();
  hideCandidatePicker();
  els.pathPanel.classList.remove("show");
  if (els.hopChain) els.hopChain.innerHTML = "";
  // [fix] Was `history.replaceState(null, "", window.location.pathname)`,
  // which drops the #/graph hash router.js (SF-WEB-25) owns — clicking
  // .brand/Clear left the URL bare (http://host/ instead of .../#/graph).
  // Harmless while "graph" stays the only real surface (a missing hash
  // still resolves to it), but it broke the router's own invariant that
  // the URL always reflects what's showing, and would misbehave the
  // moment a second surface (game mode) exists. Still clear the shareable
  // query string the same way as before, but hand the hash back to
  // navigateToSurface() — the same call every other surface change goes
  // through — instead of hand-rolling a bare replaceState.
  const url = new URL(window.location.href);
  url.search = "";
  history.replaceState(null, "", url.toString());
  navigateToSurface(SURFACE_GRAPH, { replace: true });
}

// [fix] .brand (the logo) used to call clearCanvas() directly — same as
// the rail's "Clear graph" button — which (per SF-WEB-19) only clears the
// canvas and stays on the graph page with an empty-state card. Reported
// separately: clicking the logo is expected to act like a real "back to
// home" action, landing straight on the full-screen search experience,
// not an intermediate empty-state card the user has to click through.
// Composes the same clearCanvas() reset with openFullSearchFromEmpty()
// (same hasRendered-reset reasoning as the empty-state card's own action
// above — without it, the modal doesn't close after the next search).
export function goHome() {
  clearCanvas();
  openFullSearchFromEmpty();
}

export function updateStatus(graph) {
  const seedId   = State.currentSeedId;
  const seedNode = seedId != null ? State.graphNodes.find(n => n.id === seedId) : null;
  const name     = graph.seed || seedNode?.name || els.heroInput.value || "—";

  if (els.seedCardName) {
    els.seedCardName.textContent = name;
    els.seedCardName.title = name;  // native tooltip when ellipsis-truncated
  }
  if (els.seedCardAvatar) {
    const src = seedNode?.imageUrl || placeholderFor(name, true);
    els.seedCardAvatar.src = src;
    els.seedCardAvatar.alt = name;
    els.seedCardAvatar.onerror = () => { els.seedCardAvatar.onerror = null; els.seedCardAvatar.src = placeholderFor(name, true); };
  }
}

// IDEA-21: soft indicator for the per-client rate limit (X-RateLimit-*
// headers, read in api.js). The warning toast fires once per drop below
// the threshold rather than on every request, so it doesn't spam.
const RATE_LIMIT_WARN_RATIO = 0.2;
let _rateLimitWarned = false;

export function updateRateLimitIndicator(remaining, limit) {
  if (!els.rateLimitBadge) return;
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return;

  els.rateLimitBadge.textContent = `${remaining}/${limit} req/s`;
  els.rateLimitBadge.hidden = false;

  const low = remaining / limit <= RATE_LIMIT_WARN_RATIO;
  els.rateLimitBadge.classList.toggle("rate-limit-badge--low", low);

  if (low) {
    if (!_rateLimitWarned) {
      _rateLimitWarned = true;
      showToast("Approaching the request rate limit — slow down a bit.", 3500, true);
    }
  } else {
    _rateLimitWarned = false;
  }
}
