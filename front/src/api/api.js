import {
  State,
  SEARCH_DEBOUNCE,
  setGraphCacheEntry,
  GRAPH_DEFAULT_LIMIT,
  GRAPH_LOAD_MORE_STEP,
  GRAPH_MAX_LIMIT,
} from "../state/state.js";
import { debounce } from "../state/helpers.js";
import { replaceGraph, mergeGraph, mergeDeepenResult } from "../graph.js";
import { showCandidatePicker } from "../ui/index.js";
import {
  showLoading,
  showToast,
  showRetryToast,
  hideToast,
  pushHistory,
  updateShareableUrl,
  updateRateLimitIndicator,
  updateScanStatus,
} from "../ui/index.js";
import { restoreDefaultColors } from "../vis-adapter/index.js";
import { apiFetch, throwForStatus, redirectToLogin } from "./net.js";

const _searchDebounced = debounce(
  (artist, isExpansion, forceImmediate, limitOverride) =>
    _doSearch(artist, isExpansion, forceImmediate, limitOverride),
  SEARCH_DEBOUNCE,
);

export function pollEnrichment(seedId) {
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

  updateScanStatus({ depth: 1, enriching: true });

  const connect = () => {
    if (closed) return;

    es = new EventSource(`/api/v1/status/stream?id=${seedId}`);

    es.onmessage = (e) => {
      reconnectAttempts = 0;
      backoffMs = 500;
      try {
        const s = JSON.parse(e.data);
        updateScanStatus(s);
        if (s.depth >= 2) {
          closed = true;
          if (timeoutId) clearTimeout(timeoutId);
          es.close();
          State._enrichmentPoller = null;
          showToast("Deep scan complete — updating graph with new collaborations", 3000);
          State._graphCache.delete(seedId);
          const seedName = document.getElementById("hero-input")?.value || "";
          if (seedName) searchArtist(seedName, false, true);
        }
      } catch (_) {}
    };

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
    },
  };

  State._enrichmentPoller = poller;
  connect();
}

export function searchArtist(
  artist,
  isExpansion = false,
  forceImmediate = false,
  limitOverride = null,
) {
  artist = (artist || "").trim();
  if (!artist) return;
  if (State.inFlight) {
    if (isExpansion) {
      State.pendingExpand = { name: artist };
    } else {
      if (State._abortController) State._abortController.abort();
      State.pendingExpand = { name: artist };
    }
    return;
  }
  if (forceImmediate) _doSearch(artist, isExpansion, forceImmediate, limitOverride);
  else _searchDebounced(artist, isExpansion, false, limitOverride);
}

export async function _doSearch(artist, isExpansion, forceImmediate, limitOverride = null) {
  if (State._abortController) State._abortController.abort();
  State._abortController = new AbortController();
  const signal = State._abortController.signal;

  State.inFlight = true;
  State.pendingExpand = null;
  showLoading(true, artist);
  hideToast();

  try {
    const roles = [...State.activeFilters].join(",");

    const knownNode = State.graphNodes.find((n) => n.name === artist);
    const parsedId = knownNode ? knownNode.id : null;

    if (parsedId != null && !forceImmediate) {
      const cached = State._graphCache.get(parsedId);
      if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
        isExpansion ? mergeGraph(cached.graph) : replaceGraph(cached.graph);
        return;
      }
    }

    const limitParam = !isExpansion && limitOverride > 0 ? `&limit=${limitOverride}` : "";
    const url = `/api/v1/graph?artist=${encodeURIComponent(artist)}&roles=${encodeURIComponent(roles)}${limitParam}`;
    const res = await apiFetch(url, { signal });

    const rlLimit = res.headers.get("X-RateLimit-Limit");
    const rlRemaining = res.headers.get("X-RateLimit-Remaining");
    if (rlLimit !== null && rlRemaining !== null) {
      updateRateLimitIndicator(Number(rlRemaining), Number(rlLimit));
    }

    if (res.status === 401) {
      let body = {};
      try {
        body = await res.json();
      } catch (_) {}
      redirectToLogin(showToast, body, {
        notSignedInMessage: "Sign in with Genius to start exploring.",
      });
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

    if (graph.seedId != null) {
      setGraphCacheEntry(State._graphCache, graph.seedId, { graph, timestamp: Date.now() });
    }

    if (isExpansion) {
      mergeGraph(graph);
      updateShareableUrl();
    } else {
      replaceGraph(graph);
      if (limitOverride > 0) State.collabLimit = limitOverride;
      pushHistory(graph.seed || artist);
      updateShareableUrl(graph.seed || artist);
      if (graph.seedId != null) pollEnrichment(graph.seedId);
    }
  } catch (err) {
    if (err.name === "AbortError") return;
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

export async function deepenArtistConnections(artistId) {
  if (artistId == null || State.deepenInFlight) return;
  State.deepenInFlight = true;
  showToast("Looking for more connections via Genius…", 1800, true);

  try {
    const res = await apiFetch(`/api/v1/graph/deepen?id=${encodeURIComponent(artistId)}`);

    if (res.status === 401) {
      let body = {};
      try {
        body = await res.json();
      } catch (_) {}
      redirectToLogin(showToast, body, {
        notSignedInMessage: "Sign in with Genius to find more connections.",
      });
      return;
    }

    if (!res.ok) {
      throwForStatus(res.status, {
        404: "Could not find that artist on Genius.",
        503: "Genius is temporarily unavailable — please try again in a minute.",
      });
    }

    const deepen = await res.json();
    const result = mergeDeepenResult(deepen);

    if (!result.addedNodes && !result.addedEdges && !result.mergedEdges) {
      showToast("No additional Genius-tagged connections found.");
      return;
    }

    const parts = [];
    if (result.addedEdges) {
      parts.push(`${result.addedEdges} new connection${result.addedEdges === 1 ? "" : "s"}`);
    }
    if (result.mergedEdges) {
      parts.push(`${result.mergedEdges} enriched`);
    }
    showToast(
      `Found more connections via Genius${parts.length ? `: ${parts.join(", ")}` : ""}.`,
      2500,
    );
  } catch (err) {
    const msg = err.message || "Could not reach Genius for more connections.";
    if (err.transient) {
      showRetryToast(msg, () => deepenArtistConnections(artistId));
    } else {
      showToast(msg);
    }
  } finally {
    State.deepenInFlight = false;
  }
}

export async function showMoreCollaborations() {
  const seedId = State.currentSeedId;
  if (seedId == null || State.inFlight) return;

  const currentLimit = State.collabLimit || GRAPH_DEFAULT_LIMIT;
  const nextLimit = Math.min(currentLimit + GRAPH_LOAD_MORE_STEP, GRAPH_MAX_LIMIT);
  if (nextLimit <= currentLimit) {
    showToast(`Already showing the maximum of ${GRAPH_MAX_LIMIT} collaborations.`, 2500);
    return;
  }

  State._graphCache.delete(seedId);

  State.inFlight = true;
  const seedName = State.graphNodes.find((n) => n.id === seedId)?.name || "";
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
