// ════════════════════════════════════════════════════════════════════════════
// ui/canvas-controls.test.js — SF-WEB-05: updateScanStatus reflects the
//                                inline data-completeness indicator through a
//                                sequence of mock /api/v1/status/stream
//                                events (partial → background scan → full).
//                                SF-WEB-04: buildGraphExportData/
//                                exportGraphJson — the JSON export's data
//                                shape and its "nothing to export" guard.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  updateScanStatus, buildGraphExportData, exportGraphJson, setupFilterToggles,
  buildShadowNodes, waitForImages, clearCanvas, goHome,
  fitView, focusSeed, zoomIn, zoomOut, updateRateLimitIndicator,
} from "./canvas-controls.js";
import { placeholderFor } from "../state/helpers.js";
import { showToast } from "./toast.js";
import { searchArtist } from "../api/api.js";
import { updateShareableUrl } from "./history.js";
import { resetCanvasToEmpty } from "../vis-adapter/index.js";
import { openSearchModal } from "./modals.js";

vi.mock("./toast.js", () => ({ showToast: vi.fn(), hideToast: vi.fn() }));
vi.mock("../api/api.js", () => ({ searchArtist: vi.fn(), showMoreCollaborations: vi.fn() }));
vi.mock("./history.js", () => ({ updateShareableUrl: vi.fn() }));
vi.mock("../vis-adapter/index.js", () => ({
  clearFocus: vi.fn(), resetCanvasToEmpty: vi.fn(), networkOptions: vi.fn(),
  isCompareModeActive: vi.fn(() => false), exitCompareMode: vi.fn(),
}));
vi.mock("../api/analytics-client.js", () => ({ clearPathHighlight: vi.fn() }));
vi.mock("../dom/canvas-decorator.js", () => ({ startCanvasDecorator: vi.fn() }));
vi.mock("./modals.js", () => ({
  isSearchModalOpen: vi.fn(), closeSearchModal: vi.fn(), openSearchModal: vi.fn(),
  isPathPanelOpen: vi.fn(), closePathPanel: vi.fn(),
  closeNodeSearch: vi.fn(), openNodeSearch: vi.fn(),
}));
vi.mock("./sidebar.js", () => ({ hideArtistSidebar: vi.fn() }));
vi.mock("./candidate-picker.js", () => ({ hideCandidatePicker: vi.fn() }));

beforeEach(() => {
  els.scanStatusBadge = document.createElement("span");
  els.scanStatusBadge.hidden = true;
  els.scanStatusText  = document.createElement("span");
  els.scanStatusBadge.appendChild(els.scanStatusText);
});

describe("updateScanStatus", () => {
  it("shows a 'Partial' badge when depth is Foreground and no background scan is running", () => {
    updateScanStatus({ depth: 1, song_count: 12, enriching: false });

    expect(els.scanStatusBadge.hidden).toBe(false);
    expect(els.scanStatusText.textContent).toBe("Partial");
    expect(els.scanStatusBadge.classList.contains("scan-status-badge--enriching")).toBe(false);
  });

  it("shows a 'Scanning…' badge while background enrichment is running", () => {
    updateScanStatus({ depth: 1, song_count: 12, enriching: true });

    expect(els.scanStatusBadge.hidden).toBe(false);
    expect(els.scanStatusText.textContent).toBe("Scanning…");
    expect(els.scanStatusBadge.classList.contains("scan-status-badge--enriching")).toBe(true);
  });

  it("hides the badge once depth reaches Full (2) — data is complete", () => {
    updateScanStatus({ depth: 1, song_count: 12, enriching: true });
    expect(els.scanStatusBadge.hidden).toBe(false);

    updateScanStatus({ depth: 2, song_count: 40, enriching: false });
    expect(els.scanStatusBadge.hidden).toBe(true);
  });

  it("reflects a full partial→scanning→full event sequence", () => {
    const events = [
      { depth: 1, song_count: 10, enriching: false },
      { depth: 1, song_count: 10, enriching: true },
      { depth: 1, song_count: 25, enriching: true },
      { depth: 2, song_count: 40, enriching: false },
    ];
    const observed = events.map(e => {
      updateScanStatus(e);
      return els.scanStatusBadge.hidden ? "hidden" : els.scanStatusText.textContent;
    });
    expect(observed).toEqual(["Partial", "Scanning…", "Scanning…", "hidden"]);
  });

  it("is a no-op when the badge element isn't present on the page", () => {
    els.scanStatusBadge = null;
    expect(() => updateScanStatus({ depth: 1, enriching: true })).not.toThrow();
  });
});

