// ════════════════════════════════════════════════════════════════════════════
// ui/path-result.js — TASK 1: server path endpoint call (runServerPath),
//                      merging the response into graph state (mergePathData),
//                      and rendering the step-by-step hop chain (renderHopChain).
//
// Split out of path-panel.js, which keeps only the panel/hero-finder DOM
// wiring (setupPathPanel/setupHeroModeSwitch/setupHeroPathFinder) and calls
// back into runServerPath here.
// ════════════════════════════════════════════════════════════════════════════
import { State, ROLE_ICON, setPathHighlight } from "../state/state.js";
import { escapeHtml, placeholderFor, graphHash } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import {
  initGraphOnCanvas, initNetwork, initPathNetwork, placePathNodes,
  computeNodeSizes, clearGraphForPathSearch,
  highlightEdgePair
} from "../vis-adapter/index.js";
import {
  buildNodeState, buildEdgeState,
  cacheNodeCollaborations, computeNodeDominantRoles, refreshNodeDimBorders
} from "../graph.js";
import { highlightPath } from "../api/analytics-client.js";
import { showToast, showRetryToast } from "./toast.js";
import { updateStatus } from "./canvas-controls.js";
import { showEdgeSidebarByPathEdgeId } from "./sidebar.js";
import { apiFetch, isTransientStatus, messageForStatus, redirectToLogin } from "../api/net.js";
import { showLoading } from "./loading.js";

function wrapRoleIconGraph(roleIconUseString) {
  // For graph tooltips, edge displays: compact 20×20
  return `<svg class="role-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">${roleIconUseString}</svg>`;
}

// ════════════════════════════════════════════════════════════════════════════
// TASK 1: SERVER PATH ENDPOINT
// ════════════════════════════════════════════════════════════════════════════

// [fix] Was renderLoadingState/renderErrorState into a resultEl embedded
// inside the caller's own panel (.path-result) — reported as the path
// search process feeling "bolted into the window", unlike regular artist
// search, which never shows its loading/error state inside the hero
// search box: it always uses the canvas-wide #loading overlay
// (ui/loading.js::showLoading) for loading and a toast
// (ui/toast.js::showToast/showRetryToast) for errors. runServerPath now
// goes through the exact same two mechanisms, so both search flows read
// as one consistent language instead of two. opts.chainEl still lets
// callers other than .path-panel (the hero Connect panel) render the hop
// chain into their own container via the same renderHopChain markup/CSS
// — that part of the panel (the actual RESULT, not the search process)
// stays inline, unchanged. opts.loadingMessage lets each caller phrase
// the overlay's text with the actual From/To names it already has on hand.
export async function runServerPath(fromParam, toParam, opts = {}) {
  const chainEl = opts.chainEl ?? els.hopChain;
  const loadingMessage = opts.loadingMessage;

  if (State.pathInFlight) {
    // ТЗ-4: abort any in-flight path request before starting a new one.
    if (State._pathAbortController) State._pathAbortController.abort();
  }
  State._pathAbortController = new AbortController();
  const signal = State._pathAbortController.signal;
  State.pathInFlight = true;

  showLoading(true, null, loadingMessage);
  if (chainEl) chainEl.innerHTML = "";

  const roles = [...State.activeFilters].join(",");
  // [ТЗ-5 step 2] fromParam/toParam may already be numeric ids.
  const url   = `/api/v1/graph/path?from=${encodeURIComponent(fromParam)}&to=${encodeURIComponent(toParam)}&roles=${encodeURIComponent(roles)}`;

  try {
    const res  = await apiFetch(url, { signal });
    let data = null;
    try { data = await res.json(); } catch (_) {}

    // [ТЗ-6] No anonymous fallback — redirect to login if not signed in.
    if (res.status === 401) {
      redirectToLogin(showToast, data, {
        notSignedInMessage: "Sign in with Genius to search for collaboration paths.",
        tokenInvalidDelay: 1200,
      });
      return;
    }

    if (!res.ok || !data || data.error) {
      // [ТЗ-5 step 1] For "ambiguous artist name" the backend returns
      // resolve_failed.  Give the user an actionable hint to pick from AC.
      let msg = data?.message || "No path found between these artists.";
      let retry = null;
      if (isTransientStatus(res.status)) {
        msg = messageForStatus(res.status, {
          503: "Genius is temporarily unavailable — please try again in a minute, recovery is underway.",
        });
        retry = () => runServerPath(fromParam, toParam, opts);
      } else if (data?.error === "resolve_failed" && msg.includes("ambiguous")) {
        msg = msg.replace(/^'(from|to)': /, "") +
              " — please select an artist from the suggestions dropdown.";
      }
      retry ? showRetryToast(msg, retry) : showToast(msg);
      return;
    }

    // Очищаем граф перед отрисовкой пути: раньше результат six-degrees
    // поиска подмешивался в уже существующий граф (mergePathData просто
    // добавлял недостающие узлы/рёбра), из-за чего путь терялся среди
    // ранее раскрытых нод. Теперь путь показывается на чистом канвасе.
    if (data.nodes?.length) {
      clearGraphForPathSearch();
      mergePathData(data);
    }

    const path = data.path || [];
    if (!path.length) {
      // [SF-WEB-19] "пустой путь" — one of the three unified error triggers.
      // Retry re-runs the exact same search (harmless if it fails
      // identically, and covers the case where it was a transient blip on
      // the server's own BFS/enrichment side rather than a real dead end).
      showRetryToast("No path found.", () => runServerPath(fromParam, toParam, opts));
      return;
    }

    setPathHighlight(path);
    highlightPath(path);

    const nameById = {};
    State.graphNodes.forEach(n => { nameById[n.id] = n.name; });
    // Also use names from the response directly
    (data.nodes || []).forEach(n => { nameById[n.id] = n.name ?? n.label ?? ""; });

    // Task 1: render hop chain
    renderHopChain(path, data.edges || [], data.nodes || [], nameById, chainEl);

  } catch (err) {
    if (err.name === 'AbortError') return; // пользователь отменил — не показываем ошибку (ТЗ-4).
    // [SF-WEB-19] "сеть" — the third unified error trigger. Retry only for
    // transient (network/502/503) failures, same condition the old
    // showRetryToast call used.
    const msg = "Request failed: " + (err.message || "network error");
    err.transient ? showRetryToast(msg, () => runServerPath(fromParam, toParam, opts)) : showToast(msg);
  } finally {
    State._pathAbortController = null;
    State.pathInFlight = false;
    showLoading(false);
  }
}

