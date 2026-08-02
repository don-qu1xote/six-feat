import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../graph.js", () => ({
  replaceGraph: vi.fn(),
  mergeGraph: vi.fn(),
  mergeDeepenResult: vi.fn(),
}));

vi.mock("../ui/index.js", () => ({
  showCandidatePicker: vi.fn(),
  showLoading: vi.fn(),
  showToast: vi.fn(),
  showRetryToast: vi.fn(),
  hideToast: vi.fn(),
  pushHistory: vi.fn(),
  updateShareableUrl: vi.fn(),
  updateRateLimitIndicator: vi.fn(),
  updateScanStatus: vi.fn(),
}));

vi.mock("../vis-adapter/index.js", () => ({
  restoreDefaultColors: vi.fn(),
}));

import { State } from "../state/state.js";
import { replaceGraph, mergeGraph, mergeDeepenResult } from "../graph.js";
import { showCandidatePicker, showToast, showRetryToast, updateScanStatus } from "../ui/index.js";
import { _doSearch, showMoreCollaborations, deepenArtistConnections } from "./api.js";

function jsonResponse(body, init = {}) {
  const headers = init.headers ?? { get: () => null };
  return {
    ok: init.status == null || (init.status >= 200 && init.status < 300),
    status: init.status ?? 200,
    headers,
    json: async () => body,
  };
}

function resetState() {
  State.inFlight = false;
  State.pendingExpand = null;
  State._abortController = null;
  State.graphNodes = [];
  State.graphEdges = [];
  State._graphCache = new Map();
  State.activeFilters = new Set(["featured", "producer", "writer"]);
  State.deepenInFlight = false;
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}
FakeEventSource.instances = [];

let _originalLocation;

beforeEach(() => {
  resetState();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  _originalLocation = window.location;
  delete window.location;
  window.location = { href: _originalLocation.href };
});

afterEach(() => {
  window.location = _originalLocation;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("_doSearch — successful search", () => {
  it("updates State and calls replaceGraph on a normal (non-expansion) search", async () => {
    const graph = {
      seed: "Radiohead",
      seedId: 1,
      nodes: [
        { id: 1, name: "Radiohead" },
        { id: 2, name: "Thom Yorke" },
      ],
      edges: [{ from: 1, to: 2, roles: ["featured"] }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(graph)));

    await _doSearch("Radiohead", false, false);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url] = fetch.mock.calls[0];
    expect(url).toContain("/api/v1/graph?artist=Radiohead");

    expect(replaceGraph).toHaveBeenCalledTimes(1);
    expect(replaceGraph).toHaveBeenCalledWith(graph);
    expect(mergeGraph).not.toHaveBeenCalled();

    expect(State._graphCache.has(1)).toBe(true);
    expect(State._graphCache.get(1).graph).toBe(graph);

    expect(State.inFlight).toBe(false);
    expect(State._abortController).toBe(null);
  });

  it("calls mergeGraph instead of replaceGraph for expansion searches", async () => {
    const graph = {
      seedId: 5,
      nodes: [{ id: 5, name: "Someone" }],
      edges: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(graph)));

    await _doSearch("Someone", true, false);

    expect(mergeGraph).toHaveBeenCalledWith(graph);
    expect(replaceGraph).not.toHaveBeenCalled();
  });

  it("serves from cache without calling fetch when a fresh cache entry exists", async () => {
    const cachedGraph = { seedId: 1, nodes: [{ id: 1, name: "Cached Artist" }], edges: [] };
    State.graphNodes = [{ id: 1, name: "Cached Artist" }];
    State._graphCache.set(1, { graph: cachedGraph, timestamp: Date.now() });

    vi.stubGlobal("fetch", vi.fn());

    await _doSearch("Cached Artist", false, false);

    expect(fetch).not.toHaveBeenCalled();
    expect(replaceGraph).toHaveBeenCalledWith(cachedGraph);
  });

  it("bypasses a fresh cache entry when forceImmediate is true", async () => {
    const cachedGraph = { seedId: 1, nodes: [{ id: 1, name: "Cached Artist" }], edges: [] };
    const freshGraph = { seedId: 1, nodes: [{ id: 1, name: "Cached Artist" }], edges: [] };
    State.graphNodes = [{ id: 1, name: "Cached Artist" }];
    State._graphCache.set(1, { graph: cachedGraph, timestamp: Date.now() });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(freshGraph)));

    await _doSearch("Cached Artist", false, true);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(replaceGraph).toHaveBeenCalledWith(freshGraph);
  });
});

