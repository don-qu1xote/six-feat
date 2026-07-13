// ════════════════════════════════════════════════════════════════════════════
// api.js — Server communication: searchArtist, _doSearch, pollEnrichment
// ════════════════════════════════════════════════════════════════════════════
import {
  State, SEARCH_DEBOUNCE, setGraphCacheEntry,
  GRAPH_DEFAULT_LIMIT, GRAPH_LOAD_MORE_STEP, GRAPH_MAX_LIMIT
} from "../state/state.js";
import { debounce } from "../state/helpers.js";
import { replaceGraph, mergeGraph } from "../graph.js";
import { showCandidatePicker } from "../ui/index.js";
import { showLoading, showToast, showRetryToast, hideToast, pushHistory, updateShareableUrl, updateRateLimitIndicator } from "../ui/index.js";
import { restoreDefaultColors } from "../vis-adapter/index.js";
import { apiFetch, throwForStatus, redirectToLogin } from "./net.js";

const _searchDebounced = debounce((artist, isExpansion, forceImmediate, limitOverride) => _doSearch(artist, isExpansion, forceImmediate, limitOverride), SEARCH_DEBOUNCE);

// ════════════════════════════════════════════════════════════════════════════
// ENRICHMENT STATUS — SSE
// Opens a single, long-lived Server-Sent Events connection to
// /api/v1/status/stream. The server holds the connection open and pushes a
// JSON event roughly every ~2 s; we close the connection and refresh the
// graph as soon as depth >= 2 (Full-scan complete), so the canvas picks up
// any collaborations discovered during the deep scan.
//
// Since the server no longer closes the stream after a single snapshot,
// `onerror` now only fires on a genuine transport failure (dropped
// connection, proxy timeout, server crash) — reconnect-with-backoff below
// exists purely to recover from that, not as a stand-in for polling.
// ════════════════════════════════════════════════════════════════════════════