describe("buildGraphExportData — SF-WEB-04", () => {
  beforeEach(() => {
    State.graphNodes = [
      { id: 1, name: "Seed Artist", imageUrl: "https://img/seed.jpg", geniusUrl: "https://genius.com/seed", isSeed: true,
        _isNew: false, _dimBorder: "#111", _accent: "#8FA6C9", _dominantRole: "featured" },
      { id: 2, name: "Collaborator", imageUrl: "", geniusUrl: null, isSeed: false,
        _isNew: true, _expandParent: 1 },
    ];
    State.graphEdges = [
      { id: "1_2", from: 1, to: 2, weight: 3, dominantRole: "featured",
        collaboration_count: 3, songs: ["Track A"], collaborations: [{ song: "Track A", roles: ["featured"] }] },
    ];
    State.currentSeedId = 1;
  });

  it("returns a plain object with the current nodes/edges, seed, and export timestamp", () => {
    const data = buildGraphExportData();

    expect(data.seed).toBe("Seed Artist");
    expect(data.seedId).toBe(1);
    expect(typeof data.exportedAt).toBe("string");
    expect(new Date(data.exportedAt).toString()).not.toBe("Invalid Date");

    expect(data.nodes).toEqual([
      { id: 1, name: "Seed Artist", imageUrl: "https://img/seed.jpg", geniusUrl: "https://genius.com/seed", isSeed: true },
      { id: 2, name: "Collaborator", imageUrl: null, geniusUrl: null, isSeed: false },
    ]);
    expect(data.edges).toEqual([
      {
        id: "1_2", from: 1, to: 2, weight: 3, dominantRole: "featured",
        collaboration_count: 3, songs: ["Track A"],
        collaborations: [{ song: "Track A", roles: ["featured"] }],
      },
    ]);
  });

  it("never leaks internal bookkeeping fields (_isNew, _dimBorder, _accent, _dominantRole, _expandParent)", () => {
    const data = buildGraphExportData();
    for (const node of data.nodes) {
      for (const key of Object.keys(node)) expect(key.startsWith("_")).toBe(false);
    }
  });

  it("produces a JSON.stringify-able object matching the same shape after a round-trip", () => {
    const data = buildGraphExportData();
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });

  it("is valid even for an empty graph", () => {
    State.graphNodes = [];
    State.graphEdges = [];
    State.currentSeedId = null;

    const data = buildGraphExportData();
    expect(data.seed).toBeNull();
    expect(data.nodes).toEqual([]);
    expect(data.edges).toEqual([]);
  });
});

describe("exportGraphJson — SF-WEB-04", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a toast and does not throw when there is nothing to export", () => {
    State.graphNodes = [];
    State.graphEdges = [];

    expect(() => exportGraphJson()).not.toThrow();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Nothing to export"), expect.anything());
  });
});