describe("pollEnrichment — SSE events drive updateScanStatus", () => {
  it("shows an optimistic partial/scanning status as soon as the SSE stream opens", async () => {
    const graph = {
      seed: "Radiohead",
      seedId: 1,
      nodes: [{ id: 1, name: "Radiohead" }],
      edges: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(graph)));

    await _doSearch("Radiohead", false, false);

    expect(updateScanStatus).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 1, enriching: true }),
    );
  });

  it("reflects each mock status event, partial → background scan → full", async () => {
    const graph = {
      seed: "Radiohead",
      seedId: 1,
      nodes: [{ id: 1, name: "Radiohead" }],
      edges: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(graph)));

    await _doSearch("Radiohead", false, false);
    updateScanStatus.mockClear();

    const es = FakeEventSource.instances[0];
    expect(es).toBeTruthy();

    es.onmessage({ data: JSON.stringify({ depth: 1, song_count: 10, enriching: false }) });
    es.onmessage({ data: JSON.stringify({ depth: 1, song_count: 25, enriching: true }) });
    es.onmessage({ data: JSON.stringify({ depth: 2, song_count: 40, enriching: false }) });

    expect(updateScanStatus.mock.calls.map(([s]) => s)).toEqual([
      { depth: 1, song_count: 10, enriching: false },
      { depth: 1, song_count: 25, enriching: true },
      { depth: 2, song_count: 40, enriching: false },
    ]);
    expect(es.closed).toBe(true);
  });
});

describe("_doSearch — concurrent requests cancel the previous one", () => {
  it("aborts the first in-flight fetch's signal when a second _doSearch starts", async () => {
    let capturedFirstSignal;

    const fetchMock = vi.fn().mockImplementation((url, opts) => {
      if (fetchMock.mock.calls.length === 1) {
        capturedFirstSignal = opts.signal;
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      return Promise.resolve(
        jsonResponse({ seedId: 2, nodes: [{ id: 2, name: "Second" }], edges: [] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstCall = _doSearch("First Artist", false, false);
    await Promise.resolve();
    await Promise.resolve();

    const secondCall = _doSearch("Second Artist", false, false);

    await Promise.all([firstCall, secondCall]);

    expect(capturedFirstSignal.aborted).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
    expect(replaceGraph).toHaveBeenCalledTimes(1);
    expect(replaceGraph).toHaveBeenCalledWith(expect.objectContaining({ seedId: 2 }));
  });

  it("does not show a toast when a request is aborted", async () => {
    const fetchMock = vi.fn().mockImplementation((url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const p = _doSearch("Artist A", false, false);
    await Promise.resolve();
    State._abortController.abort();
    await p;

    expect(showToast).not.toHaveBeenCalled();
  });
});

describe("_doSearch — 401 responses", () => {
  it("redirects to /auth/login on token_invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "token_invalid" }, { status: 401 })),
    );
    vi.useFakeTimers();

    const p = _doSearch("Artist", false, false);
    await p;
    await vi.advanceTimersByTimeAsync(1500);

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/token expired/i));
    expect(window.location.href).toContain("/auth/login");

    vi.useRealTimers();
  });

  it("redirects to /auth/login when not signed in at all (401 without token_invalid)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 401 })));
    vi.useFakeTimers();

    const p = _doSearch("Artist", false, false);
    await p;
    await vi.advanceTimersByTimeAsync(1200);

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/sign in with genius/i));
    expect(window.location.href).toContain("/auth/login");

    vi.useRealTimers();
  });

  it("does not call replaceGraph/mergeGraph on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "token_invalid" }, { status: 401 })),
    );
    vi.useFakeTimers();
    const p = _doSearch("Artist", false, false);
    await p;
    await vi.advanceTimersByTimeAsync(1500);
    vi.useRealTimers();

    expect(replaceGraph).not.toHaveBeenCalled();
    expect(mergeGraph).not.toHaveBeenCalled();
  });
});

describe("_doSearch — ambiguous results", () => {
  it("calls showCandidatePicker with the candidate list and original query", async () => {
    const candidates = [{ name: "Genesis (UK band)" }, { name: "Genesis (rapper)" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ ambiguous: true, candidates })),
    );

    await _doSearch("Genesis", false, false);

    expect(showCandidatePicker).toHaveBeenCalledWith(candidates, "Genesis");
    expect(replaceGraph).not.toHaveBeenCalled();
    expect(mergeGraph).not.toHaveBeenCalled();
  });

  it("passes an empty array to showCandidatePicker when candidates is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ambiguous: true })));

    await _doSearch("Vague Name", false, false);

    expect(showCandidatePicker).toHaveBeenCalledWith([], "Vague Name");
  });
});

describe("_doSearch — pendingExpand queue", () => {
  it("automatically re-runs a queued pendingExpand once the current request finishes", async () => {
    const firstGraph = { seedId: 1, nodes: [{ id: 1, name: "First" }], edges: [] };
    const secondGraph = { seedId: 2, nodes: [{ id: 2, name: "Queued" }], edges: [] };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(firstGraph))
      .mockResolvedValueOnce(jsonResponse(secondGraph));
    vi.stubGlobal("fetch", fetchMock);

    const p = _doSearch("First", false, false);
    State.pendingExpand = { name: "Queued" };
    await p;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mergeGraph).toHaveBeenCalledWith(secondGraph);
  });
});

