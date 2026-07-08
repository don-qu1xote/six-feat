// ════════════════════════════════════════════════════════════════════════════
// api.test.js — unit tests for _doSearch (fetch mocked via vi.stubGlobal)
//
// api.js's own DOM/canvas collaborators (graph rendering, toasts, loading
// indicator, vis-adapter) are mocked out so these tests exercise only the
// networking/race-condition logic: AbortController cancellation, the
// _graphCache short-circuit, the pendingExpand queue, 401 handling, and the
// ambiguous-candidate branch.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock all of _doSearch's side-effecting collaborators ──────────────────
vi.mock("../graph.js", () => ({
  replaceGraph: vi.fn(),
  mergeGraph: vi.fn(),
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
}));

vi.mock("../vis-adapter/index.js", () => ({
  restoreDefaultColors: vi.fn(),
}));

import { State } from "../state/state.js";
import { replaceGraph, mergeGraph } from "../graph.js";
import { showCandidatePicker, showToast, showRetryToast } from "../ui/index.js";
import { _doSearch, showMoreCollaborations } from "./api.js";

// ─── Helpers ─────────────────────────────────────────────────────────────

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
}

// A minimal EventSource stub — pollEnrichment() is invoked as a side-effect
// of a successful non-expansion search and opens one of these.
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
  // jsdom treats a full-page window.location.href assignment as
  // unimplemented navigation and never updates the property (only hash
  // changes are supported) — swap in a writable stub so redirect assertions
  // can observe the assigned value instead.
  _originalLocation = window.location;
  delete window.location;
  window.location = { href: _originalLocation.href };
});

afterEach(() => {
  window.location = _originalLocation;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Scenario 1: plain successful search ────────────────────────────────

describe("_doSearch — successful search", () => {
  it("updates State and calls replaceGraph on a normal (non-expansion) search", async () => {
    const graph = {
      seed: "Radiohead",
      seed_id: 1,
      nodes: [{ id: 1, name: "Radiohead" }, { id: 2, name: "Thom Yorke" }],
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

    // Cache populated under the returned seed_id.
    expect(State._graphCache.has(1)).toBe(true);
    expect(State._graphCache.get(1).graph).toBe(graph);

    // Request lifecycle flags reset in the `finally` block.
    expect(State.inFlight).toBe(false);
    expect(State._abortController).toBe(null);
  });

  it("calls mergeGraph instead of replaceGraph for expansion searches", async () => {
    const graph = {
      seed_id: 5,
      nodes: [{ id: 5, name: "Someone" }],
      edges: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(graph)));

    await _doSearch("Someone", true, false);

    expect(mergeGraph).toHaveBeenCalledWith(graph);
    expect(replaceGraph).not.toHaveBeenCalled();
  });

  it("serves from cache without calling fetch when a fresh cache entry exists", async () => {
    const cachedGraph = { seed_id: 1, nodes: [{ id: 1, name: "Cached Artist" }], edges: [] };
    State.graphNodes = [{ id: 1, name: "Cached Artist" }];
    State._graphCache.set(1, { graph: cachedGraph, timestamp: Date.now() });

    vi.stubGlobal("fetch", vi.fn());

    await _doSearch("Cached Artist", false, false);

    expect(fetch).not.toHaveBeenCalled();
    expect(replaceGraph).toHaveBeenCalledWith(cachedGraph);
  });

  it("bypasses a fresh cache entry when forceImmediate is true", async () => {
    const cachedGraph = { seed_id: 1, nodes: [{ id: 1, name: "Cached Artist" }], edges: [] };
    const freshGraph = { seed_id: 1, nodes: [{ id: 1, name: "Cached Artist" }], edges: [] };
    State.graphNodes = [{ id: 1, name: "Cached Artist" }];
    State._graphCache.set(1, { graph: cachedGraph, timestamp: Date.now() });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(freshGraph)));

    await _doSearch("Cached Artist", false, true);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(replaceGraph).toHaveBeenCalledWith(freshGraph);
  });
});

// ─── Scenario 2: parallel requests / AbortController race ──────────────────

