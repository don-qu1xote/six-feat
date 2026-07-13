// ════════════════════════════════════════════════════════════════════════════
// ui/canvas-controls.js — Viewport controls (fit/zoom/focus-seed), keyboard
//                         shortcuts, seed card + help overlay, role-filter
//                         toggles, clearCanvas (ТЗ-D8), updateStatus
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { placeholderFor } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { searchArtist, showMoreCollaborations } from "../api/api.js";
import { clearFocus, destroyNetwork, networkOptions } from "../vis-adapter/index.js";
import { clearPathHighlight } from "../api/analytics-client.js";
import { startCanvasDecorator } from "../dom/canvas-decorator.js";
import { runHeroGraphTransition } from "../dom/transition.js";
import { showToast, hideToast } from "./toast.js";
import { updateShareableUrl } from "./history.js";
import {
  isSearchModalOpen, closeSearchModal, openSearchModal,
  isPathPanelOpen, closePathPanel,
  closeNodeSearch, openNodeSearch
} from "./modals.js";
import { hideArtistSidebar } from "./sidebar.js";
import { hideCandidatePicker } from "./candidate-picker.js";

// ════════════════════════════════════════════════════════════════════════════
// Role filter toggles
// ════════════════════════════════════════════════════════════════════════════

// [SF-WEB-21] The mutate/refetch core used to live only inside
// setupFilterToggles' click closures — pulled out so the command palette's
// "Toggle X filter" rows (ui/modals.js::_commands) can trigger the exact
// same behaviour a button click always did, instead of duplicating it.
export function toggleRoleFilter(role) {
  if (State.activeFilters.has(role)) {
    if (State.activeFilters.size <= 1) {
      showToast("At least one role filter must be active.", 2200);
      return;
    }
    State.activeFilters.delete(role);
  } else {
    State.activeFilters.add(role);
  }
  document.querySelectorAll(`[data-role="${role}"]`).forEach(btn => {
    btn.classList.toggle("active", State.activeFilters.has(role));
  });
  updateShareableUrl(els.heroInput.value);
  const artist = (els.heroInput.value || "").trim();
  if (artist) searchArtist(artist, false, true);
}

export function setupFilterToggles() {
  // [SF-WEB-14]/[SF-WEB-22]: each role can have several toggle buttons —
  // the canvas's always-visible .role-filter-segment (restored after
  // SF-WEB-21 wrongly removed it) and the landing hero's own filter row
  // (visible before a graph even exists). Both groups, plus the palette's
  // filter-featured/-producer/-writer commands (ui/modals.js::_commands),
  // read/write the same State.activeFilters — toggleRoleFilter() above
  // already syncs .active on every matching-data-role element regardless
  // of which button (or palette row) triggered it, so this just needs to
  // attach the click listener to each real button.
  function makeToggle(role, btns) {
    const buttons = btns.filter(Boolean);
    buttons.forEach(btn => {
      btn.addEventListener("click", () => toggleRoleFilter(role));
      btn.classList.toggle("active", State.activeFilters.has(role));
    });
  }
  makeToggle("featured", [els.canvasFilterFeatured, els.heroFilterFeatured]);
  makeToggle("producer", [els.canvasFilterProducer, els.heroFilterProducer]);
  makeToggle("writer",   [els.canvasFilterWriter,   els.heroFilterWriter]);
}

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

// [SF-WEB-21] No more standalone #help-btn — "Keyboard shortcuts" is a
// command-palette row (⌘K) now, calling openHelpOverlay() the same as the
// old button click did. The `?` shortcut (setupKeyboard below) and the
// close button/backdrop-click still work exactly as before.
export function openHelpOverlay()  { els.helpOverlay?.classList.add("show"); }
export function closeHelpOverlay() { els.helpOverlay?.classList.remove("show"); }