// [SF-WEB-30] setupFilterToggles binds BOTH the always-visible canvas
// segment (#role-filter-segment) AND the landing/docked hero row
// (.include-roles-row) to the same State.activeFilters — SF-WEB-30 hides
// the hero row in docked mode via CSS only, wiring untouched, so this is
// the first coverage for that shared wiring (none existed before).
describe("setupFilterToggles — SF-WEB-30", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    State.activeFilters = new Set(["featured", "producer", "writer"]);
    els.heroInput = document.createElement("input");
    els.canvasFilterFeatured = document.createElement("button");
    els.canvasFilterProducer = document.createElement("button");
    els.canvasFilterWriter   = document.createElement("button");
    els.heroFilterFeatured   = document.createElement("button");
    els.heroFilterProducer   = document.createElement("button");
    els.heroFilterWriter     = document.createElement("button");
    setupFilterToggles();
  });

  it("toggling the canvas segment button removes the role and syncs the hero row's button", () => {
    els.canvasFilterFeatured.click();
    expect(State.activeFilters.has("featured")).toBe(false);
    expect(els.canvasFilterFeatured.classList.contains("active")).toBe(false);
    expect(els.heroFilterFeatured.classList.contains("active")).toBe(false);
  });

  it("toggling the hero row's button syncs the canvas segment's button", () => {
    els.heroFilterProducer.click();
    expect(State.activeFilters.has("producer")).toBe(false);
    expect(els.canvasFilterProducer.classList.contains("active")).toBe(false);
  });

  it("refuses to turn off the last remaining active role filter", () => {
    State.activeFilters = new Set(["featured"]);
    els.canvasFilterFeatured.classList.add("active");
    els.canvasFilterFeatured.click();
    expect(State.activeFilters.has("featured")).toBe(true);
    expect(showToast).toHaveBeenCalled();
  });

  it("re-searches the current artist after a toggle", () => {
    els.heroInput.value = "Kendrick Lamar";
    els.canvasFilterWriter.click();
    expect(searchArtist).toHaveBeenCalledWith("Kendrick Lamar", false, true);
    expect(updateShareableUrl).toHaveBeenCalledWith("Kendrick Lamar");
  });
});

// [SF-WEB-32] PNG export's shadow-network nodes: a node with a real Genius
// photo (graphNode.imageUrl) must route through the same-origin
// /api/v1/image proxy (SF-API-12) instead of the local placeholder, so the
// shadow canvas can draw a real photo without tainting (same-origin only).
// A node with no real photo (imageUrl empty/absent — already normalized
// that way for Genius's own default-avatar image, see graph.js) still gets
// the local placeholder, exactly as before this ticket.
describe("buildShadowNodes — SF-WEB-32", () => {
  const graphNodes = [
    { id: 1, name: "Has Photo", isSeed: true,  imageUrl: "https://images.genius.com/real-photo.jpg" },
    { id: 2, name: "No Photo",  isSeed: false, imageUrl: "" },
  ];
  const nodeItems = [
    { id: 1, label: "Has Photo" },
    { id: 2, label: "No Photo" },
  ];
  const positions = {
    1: { x: 10, y: 20 },
    2: { x: 30, y: 40 },
  };

  it("routes a node with a real photo through /api/v1/image?url=<encoded>", () => {
    const { shadowNodes } = buildShadowNodes(nodeItems, graphNodes, positions);
    const node1 = shadowNodes.find(n => n.id === 1);
    expect(node1.image).toBe(
      `/api/v1/image?url=${encodeURIComponent("https://images.genius.com/real-photo.jpg")}`
    );
  });

  it("keeps the local placeholder as brokenImage even for a node with a real photo", () => {
    const { shadowNodes } = buildShadowNodes(nodeItems, graphNodes, positions);
    const node1 = shadowNodes.find(n => n.id === 1);
    expect(node1.brokenImage).toBe(placeholderFor("Has Photo", true));
    expect(node1.brokenImage).not.toBe(node1.image);
  });

  it("uses the local placeholder for both image and brokenImage when there is no real photo", () => {
    const { shadowNodes } = buildShadowNodes(nodeItems, graphNodes, positions);
    const node2 = shadowNodes.find(n => n.id === 2);
    const expected = placeholderFor("No Photo", false);
    expect(node2.image).toBe(expected);
    expect(node2.brokenImage).toBe(expected);
  });

  it("collects every proxied photo's URL, and only those", () => {
    const { proxyUrls } = buildShadowNodes(nodeItems, graphNodes, positions);
    expect(proxyUrls).toEqual([
      `/api/v1/image?url=${encodeURIComponent("https://images.genius.com/real-photo.jpg")}`,
    ]);
  });

  it("positions each shadow node from the live network's saved positions and fixes it in place", () => {
    const { shadowNodes } = buildShadowNodes(nodeItems, graphNodes, positions);
    const node1 = shadowNodes.find(n => n.id === 1);
    expect(node1.x).toBe(10);
    expect(node1.y).toBe(20);
    expect(node1.fixed).toEqual({ x: true, y: true });
    expect(node1.shape).toBe("circularImage");
  });

  it("falls back to the node item's own x/y when no saved position exists", () => {
    const { shadowNodes } = buildShadowNodes(
      [{ id: 3, label: "Untracked", x: 99, y: 88 }],
      [{ id: 3, name: "Untracked", isSeed: false, imageUrl: "" }],
      {},
    );
    expect(shadowNodes[0].x).toBe(99);
    expect(shadowNodes[0].y).toBe(88);
  });
});