// Merge path API response into State.graphNodes / graphEdges + vis datasets
export function mergePathData(data) {
  const existingNodeIds  = new Set(State.graphNodes.map(n => n.id));
  const existingEdgeKeys = new Set(State.graphEdges.map(e => e.id));

  const nameById = {};

  // Раз canvas теперь очищается перед path-поиском (clearGraphForPathSearch),
  // в этой ветке State.network/currentSeedId всегда пустые — выбираем
  // первый узел пути (артист "from") как новый псевдо-seed, чтобы граф
  // центрировался на нём и seed-card в углу показывал корректного
  // артиста вместо устаревших/пустых данных.
  const pathNodeIds = data.path || [];
  const newSeedId = State.currentSeedId == null && pathNodeIds.length
    ? pathNodeIds[0]
    : State.currentSeedId;

  for (const n of (data.nodes || [])) {
    nameById[n.id] = n.name ?? n.label ?? "";
    if (!existingNodeIds.has(n.id)) {
      const ns = buildNodeState(n, newSeedId, existingNodeIds, data);
      State.graphNodes.push(ns);
    }
    // Централити убрана — для уже существующих узлов обновлять нечего.
  }

  for (const e of (data.edges || [])) {
    const lo  = Math.min(e.from, e.to);
    const hi  = Math.max(e.from, e.to);
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
    State.graphNodes.forEach(n => { n.isSeed = (n.id === newSeedId); });

    // SF-WEB-17: a real path (2+ nodes) gets the dedicated readable
    // left-to-right layout (placePathNodes/initPathNetwork) instead of
    // initNetwork's generic physics-stabilized placement — pathNodeIds is
    // exactly the array the layout needs, already resolved above. Anything
    // shorter (defensively — runServerPath already handles the 0-hop
    // same-artist case before calling here) just falls back to initNetwork.
    if (pathNodeIds.length >= 2) {
      const canvasSize = {
        width:  els.network?.clientWidth,
        height: els.network?.clientHeight,
      };
      const { targets, fromPos } = placePathNodes(pathNodeIds, canvasSize);
      initPathNetwork(nameById, targets, fromPos);
    } else {
      initNetwork(newSeedId, nameById);
    }

    // Граф только что был очищен и пересобран заново вокруг artist "from" —
    // это единственная ветка mergePathData, где seed-card действительно
    // должен обновиться.
    const seedNode = State.graphNodes.find(n => n.id === newSeedId);
    if (seedNode) updateStatus({ seed: seedNode.name });
  }
  // clearGraphForPathSearch() always empties State.network before merge is
  // reached (see runServerPath), so the branch above is the only one ever
  // taken — there is no "merge path result into an already-rendered seed
  // graph" case to handle here.

  const newHash = graphHash();
  if (newHash !== State._bfsGraphHash) {
    State._bfsAdj       = null;
    State._bfsGraphHash = newHash;
  }
}