export function pollEnrichment(seedId) {
  // Close any previous SSE connection that may still be open.
  if (State._enrichmentPoller) {
    State._enrichmentPoller.close();
    State._enrichmentPoller = null;
  }

  let closed = false;
  let reconnectAttempts = 0;
  const MAX_ATTEMPTS = 5;
  let backoffMs = 500;
  const MAX_BACKOFF = 5000;
  let es = null;
  let timeoutId = null;

  const connect = () => {
    if (closed) return;

    es = new EventSource(`/api/v1/status/stream?id=${seedId}`);

    es.onmessage = (e) => {
      reconnectAttempts = 0;
      backoffMs = 500;
      try {
        const s = JSON.parse(e.data);
        if (s.depth >= 2) {           // Full-scan complete — server closes its end too.
          closed = true;
          if (timeoutId) clearTimeout(timeoutId);
          es.close();
          State._enrichmentPoller = null;
          showToast("Deep scan complete — updating graph with new collaborations", 3000);
          // ТЗ-5: invalidate cache for this seed so the next click goes to server.
          State._graphCache.delete(seedId);
          // Re-request the graph with the full, deep-scanned dataset.
          const seedName = document.getElementById("hero-input")?.value || "";
          if (seedName) searchArtist(seedName, false, true);
        }
      } catch (_) {
        // Malformed event — ignore, keep connection open.
      }
    };

    // Real network error — the server-driven close above already returns
    // before this can fire for the expected end-of-stream case.
    es.onerror = () => {
      if (closed) return;

      es.close();
      reconnectAttempts++;

      if (reconnectAttempts >= MAX_ATTEMPTS) {
        closed = true;
        State._enrichmentPoller = null;
        return;
      }

      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
      timeoutId = setTimeout(connect, backoffMs);
    };
  };

  const poller = {
    close: () => {
      closed = true;
      if (es) es.close();
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  State._enrichmentPoller = poller;
  connect();
}

// SF-WEB-02: limitOverride lets a restored deep-link ask for the same
// collab limit the sharer had (see loadArtistFromUrl in ui/history.js) —
// only meaningful for a fresh (non-expansion) search, same as
// showMoreCollaborations' own `limit=` param.
export function searchArtist(artist, isExpansion = false, forceImmediate = false, limitOverride = null) {
  artist = (artist || "").trim();
  if (!artist) return;
  if (State.inFlight) {
    if (isExpansion) {
      State.pendingExpand = { name: artist };
    } else {
      // Отменяем текущий запрос и ставим новый как pending (ТЗ-4).
      if (State._abortController) State._abortController.abort();
      State.pendingExpand = { name: artist };
    }
    return;
  }
  if (forceImmediate) _doSearch(artist, isExpansion, forceImmediate, limitOverride);
  else _searchDebounced(artist, isExpansion, false, limitOverride);
}

export async function _doSearch(artist, isExpansion, forceImmediate, limitOverride = null) {
  // ТЗ-4: abort any in-flight search request before starting a new one.
  if (State._abortController) State._abortController.abort();
  State._abortController = new AbortController();
  const signal = State._abortController.signal;

  State.inFlight      = true;
  State.pendingExpand = null;
  showLoading(true, artist);
  hideToast();

  try {
    const roles = [...State.activeFilters].join(",");

    // ТЗ-5: resolve artist to a numeric id for cache lookup (id may be stored
    // on the current seed or on any already-loaded node with this name).
    const knownNode = State.graphNodes.find(n => n.name === artist);
    const parsedId  = knownNode ? knownNode.id : null;

    // ТЗ-5: cache hit — skip the network round-trip.
    // forceImmediate is re-used as the BG-enrichment "force refresh" flag.
    if (parsedId != null && !forceImmediate) {
      const cached = State._graphCache.get(parsedId);
      if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
        isExpansion ? mergeGraph(cached.graph) : replaceGraph(cached.graph);
        return;
      }
    }

    // SF-WEB-02: same idea as showMoreCollaborations' `limit=` override —
    // only applied to a fresh (non-expansion) search, so a restored deep-link
    // reproduces the sharer's collab limit instead of falling back to the
    // server default.
    const limitParam = (!isExpansion && limitOverride > 0) ? `&limit=${limitOverride}` : "";
    const url = `/api/v1/graph?artist=${encodeURIComponent(artist)}&roles=${encodeURIComponent(roles)}${limitParam}`;
    const res = await apiFetch(url, { signal });

    // IDEA-21: reflect the backend's per-client rate-limit state (headers
    // are present on both success and 429 responses) so the user sees the
    // quota before they hit it, not only after.
    const rlLimit     = res.headers.get("X-RateLimit-Limit");
    const rlRemaining = res.headers.get("X-RateLimit-Remaining");
    if (rlLimit !== null && rlRemaining !== null) {
      updateRateLimitIndicator(Number(rlRemaining), Number(rlLimit));
    }

    // [ТЗ-6] 401 covers two distinct cases — read the body before the
    // generic !res.ok branch so we can give the right prompt instead of a
    // vague gateway error.
    if (res.status === 401) {
      let body = {};
      try { body = await res.json(); } catch (_) {}
      // Not signed in at all — there is no anonymous/shared-token fallback
      // anymore, so every request requires a Genius session.
      redirectToLogin(showToast, body, { notSignedInMessage: "Sign in with Genius to start exploring." });
      return;
    }

    if (!res.ok) {
      throwForStatus(res.status, { 400: "Please enter an artist name." });
    }
    const graph = await res.json();

    if (graph.ambiguous) {
      showCandidatePicker(graph.candidates || [], artist);
      return;
    }
    if (!graph.nodes || graph.nodes.length === 0) {
      showToast(`No collaborations found for "${artist}". Try another spelling.`);
      return;
    }

    // ТЗ-5: store result in cache (max 20 entries, evict oldest).
    if (graph.seed_id != null) {
      setGraphCacheEntry(State._graphCache, graph.seed_id, { graph, timestamp: Date.now() });
    }

    if (isExpansion) {
      mergeGraph(graph);
      // SF-WEB-02: keep the deep-link in sync as the user expands nodes —
      // mergeGraph() just added expandedId to State.expandedNodes.
      updateShareableUrl();
    } else {
      replaceGraph(graph);
      // replaceGraph()→finalizeGraphState() calls setSeed(), which resets
      // collabLimit to null — restore it only after that settles.
      if (limitOverride > 0) State.collabLimit = limitOverride;
      pushHistory(graph.seed || artist);
      updateShareableUrl(graph.seed || artist);
      // Once background enrichment (deep scan) finishes, re-fetch to pick
      // up any additional collaborations discovered on the richer graph.
      if (graph.seed_id != null) pollEnrichment(graph.seed_id);
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // пользователь сам отменил — не показываем toast (ТЗ-4).
    const msg = err.message || "Something went wrong. Please try again.";
    if (err.transient) {
      showRetryToast(msg, () => searchArtist(artist, isExpansion, true));
    } else {
      showToast(msg);
    }
  } finally {
    State._abortController = null;
    State.inFlight = false;
    showLoading(false);

    if (State.pendingExpand) {
      const { name } = State.pendingExpand;
      State.pendingExpand = null;
      _doSearch(name, true);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// IDEA-22: "Show more collaborations" — re-requests the current seed's graph
// with a larger ?limit=, overriding the server's songs-limit-fg default just
// for this call, and merges the (likely denser) result into the graph
// already on canvas instead of replacing it.
// ════════════════════════════════════════════════════════════════════════════

export async function showMoreCollaborations() {
  const seedId = State.currentSeedId;
  if (seedId == null || State.inFlight) return;

  const currentLimit = State.collabLimit || GRAPH_DEFAULT_LIMIT;
  const nextLimit = Math.min(currentLimit + GRAPH_LOAD_MORE_STEP, GRAPH_MAX_LIMIT);
  if (nextLimit <= currentLimit) {
    showToast(`Already showing the maximum of ${GRAPH_MAX_LIMIT} collaborations.`, 2500);
    return;
  }

  // The cached response (if any) was fetched at the smaller limit — drop it
  // so a later plain re-search doesn't silently serve the truncated graph.
  State._graphCache.delete(seedId);

  State.inFlight = true;
  const seedName = State.graphNodes.find(n => n.id === seedId)?.name || "";
  showLoading(true, seedName);

  try {
    const roles = [...State.activeFilters].join(",");
    const url = `/api/v1/graph?id=${seedId}&roles=${encodeURIComponent(roles)}&limit=${nextLimit}`;
    const res = await apiFetch(url);

    if (!res.ok) {
      throwForStatus(res.status, {
        400: "That limit was rejected by the server.",
        503: "Genius is temporarily unavailable — please try again in a minute.",
      });
    }

    const graph = await res.json();
    if (!graph.nodes || graph.nodes.length === 0) {
      showToast("No additional collaborations found.");
      return;
    }

    State.collabLimit = nextLimit;
    setGraphCacheEntry(State._graphCache, seedId, { graph, timestamp: Date.now() });
    mergeGraph(graph);
    showToast(`Showing up to ${nextLimit} collaborations.`, 2200);
  } catch (err) {
    const msg = err.message || "Could not load more collaborations.";
    if (err.transient) {
      showRetryToast(msg, () => showMoreCollaborations());
    } else {
      showToast(msg);
    }
  } finally {
    State.inFlight = false;
    showLoading(false);
  }
}
