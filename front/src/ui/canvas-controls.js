import { State, MOTION, COLOR, visAnimation } from "../state/state.js";
import { placeholderFor, proxiedImageUrl } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { searchArtist, showMoreCollaborations } from "../api/api.js";
import {
  clearFocus,
  resetCanvasToEmpty,
  networkOptions,
  isCompareModeActive,
  exitCompareMode,
  selectNode,
} from "../vis-adapter/index.js";
import { drawEdges } from "../vis-adapter/edge-render.js";
import { drawContours } from "../vis-adapter/bubble-contours.js";
import { clearPathHighlight } from "../api/analytics-client.js";
import { startCanvasDecorator } from "../dom/canvas-decorator.js";
import { showToast, hideToast } from "./toast.js";
import { updateShareableUrl } from "./history.js";
import {
  isSearchModalOpen,
  closeSearchModal,
  openSearchModal,
  isPathPanelOpen,
  closePathPanel,
  closeNodeSearch,
  openNodeSearch,
} from "./modals.js";
import { hideArtistSidebar } from "./sidebar.js";
import { hideCandidatePicker } from "./candidate-picker.js";
import { isSettingsPanelOpen, closeSettingsPanel } from "./settings-panel.js";
import { renderEmptyState } from "./canvas-states.js";
import { navigateToSurface, SURFACE_GRAPH } from "./router.js";

export function setupFilterToggles() {
  function makeToggle(role, btns) {
    const buttons = btns.filter(Boolean);
    if (!buttons.length) return;

    function syncButtons() {
      const isActive = State.activeFilters.has(role);
      buttons.forEach((btn) => btn.classList.toggle("active", isActive));
    }

    buttons.forEach((btn) => {
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
  makeToggle("featured", [els.canvasFilterFeatured, els.heroFilterFeatured]);
  makeToggle("producer", [els.canvasFilterProducer, els.heroFilterProducer]);
  makeToggle("writer", [els.canvasFilterWriter, els.heroFilterWriter]);
}

export function setupBubbleSetsToggle() {
  if (!els.btnBubbleSets) return;
  function sync() {
    els.btnBubbleSets.classList.toggle("active", State.bubbleSetsEnabled === true);
    els.btnBubbleSets.setAttribute("aria-pressed", String(State.bubbleSetsEnabled === true));
  }
  els.btnBubbleSets.addEventListener("click", () => {
    State.bubbleSetsEnabled = !State.bubbleSetsEnabled;
    sync();
    if (State.network) State.network.redraw();
  });
  sync();
}

export function setupSeedCard() {
  if (!els.seedCard) return;
  els.seedCard.addEventListener("click", () => {
    focusSeed();
  });
}

export function setupLoadMoreCollabs() {
  if (!els.truncationBanner) return;
  els.truncationBanner.addEventListener("click", showMoreCollaborations);
}

export function updateTruncationBanner() {
  if (!els.truncationBanner) return;

  if (!State.truncated) {
    els.truncationBanner.hidden = true;
    return;
  }

  const text =
    `Showing top ${State.shownSongCount} collaborations — there may be more. ` +
    `Click to show ${State.shownSongCount} more.`;
  els.truncationBanner.title = text;
  els.truncationBanner.setAttribute("aria-label", text);

  els.truncationBanner.hidden = false;
}

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
  const open = () => els.helpOverlay.classList.add("show");
  const close = () => els.helpOverlay.classList.remove("show");
  els.helpBtn.addEventListener("click", open);
  els.helpClose?.addEventListener("click", close);
  els.helpOverlay.addEventListener("click", (e) => {
    if (e.target === els.helpOverlay) close();
  });
}

export function fitView() {
  if (State.network) State.network.fit({ animation: visAnimation(MOTION.camera) });
}

export function focusSeed() {
  if (State.network && State.currentSeedId != null) {
    State.network.focus(State.currentSeedId, {
      scale: 1.2,
      locked: false,
      animation: visAnimation(MOTION.camera),
    });
    clearFocus();
  }
}

let _hubFocusIndex = -1;
function _keyboardHubIds() {
  const hubs = [...State.expandedNodes].sort((a, b) => a - b);
  if (State.currentSeedId != null) hubs.unshift(State.currentSeedId);
  return hubs;
}

export function focusNextHub(direction) {
  if (!State.network) return;
  if (isCompareModeActive()) {
    exitCompareMode();
    return;
  }
  const hubs = _keyboardHubIds();
  if (!hubs.length) return;

  if (State.selectedNodeId != null) {
    const idx = hubs.indexOf(State.selectedNodeId);
    if (idx !== -1) _hubFocusIndex = idx;
  }

  _hubFocusIndex = (((_hubFocusIndex + direction) % hubs.length) + hubs.length) % hubs.length;
  const id = hubs[_hubFocusIndex];
  State.network.focus(id, { scale: 1.2, locked: false, animation: visAnimation(MOTION.camera) });
  clearFocus();
  selectNode(id);
}

export function _resetHubFocusIndex() {
  _hubFocusIndex = -1;
}

export function zoomIn() {
  if (!State.network) return;
  State.network.moveTo({
    scale: State.network.getScale() * 1.25,
    animation: visAnimation(MOTION.med),
  });
}

export function zoomOut() {
  if (!State.network) return;
  State.network.moveTo({
    scale: State.network.getScale() * 0.8,
    animation: visAnimation(MOTION.med),
  });
}

function _graphExportSlug() {
  const seedNode =
    State.currentSeedId != null ? State.graphNodes.find((n) => n.id === State.currentSeedId) : null;
  const rawName = seedNode?.name || els.heroInput.value || "graph";
  return (
    rawName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "graph"
  );
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
  _downloadBlob(blob, `six-feat-${_graphExportSlug()}.png`);
}

export function buildGraphExportData() {
  const seedNode =
    State.currentSeedId != null ? State.graphNodes.find((n) => n.id === State.currentSeedId) : null;
  return {
    seed: seedNode?.name ?? null,
    seedId: State.currentSeedId ?? null,
    exportedAt: new Date().toISOString(),
    nodes: State.graphNodes.map((n) => ({
      id: n.id,
      name: n.name,
      imageUrl: n.imageUrl || null,
      geniusUrl: n.geniusUrl || null,
      isSeed: !!n.isSeed,
    })),
    edges: State.graphEdges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      weight: e.weight,
      dominantRole: e.dominantRole,
      collaboration_count: e.collaboration_count ?? null,
      songs: e.songs || [],
    })),
  };
}

