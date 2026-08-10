import { State, ROLE_ICON, setPathHighlight } from "../state/state.js";
import { escapeHtml, placeholderFor } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import {
  initGraphOnCanvas,
  initNetwork,
  initPathNetwork,
  placePathNodes,
  computeNodeSizes,
  clearGraphForPathSearch,
  highlightEdgePair,
} from "../vis-adapter/index.js";
import {
  buildNodeState,
  buildEdgeState,
  cacheNodeCollaborations,
  computeNodeDominantRoles,
  refreshNodeDimBorders,
} from "../graph.js";
import { highlightPath } from "../api/analytics-client.js";
import { showToast, showRetryToast } from "./toast.js";
import { updateStatus } from "./canvas-controls.js";
import { showEdgeSidebarByPathEdgeId } from "./sidebar.js";
import { apiFetch, isTransientStatus, messageForStatus, redirectToLogin } from "../api/net.js";
import { showLoading } from "./loading.js";

function wrapRoleIconGraph(roleIconUseString) {
  return `<svg class="role-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">${roleIconUseString}</svg>`;
}

export async function runServerPath(fromParam, toParam, opts = {}) {
  const chainEl = opts.chainEl ?? els.hopChain;
  const loadingMessage = opts.loadingMessage;

  if (State.pathInFlight) {
    if (State._pathAbortController) State._pathAbortController.abort();
  }
  State._pathAbortController = new AbortController();
  const signal = State._pathAbortController.signal;
  State.pathInFlight = true;

  showLoading(true, null, loadingMessage);
  if (chainEl) chainEl.innerHTML = "";

  const roles = [...State.activeFilters].join(",");
  const url = `/api/v1/graph/path?from=${encodeURIComponent(fromParam)}&to=${encodeURIComponent(toParam)}&roles=${encodeURIComponent(roles)}`;

  try {
    const res = await apiFetch(url, { signal });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}

    if (res.status === 401) {
      redirectToLogin(showToast, data, {
        notSignedInMessage: "Sign in with Genius to search for collaboration paths.",
        tokenInvalidDelay: 1200,
      });
      return;
    }

    if (!res.ok || !data || data.error) {
      let msg = data?.message || "No path found between these artists.";
      let retry = null;
      if (isTransientStatus(res.status)) {
        msg = messageForStatus(res.status, {
          503: "Genius is temporarily unavailable — please try again in a minute, recovery is underway.",
        });
        retry = () => runServerPath(fromParam, toParam, opts);
      } else if (data?.error === "resolve_failed" && msg.includes("ambiguous")) {
        msg =
          msg.replace(/^'(from|to)': /, "") +
          " — please select an artist from the suggestions dropdown.";
      }
      retry ? showRetryToast(msg, retry) : showToast(msg);
      return;
    }

    if (data.nodes?.length) {
      clearGraphForPathSearch();
      mergePathData(data);
    }

    const path = data.path || [];
    if (!path.length) {
      showRetryToast("No path found.", () => runServerPath(fromParam, toParam, opts));
      return;
    }

    setPathHighlight(path);
    highlightPath(path);

    const nameById = {};
    State.graphNodes.forEach((n) => {
      nameById[n.id] = n.name;
    });
    (data.nodes || []).forEach((n) => {
      nameById[n.id] = n.name ?? n.label ?? "";
    });

    renderHopChain(path, data.edges || [], data.nodes || [], nameById, chainEl);
  } catch (err) {
    if (err.name === "AbortError") return;
    const msg = "Request failed: " + (err.message || "network error");
    err.transient
      ? showRetryToast(msg, () => runServerPath(fromParam, toParam, opts))
      : showToast(msg);
  } finally {
    State._pathAbortController = null;
    State.pathInFlight = false;
    showLoading(false);
  }
}

export function mergePathData(data) {
  const existingNodeIds = new Set(State.graphNodes.map((n) => n.id));
  const existingEdgeKeys = new Set(State.graphEdges.map((e) => e.id));

  const nameById = {};

  const pathNodeIds = data.path || [];
  const newSeedId =
    State.currentSeedId == null && pathNodeIds.length ? pathNodeIds[0] : State.currentSeedId;

  for (const n of data.nodes || []) {
    nameById[n.id] = n.name ?? n.label ?? "";
    if (!existingNodeIds.has(n.id)) {
      const ns = buildNodeState(n, newSeedId, existingNodeIds, data);
      State.graphNodes.push(ns);
    }
  }

  for (const e of data.edges || []) {
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    const key = `${lo}_${hi}`;
    if (!existingEdgeKeys.has(key)) {
      State.graphEdges.push(buildEdgeState(e));
    }
  }

  computeNodeSizes();
  cacheNodeCollaborations();
  computeNodeDominantRoles();
  refreshNodeDimBorders();

  if (!State.hasRendered) {
    initGraphOnCanvas();
    State.hasRendered = true;
  }

  if (!State.network) {
    State.currentSeedId = newSeedId;
    State.graphNodes.forEach((n) => {
      n.isSeed = n.id === newSeedId;
    });

    if (pathNodeIds.length >= 2) {
      const canvasSize = {
        width: els.network?.clientWidth,
        height: els.network?.clientHeight,
      };
      const { targets, fromPos } = placePathNodes(pathNodeIds, canvasSize);
      initPathNetwork(nameById, targets, fromPos);
    } else {
      initNetwork(newSeedId, nameById);
    }

    const seedNode = State.graphNodes.find((n) => n.id === newSeedId);
    if (seedNode) updateStatus({ seed: seedNode.name });
  }
}