describe("_doSearch — concurrent requests cancel the previous one", () => {
  it("aborts the first in-flight fetch's signal when a second _doSearch starts", async () => {
    let capturedFirstSignal;

    const fetchMock = vi.fn().mockImplementation((url, opts) => {
      if (fetchMock.mock.calls.length === 1) {
        capturedFirstSignal = opts.signal;
        // Never resolves on its own — only settles via abort.
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }
      return Promise.resolve(
        jsonResponse({ seed_id: 2, nodes: [{ id: 2, name: "Second" }], edges: [] })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstCall = _doSearch("First Artist", false, false);
    // Let the first call reach `await fetch(...)` before starting the second.
    await Promise.resolve();
    await Promise.resolve();

    const secondCall = _doSearch("Second Artist", false, false);

    await Promise.all([firstCall, secondCall]);

    expect(capturedFirstSignal.aborted).toBe(true);
    // AbortError is swallowed silently — no error toast for a self-cancelled request.
    expect(showToast).not.toHaveBeenCalled();
    // Only the second (winning) request's graph made it to replaceGraph.
    expect(replaceGraph).toHaveBeenCalledTimes(1);
    expect(replaceGraph).toHaveBeenCalledWith(
      expect.objectContaining({ seed_id: 2 })
    );
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

// ─── Scenario 3: 401 handling ────────────────────────────────────────────

describe("_doSearch — 401 responses", () => {
  it("redirects to /auth/login on token_invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "token_invalid" }, { status: 401 }))
    );
    vi.useFakeTimers();

    const p = _doSearch("Artist", false, false);
    await p;
    await vi.advanceTimersByTimeAsync(1500);

    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/token expired/i)
    );
    expect(window.location.href).toContain("/auth/login");

    vi.useRealTimers();
  });

  it("redirects to /auth/login when not signed in at all (401 without token_invalid)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({}, { status: 401 }))
    );
    vi.useFakeTimers();

    const p = _doSearch("Artist", false, false);
    await p;
    await vi.advanceTimersByTimeAsync(1200);

    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/sign in with genius/i)
    );
    expect(window.location.href).toContain("/auth/login");

    vi.useRealTimers();
  });

  it("does not call replaceGraph/mergeGraph on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "token_invalid" }, { status: 401 }))
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

// ─── Scenario 4: ambiguous artist name ──────────────────────────────────

describe("_doSearch — ambiguous results", () => {
  it("calls showCandidatePicker with the candidate list and original query", async () => {
    const candidates = [{ name: "Genesis (UK band)" }, { name: "Genesis (rapper)" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ ambiguous: true, candidates }))
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

// ─── pendingExpand queue drains after the in-flight request settles ────────

describe("_doSearch — pendingExpand queue", () => {
  it("automatically re-runs a queued pendingExpand once the current request finishes", async () => {
    const firstGraph = { seed_id: 1, nodes: [{ id: 1, name: "First" }], edges: [] };
    const secondGraph = { seed_id: 2, nodes: [{ id: 2, name: "Queued" }], edges: [] };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(firstGraph))
      .mockResolvedValueOnce(jsonResponse(secondGraph));
    vi.stubGlobal("fetch", fetchMock);

    // Simulate searchArtist() having queued an expansion while inFlight was true.
    const p = _doSearch("First", false, false);
    State.pendingExpand = { name: "Queued" };
    await p;
    // The queued follow-up (fired from the `finally` block above, not
    // awaited) needs a further tick to reach its own fetch/json/mergeGraph.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mergeGraph).toHaveBeenCalledWith(secondGraph);
  });
});

// ─── IDEA-24: transient (502/503/network) failures offer a Retry action ────

describe("_doSearch — transient failures show a Retry toast", () => {
  it("offers Retry (not a plain toast) on a 502, and retry re-issues the request", async () => {
    const okGraph = { seed_id: 1, nodes: [{ id: 1, name: "Radiohead" }], edges: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 502 }))
      .mockResolvedValueOnce(jsonResponse(okGraph));
    vi.stubGlobal("fetch", fetchMock);

    await _doSearch("Radiohead", false, false);

    expect(showToast).not.toHaveBeenCalled();
    expect(showRetryToast).toHaveBeenCalledTimes(1);
    const [msg, retry] = showRetryToast.mock.calls[0];
    expect(msg).toMatch(/couldn't reach genius/i);

    // Clicking the toast's Retry button re-runs the original search. retry()
    // calls searchArtist(), which fires _doSearch() without awaiting it, so
    // flush a macrotask to let the follow-up fetch/json/replaceGraph chain
    // settle before asserting on it.
    retry();
    await new Promise(resolve => setTimeout(resolve, 0));
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
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/please enter an artist name/i)
    );
  });
});

// ─── showMoreCollaborations — transient failures also offer Retry ──────────

describe("showMoreCollaborations — transient failures show a Retry toast", () => {
  it("offers Retry on a 503 using the show-more-specific message", async () => {
    State.currentSeedId = 1;
    State.graphNodes = [{ id: 1, name: "Radiohead" }];
    State.collabLimit = null;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { status: 503 })));

    await showMoreCollaborations();

    expect(showRetryToast).toHaveBeenCalledTimes(1);
    expect(showRetryToast.mock.calls[0][0]).toBe(
      "Genius is temporarily unavailable — please try again in a minute."
    );
  });
});