export function exportGraphJson() {
  if (!State.graphNodes.length) {
    showToast("Nothing to export yet — build a graph first.", 2400);
    return;
  }
  const data = buildGraphExportData();
  const dateStr = data.exportedAt.slice(0, 10);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  _downloadBlob(blob, `six-feat-${_graphExportSlug()}-${dateStr}.json`);
}

const EXPORT_MIN_SETTLE_MS = 150;
const EXPORT_IMAGE_TIMEOUT_MS = 30000;
export function buildShadowNodes(nodeItems, graphNodes, positions) {
  const proxyUrls = [];
  const shadowNodes = nodeItems.map((n) => {
    const graphNode = graphNodes.find((g) => g.id === n.id);
    const placeholder = placeholderFor(graphNode?.name, graphNode?.isSeed);
    const image = graphNode?.imageUrl ? proxiedImageUrl(graphNode.imageUrl) : placeholder;
    if (graphNode?.imageUrl) proxyUrls.push(image);
    const pos = positions[n.id];
    return {
      ...n,
      shape: "circularImage",
      image,
      brokenImage: placeholder,
      x: pos ? pos.x : n.x,
      y: pos ? pos.y : n.y,
      fixed: { x: true, y: true },
    };
  });
  return { shadowNodes, proxyUrls };
}

export function waitForImages(urls, timeoutMs = EXPORT_IMAGE_TIMEOUT_MS) {
  const minDelay = new Promise((resolve) => setTimeout(resolve, EXPORT_MIN_SETTLE_MS));
  if (!urls.length) return minDelay;

  const loaders = urls.map(
    (url) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = resolve;
        img.onerror = resolve;
        img.src = url;
      }),
  );
  const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));

  return Promise.all([minDelay, Promise.race([Promise.all(loaders), timeout])]);
}

const EXPORT_WIDTH = 2400;
const EXPORT_HEIGHT = 1500;
const EXPORT_FIT_MARGIN = 140;
const EXPORT_FIT_MAX_SCALE = 3;
export function _computeFitView(positions, nodeIds, canvasW, canvasH, margin = EXPORT_FIT_MARGIN) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const id of nodeIds) {
    const p = positions[id];
    if (!p) continue;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { position: { x: 0, y: 0 }, scale: 1 };

  const width = Math.max(maxX - minX, 1) + margin * 2;
  const height = Math.max(maxY - minY, 1) + margin * 2;
  const scale = Math.min(canvasW / width, canvasH / height, EXPORT_FIT_MAX_SCALE);
  return { position: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, scale };
}