export function renderHopChain(path, edges, nodes, nameById, targetEl = els.hopChain) {
  if (!targetEl || path.length < 2) {
    if (targetEl) targetEl.innerHTML = "";
    return;
  }

  const nodeMap = new Map();
  State.graphNodes.forEach((n) => nodeMap.set(n.id, n));
  nodes.forEach((n) => {
    if (!nodeMap.has(n.id))
      nodeMap.set(n.id, { id: n.id, name: n.name ?? n.label ?? "", imageUrl: n.image || "" });
  });

  const edgeMap = new Map();
  edges.forEach((e) => {
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    edgeMap.set(`${lo}_${hi}`, e);
  });
  State.graphEdges.forEach((e) => {
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    if (!edgeMap.has(`${lo}_${hi}`)) edgeMap.set(`${lo}_${hi}`, e);
  });

  const rows = [];
  for (let i = 0; i < path.length; i++) {
    const id = path[i];
    const node = nodeMap.get(id);
    const name = node?.name || nameById[id] || String(id);
    const img = node?.imageUrl || placeholderFor(name, false);

    let songsHtml = "";
    let connectorHtml = "";
    if (i < path.length - 1) {
      const nextId = path[i + 1];
      const lo = Math.min(id, nextId);
      const hi = Math.max(id, nextId);
      const edge = edgeMap.get(`${lo}_${hi}`);
      const edgeId = edge?.id || `${lo}_${hi}`;
      const songList = edge?.songs || [];
      const titles = songList
        .slice(0, 3)
        .map((s) => (typeof s === "string" ? s : s.song || s.title || "Untitled"));
      const trackCount = edge?.weight ?? songList.length;
      const role = (edge?.dominant_role || edge?.dominantRole || "primary").toLowerCase();
      const roleSlug = role.replace(/[^a-z0-9]/g, "");
      const icon = wrapRoleIconGraph(ROLE_ICON[role] || "");
      const iconHtml = icon ? `<span class="hop-role-icon">${icon}</span>` : "";
      const songsTitle = titles.length ? ` title="${escapeHtml(titles.join(", "))}"` : "";

      if (titles.length)
        songsHtml = `<div class="hop-songs truncate" data-edge-id="${escapeHtml(String(edgeId))}" role="button" tabindex="0"${songsTitle}>${iconHtml}${titles.map((t) => escapeHtml(t)).join(" · ")}</div>`;
      else if (icon)
        songsHtml = `<div class="hop-songs truncate" data-edge-id="${escapeHtml(String(edgeId))}" role="button" tabindex="0">${iconHtml}</div>`;

      const roleWord = role !== "primary" ? role : "collab";
      connectorHtml =
        `<div class="path-edge-connector hop-connector" data-edge-id="${escapeHtml(String(edgeId))}" role="button" tabindex="0" title="${escapeHtml(roleWord)} · ${trackCount} track${trackCount === 1 ? "" : "s"}">` +
        `<span class="path-edge-label role-chip--${roleSlug}">${iconHtml}${trackCount}</span>` +
        `</div>`;
    }

    rows.push(
      `<div class="hop-row">` +
        `<img class="hop-avatar" src="${escapeHtml(img)}" data-fallback="${escapeHtml(placeholderFor(name, false))}" alt="" />` +
        `<div class="hop-info"><div class="hop-name truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</div>${songsHtml}</div>` +
        `</div>` +
        connectorHtml,
    );
  }
  targetEl.innerHTML = rows.join("");

  const nameByIdForSidebar = nameById;
  targetEl.querySelectorAll("[data-edge-id]").forEach((el) => {
    const onActivate = () => {
      const edgeId = el.getAttribute("data-edge-id");
      if (edgeId == null) return;
      highlightEdgePair(edgeId);
      showEdgeSidebarByPathEdgeId(edgeId, nameByIdForSidebar);
    };
    el.addEventListener("click", onActivate);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    });
  });
}
