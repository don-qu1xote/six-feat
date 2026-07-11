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
  makeToggle("featured", [els.filterFeatured, els.heroFilterFeatured]);
  makeToggle("producer", [els.filterProducer, els.heroFilterProducer]);
  makeToggle("writer",   [els.filterWriter,   els.heroFilterWriter]);
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
// SF-WEB-10: the trigger is the truncation-banner's own action button, built
// dynamically by updateTruncationBanner — so this listens for clicks
// delegated through the banner rather than binding to a static element.
export function setupLoadMoreCollabs() {
  if (!els.truncationBanner) return;
  els.truncationBanner.addEventListener("click", e => {
    if (e.target.closest("#truncation-banner-action")) {
      showMoreCollaborations();
    }
  });
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
    els.truncationBanner.querySelector("#truncation-banner-action")?.remove();
    return;
  }

  if (els.truncationBannerText) {
    els.truncationBannerText.textContent =
      `Showing top ${State.shownSongCount} collaborations — there may be more.`;
  }

  let action = els.truncationBanner.querySelector("#truncation-banner-action");
  if (!action) {
    action = document.createElement("button");
    action.type = "button";
    action.id = "truncation-banner-action";
    action.className = "truncation-banner-action";
    els.truncationBanner.appendChild(action);
  }
  action.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><use href="#icon-plus"/></svg> Show ${State.shownSongCount} more`;

  els.truncationBanner.hidden = false;
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