// Task 1: render step-by-step hop chain. targetEl lets callers other than
// the rail's .path-panel (e.g. the hero's Connect panel, IDEA-41) render
// into their own container while reusing this exact markup — defaults to
// the rail's own #hop-chain so existing call sites are unaffected.
export function renderHopChain(path, edges, nodes, nameById, targetEl = els.hopChain) {
  if (!targetEl || path.length < 2) { if (targetEl) targetEl.innerHTML = ""; return; }

  // Build quick node lookup
  const nodeMap = new Map();
  State.graphNodes.forEach(n => nodeMap.set(n.id, n));
  nodes.forEach(n => {
    if (!nodeMap.has(n.id)) nodeMap.set(n.id, { id: n.id, name: n.name ?? n.label ?? "", imageUrl: n.image || "" });
  });

  // Build edge lookup by pair key
  const edgeMap = new Map();
  edges.forEach(e => {
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    edgeMap.set(`${lo}_${hi}`, e);
  });
  State.graphEdges.forEach(e => {
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    if (!edgeMap.has(`${lo}_${hi}`)) edgeMap.set(`${lo}_${hi}`, e);
  });

  const rows = [];
  for (let i = 0; i < path.length; i++) {
    const id   = path[i];
    const node = nodeMap.get(id);
    const name = node?.name || nameById[id] || String(id);
    const img  = node?.imageUrl || placeholderFor(name, false);

    // Songs connecting this node to the next
    let songsHtml = "";
    let connectorHtml = "";
    if (i < path.length - 1) {
      const nextId = path[i + 1];
      const lo     = Math.min(id, nextId);
      const hi     = Math.max(id, nextId);
      const edge   = edgeMap.get(`${lo}_${hi}`);
      const edgeId = edge?.id || `${lo}_${hi}`;
      // Path endpoint returns songs[] (array of title strings or objects)
      const songList = edge?.songs || edge?.collaborations || [];
      const titles   = songList.slice(0, 3).map(s =>
        typeof s === "string" ? s : (s.song || s.title || "Untitled")
      );
      const trackCount = edge?.weight ?? songList.length;
      // [ТЗ-5 step 4] Show role icon from dominant_role field on the edge.
      const role      = (edge?.dominant_role || edge?.dominantRole || "primary").toLowerCase();
      const roleSlug  = role.replace(/[^a-z0-9]/g, "");
      const icon      = wrapRoleIconGraph(ROLE_ICON[role] || "");
      const iconHtml  = icon ? `<span class="hop-role-icon">${icon}</span>` : "";
      const songsTitle = titles.length ? ` title="${escapeHtml(titles.join(", "))}"` : "";

      // ТЗ-205: hop-songs is now clickable — clicking it highlights the edge
      // on canvas and opens the edge sidebar with its tracks, same as
      // clicking the edge directly in the graph.
      // Минимальный вид: только иконка роли (цвет её уже отличает) без
      // текстового слова роли перед списком треков.
      if (titles.length)
        songsHtml = `<div class="hop-songs truncate" data-edge-id="${escapeHtml(String(edgeId))}" role="button" tabindex="0"${songsTitle}>${iconHtml}${titles.map(t => escapeHtml(t)).join(" · ")}</div>`;
      else if (icon)
        songsHtml = `<div class="hop-songs truncate" data-edge-id="${escapeHtml(String(edgeId))}" role="button" tabindex="0">${iconHtml}</div>`;

      // ТЗ-205: connector pill replaces the old "↓" text arrow — reuses the
      // same .path-edge-connector/.path-edge-label + role-chip-- колор
      // system already used elsewhere (unified visual language for roles).
      // Минимальный вид: иконка + число треков, без слова роли.
      const roleWord = role !== "primary" ? role : "collab";
      connectorHtml =
        `<div class="path-edge-connector hop-connector" data-edge-id="${escapeHtml(String(edgeId))}" role="button" tabindex="0" title="${escapeHtml(roleWord)} · ${trackCount} track${trackCount === 1 ? "" : "s"}">` +
        `<span class="path-edge-label role-chip--${roleSlug}">${iconHtml}${trackCount}</span>` +
        `</div>`;
    }

    rows.push(
      `<div class="hop-row">` +
      `<img class="hop-avatar" src="${escapeHtml(img)}" data-fallback="${escapeHtml(placeholderFor(name,false))}" alt="" />` +
      `<div class="hop-info"><div class="hop-name truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</div>${songsHtml}</div>` +
      `</div>` +
      connectorHtml
    );
  }
  targetEl.innerHTML = rows.join("");

  // ТЗ-205: wire up clicks on both the songs pill and the connector pill —
  // both jump to the same edge sidebar / canvas highlight interaction.
  const nameByIdForSidebar = nameById;
  targetEl.querySelectorAll("[data-edge-id]").forEach(el => {
    const onActivate = () => {
      const edgeId = el.getAttribute("data-edge-id");
      if (edgeId == null) return;
      highlightEdgePair(edgeId);
      showEdgeSidebarByPathEdgeId(edgeId, nameByIdForSidebar);
    };
    el.addEventListener("click", onActivate);
    el.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
    });
  });
}