describe("_doSearch — transient failures show a Retry toast", () => {
  it("offers Retry (not a plain toast) on a 502, and retry re-issues the request", async () => {
    const okGraph = { seedId: 1, nodes: [{ id: 1, name: "Radiohead" }], edges: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(okGraph));
    vi.stubGlobal("fetch", fetchMock);

    await _doSearch("Radiohead", false, false);

    expect(showToast).not.toHaveBeenCalled();
    expect(showRetryToast).toHaveBeenCalledTimes(1);
    const [msg, retry] = showRetryToast.mock.calls[0];
    expect(msg).toMatch(/couldn't reach genius/i);

    // Clicking the toast's Retry button re-runs the original search. retry()
    retry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(replaceGraph).toHaveBeenCalledWith(okGraph);
  });

  it("offers Retry on a genuine network failure (fetch rejects, not AbortError)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await _doSearch("Radiohead", false, false);

    expect(showToast).not.toHaveBeenCalled();
    expect(showRetryToast).toHaveBeenCalledTimes(1);
    expect(showRetryToast.mock.calls[0][0]).toMatch(/network error/i);
  });

  it("shows a plain toast (no Retry) for a non-transient error like 400", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 400 })));

    await _doSearch("Radiohead", false, false);

    expect(showRetryToast).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/please enter an artist name/i));
  });
});

describe("showMoreCollaborations — transient failures show a Retry toast", () => {
  it("offers Retry on a 503 using the show-more-specific message", async () => {
    State.currentSeedId = 1;
    State.graphNodes = [{ id: 1, name: "Radiohead" }];
    State.collabLimit = null;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 503 })));

    await showMoreCollaborations();

    expect(showRetryToast).toHaveBeenCalledTimes(1);
    expect(showRetryToast.mock.calls[0][0]).toBe(
      "Genius is temporarily unavailable — please try again in a minute.",
    );
  });
});

describe("[SF-YM-03] deepenArtistConnections", () => {
  it("does nothing when artistId is null/undefined", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await deepenArtistConnections(null);
    await deepenArtistConnections(undefined);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing when a deepen request is already in flight", async () => {
    State.deepenInFlight = true;
    vi.stubGlobal("fetch", vi.fn());

    await deepenArtistConnections(1);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches /api/v1/graph/deepen?id=<artistId> and merges the result", async () => {
    const deepen = {
      type: "graph_deepen",
      seedId: 1,
      nodes: [{ id: 2, name: "Producer Pete" }],
      edges: [{ from: 1, to: 2, dominant_role: "producer" }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(deepen)));
    mergeDeepenResult.mockReturnValue({ addedNodes: 1, addedEdges: 1, mergedEdges: 0 });

    await deepenArtistConnections(1);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url] = fetch.mock.calls[0];
    expect(url).toContain("/api/v1/graph/deepen?id=1");
    expect(mergeDeepenResult).toHaveBeenCalledWith(deepen);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/1 new connection/i), 2500);
    expect(State.deepenInFlight).toBe(false);
  });

  it("shows a distinct toast when nothing new was found", async () => {
    const deepen = { type: "graph_deepen", seedId: 1, nodes: [], edges: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(deepen)));
    mergeDeepenResult.mockReturnValue({ addedNodes: 0, addedEdges: 0, mergedEdges: 0 });

    await deepenArtistConnections(1);

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/no additional/i));
  });

  it("mentions enriched edges when an existing pair got merged, not re-added", async () => {
    const deepen = {
      type: "graph_deepen",
      seedId: 1,
      nodes: [],
      edges: [{ from: 1, to: 2, dominant_role: "producer" }],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(deepen)));
    mergeDeepenResult.mockReturnValue({ addedNodes: 0, addedEdges: 0, mergedEdges: 1 });

    await deepenArtistConnections(1);

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/1 enriched/i), 2500);
  });

  it("redirects to /auth/login on a 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 401 })));
    vi.useFakeTimers();

    const p = deepenArtistConnections(1);
    await p;
    await vi.advanceTimersByTimeAsync(1500);

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/sign in with genius/i));
    expect(window.location.href).toContain("/auth/login");
    expect(mergeDeepenResult).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("offers a Retry toast on a transient 503", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 503 })));

    await deepenArtistConnections(1);

    expect(showRetryToast).toHaveBeenCalledTimes(1);
    expect(showRetryToast.mock.calls[0][0]).toBe(
      "Genius is temporarily unavailable — please try again in a minute.",
    );
  });

  it("shows a non-retry toast on a 404 (artist not found)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 404 })));

    await deepenArtistConnections(1);

    expect(showToast).toHaveBeenCalledWith("Could not find that artist on Genius.");
    expect(showRetryToast).not.toHaveBeenCalled();
  });

  it("resets deepenInFlight even when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 404 })));

    await deepenArtistConnections(1);

    expect(State.deepenInFlight).toBe(false);
  });
});