describe("waitForImages — SF-WEB-32", () => {
  const realImage = globalThis.Image;
  let images;

  beforeEach(() => {
    vi.useFakeTimers();
    images = [];
    globalThis.Image = class {
      constructor() {
        images.push(this);
      }
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.Image = realImage;
  });

  it("resolves after the minimum settle delay when there are no proxy urls", async () => {
    const done = vi.fn();
    waitForImages([]).then(done);
    await vi.advanceTimersByTimeAsync(149);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });

  it("resolves once every image has fired onload, without waiting for the full timeout", async () => {
    const done = vi.fn();
    waitForImages(["/api/v1/image?url=a", "/api/v1/image?url=b"], 5000).then(done);

    await vi.advanceTimersByTimeAsync(150); // past the minimum settle delay
    expect(done).not.toHaveBeenCalled(); // images haven't loaded yet

    images.forEach(img => img.onload());
    await Promise.resolve(); // let the resolved promises flush
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalled();
  });

  it("resolves once every image has fired onerror too (one broken photo doesn't block export)", async () => {
    const done = vi.fn();
    waitForImages(["/api/v1/image?url=a"], 5000).then(done);

    await vi.advanceTimersByTimeAsync(150);
    images.forEach(img => img.onerror());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalled();
  });

  it("resolves via the timeout fallback if an image never fires onload/onerror", async () => {
    const done = vi.fn();
    waitForImages(["/api/v1/image?url=a"], 2000).then(done);

    await vi.advanceTimersByTimeAsync(1999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });
});

// [SF-WEB-19] clearCanvas() no longer morphs back to the hero/landing modal —
// it stays on the graph page (never touches document.body's view-home/
// view-graph classes) with an empty-state card on the canvas instead. [fix]
// That card's own action used to open the docked search (same as the
// rail's "Search artist" button over an already-rendered graph) — now
// opens the full-screen landing modal instead (see the test below and
// clearCanvas's own comment for why).
describe("clearCanvas", () => {
  beforeEach(() => {
    document.body.className = "view-graph";
    els.status = document.createElement("div");
    els.truncationBanner = document.createElement("div");
    els.canvasState = document.createElement("div");
    els.heroInput = document.createElement("input");
    els.pathPanel = document.createElement("div");
    els.hopChain = document.createElement("div");
  });

  it("resets the graph state via resetCanvasToEmpty (keeps hasRendered)", () => {
    clearCanvas();
    expect(resetCanvasToEmpty).toHaveBeenCalledTimes(1);
  });

  it("never touches document.body's view-home/view-graph classes — stays on the graph page", () => {
    clearCanvas();
    expect(document.body.classList.contains("view-graph")).toBe(true);
    expect(document.body.classList.contains("view-home")).toBe(false);
  });

  it("renders the empty-state card on the canvas", () => {
    clearCanvas();
    expect(els.canvasState.querySelector(".ui-panel.ui-state-card")).toBeTruthy();
  });

  // [fix] Was docked search (openSearchModal({ docked: true })) — its own
  // history/autocomplete dropdown wasn't styled for sitting over a blank
  // canvas. The full-screen landing modal is already styled for exactly
  // this "nothing on the canvas yet" moment, so the empty-state card's
  // action opens that instead now.
  it("the empty-state card's action opens the full-screen landing modal, not docked search", () => {
    clearCanvas();
    els.canvasState.querySelector(".ui-state-action").click();
    expect(openSearchModal).toHaveBeenCalledWith();
  });

  // [fix] resetCanvasToEmpty() keeps State.hasRendered true (mocked here,
  // so this test sets it directly to simulate that) — graph.js's render
  // pipeline only calls initGraphOnCanvas() (which closes the search
  // modal) `if (!State.hasRendered)`. Without resetting the flag when the
  // empty-state card opens the full-screen modal, the next successful
  // search would never close it — reported as "после Map it поиск не
  // сворачивается" when reached via Clear → "Search an artist".
  it("the empty-state card's action resets hasRendered so the next search closes the modal again", () => {
    State.hasRendered = true;
    clearCanvas();
    els.canvasState.querySelector(".ui-state-action").click();
    expect(State.hasRendered).toBe(false);
  });

  // [fix] Was `history.replaceState(null, "", window.location.pathname)`,
  // which dropped the #/graph hash router.js (SF-WEB-25) owns — clicking
  // .brand/Clear left the URL bare (http://host/) instead of .../#/graph.
  it("clears the shareable query string but keeps #/graph, not a bare pathname", () => {
    history.pushState(null, "", "/?artist=Test&seed=123#/graph");
    clearCanvas();
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/graph");
  });

  // [SF-WEB-47] A half-picked Compare-mode start node doesn't carry meaning
  // onto the graph resetCanvasToEmpty() is about to leave behind — same
  // reasoning as resetExpansionState clearing State.compareMode itself,
  // just for the rail toggle's own visible state too.
  it("exits Compare mode (silently) when it's active", async () => {
    const { isCompareModeActive, exitCompareMode } = await import("../vis-adapter/index.js");
    isCompareModeActive.mockReturnValue(true);
    clearCanvas();
    expect(exitCompareMode).toHaveBeenCalledWith({ silent: true });
  });

  it("does not touch Compare mode when it's already inactive", async () => {
    const { isCompareModeActive, exitCompareMode } = await import("../vis-adapter/index.js");
    isCompareModeActive.mockReturnValue(false);
    clearCanvas();
    expect(exitCompareMode).not.toHaveBeenCalled();
  });
});

// [fix] .brand (the logo) used to call clearCanvas() directly — same as the
// rail's dedicated "Clear graph" button — landing on the graph page's
// empty-state card rather than an actual "home" experience. goHome() is
// what .brand is wired to now: the same canvas reset, followed immediately
// by the full-screen landing modal (not an intermediate card to click
// through).
describe("goHome", () => {
  beforeEach(() => {
    document.body.className = "view-graph";
    els.status = document.createElement("div");
    els.truncationBanner = document.createElement("div");
    els.canvasState = document.createElement("div");
    els.heroInput = document.createElement("input");
    els.pathPanel = document.createElement("div");
    els.hopChain = document.createElement("div");
  });

  it("resets the canvas (same as clearCanvas) and opens the full-screen landing modal", () => {
    goHome();
    expect(resetCanvasToEmpty).toHaveBeenCalledTimes(1);
    expect(openSearchModal).toHaveBeenCalledWith();
  });

  // [fix] Same reasoning as clearCanvas()'s empty-state action above — see
  // that test's comment. Without this, the modal reported as staying open
  // after "Map it" was exactly this path (goHome() via the logo).
  it("resets hasRendered so the next search closes the modal again", () => {
    State.hasRendered = true;
    goHome();
    expect(State.hasRendered).toBe(false);
  });
});

// [SF-WEB-47] Escape's highest priority is handing click semantics back
// from Compare mode — ahead of every other overlay/panel the same key
// already closes, since Compare mode has fully taken over what a click on
// the canvas does while it's on.
describe("setupKeyboard — Escape and Compare mode", () => {
  beforeEach(() => {
    els.nodeSearchOverlay = document.createElement("div");
    els.network = document.createElement("div");
  });

  it("exits Compare mode on Escape instead of falling through to any other overlay/panel", async () => {
    const { isCompareModeActive, exitCompareMode } = await import("../vis-adapter/index.js");
    isCompareModeActive.mockReturnValue(true);
    const { isPathPanelOpen } = await import("./modals.js");

    const { setupKeyboard } = await import("./canvas-controls.js");
    setupKeyboard();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(exitCompareMode).toHaveBeenCalledWith();
    expect(isPathPanelOpen).not.toHaveBeenCalled();
  });

  it("Escape falls through to the existing chain when Compare mode is inactive", async () => {
    const { isCompareModeActive, exitCompareMode } = await import("../vis-adapter/index.js");
    isCompareModeActive.mockReturnValue(false);
    const { isPathPanelOpen } = await import("./modals.js");
    isPathPanelOpen.mockReturnValue(false);

    const { setupKeyboard } = await import("./canvas-controls.js");
    setupKeyboard();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(exitCompareMode).not.toHaveBeenCalled();
    expect(isPathPanelOpen).toHaveBeenCalled();
  });
});

// [SF-WEB-47 motion] fitView/focusSeed/zoomIn/zoomOut used to hardcode their
// own {duration, easingFunction} literal each and never checked
// prefers-reduced-motion at all — visAnimation(MOTION.x) now covers both.
describe("fitView / focusSeed / zoomIn / zoomOut — motion tokens + reduced-motion", () => {
  beforeEach(() => {
    State.network = {
      fit: vi.fn(),
      focus: vi.fn(),
      moveTo: vi.fn(),
      getScale: vi.fn(() => 1),
    };
    State.currentSeedId = 42;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fitView passes a real {duration, easingFunction} animation normally", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    fitView();
    expect(State.network.fit).toHaveBeenCalledWith({
      animation: { duration: 500, easingFunction: "easeInOutQuad" },
    });
  });

  it("fitView passes animation:false under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    fitView();
    expect(State.network.fit).toHaveBeenCalledWith({ animation: false });
  });

  it("focusSeed passes animation:false under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    focusSeed();
    expect(State.network.focus).toHaveBeenCalledWith(42, { scale: 1.2, locked: false, animation: false });
  });

  it("zoomIn/zoomOut pass animation:false under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    zoomIn();
    zoomOut();
    for (const [call] of State.network.moveTo.mock.calls) {
      expect(call.animation).toBe(false);
    }
  });
});