export function setupHelpOverlay() {
  if (!els.helpOverlay) return;
  els.helpClose?.addEventListener("click", closeHelpOverlay);
  els.helpOverlay.addEventListener("click", e => {
    if (e.target === els.helpOverlay) closeHelpOverlay();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Canvas controls & navigation
// ════════════════════════════════════════════════════════════════════════════

export function fitView() {
  if (State.network) State.network.fit({ animation: { duration: 500, easingFunction: "easeInOutQuad" } });
}

export function focusSeed() {
  if (State.network && State.currentSeedId != null) {
    State.network.focus(State.currentSeedId, { scale: 1.2, locked: false, animation: { duration: 500, easingFunction: "easeInOutQuad" } });
    clearFocus();
  }
}

export function zoomIn() {
  if (!State.network) return;
  State.network.moveTo({ scale: State.network.getScale() * 1.25, animation: { duration: 220, easingFunction: "easeInOutQuad" } });
}

export function zoomOut() {
  if (!State.network) return;
  State.network.moveTo({ scale: State.network.getScale() * 0.8, animation: { duration: 220, easingFunction: "easeInOutQuad" } });
}

// ════════════════════════════════════════════════════════════════════════════
// IDEA-20 — export rendered graph as a PNG (client-only, no backend)
// ════════════════════════════════════════════════════════════════════════════
function downloadPngBlob(blob) {
  const seedNode = State.currentSeedId != null
    ? State.graphNodes.find(n => n.id === State.currentSeedId)
    : null;
  const rawName = seedNode?.name || els.heroInput.value || "graph";
  const slug = rawName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "graph";

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `six-feet-${slug}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// vis-network paints node avatars straight from Genius's CDN without
// requesting CORS, so #network's live <canvas> flips to "tainted" the
// instant the first real photo is drawn on it — and per spec that flag
// never resets, so that canvas can never be handed to toBlob() again
// (SecurityError, in every browser, permanently, once any avatar has
// rendered). The only way to get pixels out is a second, disposable
// vis.Network — same nodes/edges/positions, but every avatar swapped for
// the local placeholder icon (a same-origin data: URI) — since a canvas
// that never draws a cross-origin image never taints in the first place.
export function exportGraphPng() {
  if (!State.network || !State.nodesDS || !State.edgesDS || !els.network?.querySelector("canvas")) {
    showToast("Nothing to export yet — build a graph first.", 2400);
    return;
  }

  const liveCanvas  = els.network.querySelector("canvas");
  const positions   = State.network.getPositions();
  const viewPosition = State.network.getViewPosition();
  const scale       = State.network.getScale();

  const shadowNodes = State.nodesDS.get().map(n => {
    const graphNode = State.graphNodes.find(g => g.id === n.id);
    const img = placeholderFor(graphNode?.name, graphNode?.isSeed);
    const pos = positions[n.id];
    return {
      ...n,
      shape: "circularImage",
      image: img,
      brokenImage: img,
      x: pos ? pos.x : n.x,
      y: pos ? pos.y : n.y,
      fixed: { x: true, y: true }
    };
  });

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

  // Placeholder icons are local data: URIs (near-instant to decode), but
  // vis.Network still loads them through an async Image.onload before its
  // first real (non-blank) redraw — a short settle delay avoids grabbing a
  // frame that was drawn before the icons finished loading.
  setTimeout(() => {
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
  }, 150);
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
      if (els.helpOverlay?.classList.contains("show"))      { closeHelpOverlay();   return; }
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
      case "?": openHelpOverlay(); break;
    }
  });
}


// ════════════════════════════════════════════════════════════════════════════
// ТЗ-D8 — clearCanvas (was resetToHero)
// ────────────────────────────────────────────────────────────────────────────
// Раньше это скрывало .graph-view и показывало отдельную .hero "страницу".
// Теперь canvas всегда на сцене — мы просто уничтожаем граф, возвращаем
// decorator-анимацию и открываем search-modal поверх пустого canvas. Никакого
// fade/scale между "страницами": .canvas-chrome никогда не скрывается целиком,
// меняется только её содержимое (status прячется, граф очищается).
// ════════════════════════════════════════════════════════════════════════════
export function clearCanvas() {
  destroyNetwork();
  els.status.hidden = true;
  if (els.truncationBanner) els.truncationBanner.hidden = true;
  startCanvasDecorator();
  els.heroInput.value = "";
  hideToast();
  hideArtistSidebar();
  hideCandidatePicker();
  els.pathPanel.classList.remove("show");
  if (els.hopChain) els.hopChain.innerHTML = "";
  history.replaceState(null, "", window.location.pathname);

  // ТЗ-D8: same FLIP/View-Transitions morph as initGraphOnCanvas, just run
  // in reverse — the search-wrap "flies back" from the rail icon to its
  // centred modal position instead of an abrupt show/hide.
  runHeroGraphTransition(() => {
    openSearchModal();
  }, "toHero");
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