export function _drawExportBackground(ctx) {
  const canvas = ctx.canvas;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLOR.ink;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

export function exportGraphPng() {
  if (!State.network || !State.nodesDS || !State.edgesDS || !els.network?.querySelector("canvas")) {
    showToast("Nothing to export yet — build a graph first.", 2400);
    return;
  }

  const positions = State.network.getPositions();
  const { shadowNodes, proxyUrls } = buildShadowNodes(
    State.nodesDS.get(),
    State.graphNodes,
    positions,
  );

  const holder = document.createElement("div");
  holder.style.cssText = `position:fixed; left:-99999px; top:0; width:${EXPORT_WIDTH}px; height:${EXPORT_HEIGHT}px;`;
  document.body.appendChild(holder);

  const shadowNetwork = new vis.Network(
    holder,
    { nodes: new vis.DataSet(shadowNodes), edges: new vis.DataSet(State.edgesDS.get()) },
    { ...networkOptions(), physics: false },
  );

  shadowNetwork.on("beforeDrawing", _drawExportBackground);
  shadowNetwork.on("beforeDrawing", drawContours);
  shadowNetwork.on("beforeDrawing", drawEdges);

  const cleanup = () => {
    shadowNetwork.destroy();
    holder.remove();
  };

  waitForImages(proxyUrls).then(() => {
    const prevNetwork = State.network;
    State.network = shadowNetwork;
    const { position, scale } = _computeFitView(
      positions,
      State.graphNodes.map((n) => n.id),
      EXPORT_WIDTH,
      EXPORT_HEIGHT,
    );
    shadowNetwork.moveTo({ position, scale, animation: false });
    shadowNetwork.redraw();
    State.network = prevNetwork;

    const canvas = holder.querySelector("canvas");
    canvas.toBlob((blob) => {
      cleanup();
      if (!blob) {
        showToast("PNG export failed.", 2400);
        return;
      }
      downloadPngBlob(blob);
    }, "image/png");
  });
}

export function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    const inInput = tag === "INPUT" || tag === "TEXTAREA";

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      els.nodeSearchOverlay.classList.contains("show") ? closeNodeSearch() : openNodeSearch();
      return;
    }

    if (e.key === "Escape") {
      if (isCompareModeActive()) {
        exitCompareMode();
        return;
      }
      if (els.helpOverlay?.classList.contains("show")) {
        els.helpOverlay.classList.remove("show");
        return;
      }
      if (els.candidateOverlay?.classList.contains("show")) {
        hideCandidatePicker();
        return;
      }
      if (isSettingsPanelOpen()) {
        closeSettingsPanel();
        return;
      }
      if (els.nodeSearchOverlay.classList.contains("show")) {
        closeNodeSearch();
        return;
      }
      if (State.hasRendered && isSearchModalOpen()) {
        closeSearchModal();
        return;
      }
      if (isPathPanelOpen()) {
        closePathPanel();
        return;
      }
      if (State.pathHighlight) {
        clearPathHighlight();
        return;
      }
      focusSeed();
      return;
    }

    if (inInput) return;

    if (
      (e.key === "ArrowRight" || e.key === "ArrowLeft") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      focusNextHub(e.key === "ArrowRight" ? 1 : -1);
      return;
    }

    switch (e.key) {
      case "f":
      case "F":
        fitView();
        break;
      case "+":
      case "=":
        zoomIn();
        break;
      case "-":
      case "_":
        zoomOut();
        break;
      case "?":
        els.helpOverlay?.classList.add("show");
        break;
    }
  });
}

function openFullSearchFromEmpty() {
  State.hasRendered = false;
  openSearchModal();
}

export function clearCanvas() {
  if (isCompareModeActive()) exitCompareMode({ silent: true });
  _resetHubFocusIndex();
  resetCanvasToEmpty();
  els.status.hidden = true;
  if (els.truncationBanner) els.truncationBanner.hidden = true;
  if (els.scanStatusBadge) els.scanStatusBadge.hidden = true;
  startCanvasDecorator();
  renderEmptyState(els.canvasState, { onAction: openFullSearchFromEmpty });
  els.heroInput.value = "";
  hideToast();
  hideArtistSidebar();
  hideCandidatePicker();
  els.pathPanel.classList.remove("show");
  if (els.hopChain) els.hopChain.innerHTML = "";
  const url = new URL(window.location.href);
  url.search = "";
  history.replaceState(null, "", url.toString());
  navigateToSurface(SURFACE_GRAPH, { replace: true });
}

export function goHome() {
  clearCanvas();
  openFullSearchFromEmpty();
}

export function updateStatus(graph) {
  const seedId = State.currentSeedId;
  const seedNode = seedId != null ? State.graphNodes.find((n) => n.id === seedId) : null;
  const name = graph.seed || seedNode?.name || els.heroInput.value || "—";

  if (els.seedCardName) {
    els.seedCardName.textContent = name;
    els.seedCardName.title = name;
  }
  if (els.seedCardAvatar) {
    const src = seedNode?.imageUrl || placeholderFor(name, true);
    els.seedCardAvatar.src = src;
    els.seedCardAvatar.alt = name;
    els.seedCardAvatar.onerror = () => {
      els.seedCardAvatar.onerror = null;
      els.seedCardAvatar.src = placeholderFor(name, true);
    };
  }
}

const RATE_LIMIT_WARN_RATIO = 0.2;
let _rateLimitWarned = false;

export function updateRateLimitIndicator(remaining, limit) {
  if (!els.rateLimitBadge) return;
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return;

  els.rateLimitBadge.title = `${remaining}/${limit} requests remaining this window`;
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