// [SF-WEB-48] The badge itself is now a quiet dot (see canvas-controls.css)
// — calm by default, .rate-limit-badge--low (unchanged class/threshold)
// "wakes" it via CSS instead of the old always-visible "N/M req/s" text.
// The function's own logic (reading, threshold, once-per-drop toast) is
// untouched — these tests cover what actually changed: the DOM it writes.
describe("updateRateLimitIndicator — quiet live dot ([SF-WEB-48])", () => {
  beforeEach(() => {
    els.rateLimitBadge = document.createElement("span");
    els.rateLimitBadge.hidden = true;
    // Normalizes the module-private "already warned" latch before each
    // test drives its own scenario — a plain headroom call always clears it.
    updateRateLimitIndicator(100, 100);
    showToast.mockClear();
  });

  it("stays calm (no --low class, no toast) with plenty of headroom", () => {
    updateRateLimitIndicator(90, 100);
    expect(els.rateLimitBadge.hidden).toBe(false);
    expect(els.rateLimitBadge.classList.contains("rate-limit-badge--low")).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("'wakes up' (adds --low) once remaining crosses the warn threshold", () => {
    updateRateLimitIndicator(15, 100); // 15% <= the 20% warn ratio
    expect(els.rateLimitBadge.classList.contains("rate-limit-badge--low")).toBe(true);
  });

  it("goes calm again once headroom is restored", () => {
    updateRateLimitIndicator(15, 100);
    expect(els.rateLimitBadge.classList.contains("rate-limit-badge--low")).toBe(true);
    updateRateLimitIndicator(80, 100);
    expect(els.rateLimitBadge.classList.contains("rate-limit-badge--low")).toBe(false);
  });

  it("no longer renders the raw 'N/M req/s' as visible text — moves it to the hover title instead", () => {
    updateRateLimitIndicator(3, 100);
    expect(els.rateLimitBadge.textContent.trim()).toBe("");
    expect(els.rateLimitBadge.title).toContain("3");
    expect(els.rateLimitBadge.title).toContain("100");
  });

  it("toast threshold/behavior is unchanged: fires once on crossing into --low, not on every subsequent still-low update", () => {
    updateRateLimitIndicator(15, 100);
    expect(showToast).toHaveBeenCalledTimes(1);
    updateRateLimitIndicator(10, 100); // still low — no repeat
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("re-fires the toast after recovering and dropping low again", () => {
    updateRateLimitIndicator(15, 100);
    expect(showToast).toHaveBeenCalledTimes(1);
    updateRateLimitIndicator(80, 100); // recovers
    updateRateLimitIndicator(15, 100); // drops low again
    expect(showToast).toHaveBeenCalledTimes(2);
  });
});
