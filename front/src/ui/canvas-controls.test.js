import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  updateScanStatus,
  buildGraphExportData,
  exportGraphJson,
  setupFilterToggles,
  buildShadowNodes,
  waitForImages,
  clearCanvas,
  goHome,
  fitView,
  focusSeed,
  zoomIn,
  zoomOut,
  updateRateLimitIndicator,
  _computeFitView,
  _drawExportBackground,
  setupBubbleSetsToggle,
  focusNextHub,
  _resetHubFocusIndex,
  setupKeyboard,
  updateStatus,
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
  clearFocus: vi.fn(),
  resetCanvasToEmpty: vi.fn(),
  networkOptions: vi.fn(),
  isCompareModeActive: vi.fn(() => false),
  exitCompareMode: vi.fn(),
  selectNode: vi.fn(),
}));
vi.mock("../api/analytics-client.js", () => ({ clearPathHighlight: vi.fn() }));
vi.mock("../dom/canvas-decorator.js", () => ({ startCanvasDecorator: vi.fn() }));
vi.mock("./modals.js", () => ({
  isSearchModalOpen: vi.fn(),
  closeSearchModal: vi.fn(),
  openSearchModal: vi.fn(),
  isPathPanelOpen: vi.fn(),
  closePathPanel: vi.fn(),
  closeNodeSearch: vi.fn(),
  openNodeSearch: vi.fn(),
}));
vi.mock("./sidebar.js", () => ({ hideArtistSidebar: vi.fn() }));
vi.mock("./candidate-picker.js", () => ({ hideCandidatePicker: vi.fn() }));
vi.mock("./settings-panel.js", () => ({
  isSettingsPanelOpen: vi.fn(() => false),
  closeSettingsPanel: vi.fn(),
}));

beforeEach(() => {
  els.scanStatusBadge = document.createElement("span");
  els.scanStatusBadge.hidden = true;
  els.scanStatusText = document.createElement("span");
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
    const observed = events.map((e) => {
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
      {
        id: 1,
        name: "Seed Artist",
        imageUrl: "https://img/seed.jpg",
        geniusUrl: "https://genius.com/seed",
        isSeed: true,
        _isNew: false,
        _dimBorder: "#111",
        _accent: "#8FA6C9",
        _dominantRole: "featured",
      },
      {
        id: 2,
        name: "Collaborator",
        imageUrl: "",
        geniusUrl: null,
        isSeed: false,
        _isNew: true,
        _expandParent: 1,
      },
    ];
    State.graphEdges = [
      {
        id: "1_2",
        from: 1,
        to: 2,
        weight: 3,
        dominantRole: "featured",
        collaboration_count: 3,
        songs: ["Track A"],
        collaborations: [{ song: "Track A", roles: ["featured"] }],
      },
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
      {
        id: 1,
        name: "Seed Artist",
        imageUrl: "https://img/seed.jpg",
        geniusUrl: "https://genius.com/seed",
        isSeed: true,
      },
      { id: 2, name: "Collaborator", imageUrl: null, geniusUrl: null, isSeed: false },
    ]);
    expect(data.edges).toEqual([
      {
        id: "1_2",
        from: 1,
        to: 2,
        weight: 3,
        dominantRole: "featured",
        collaboration_count: 3,
        songs: ["Track A"],
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
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to export"),
      expect.anything(),
    );
  });
});

describe("setupFilterToggles — SF-WEB-30", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    State.activeFilters = new Set(["featured", "producer", "writer"]);
    els.heroInput = document.createElement("input");
    els.canvasFilterFeatured = document.createElement("button");
    els.canvasFilterProducer = document.createElement("button");
    els.canvasFilterWriter = document.createElement("button");
    els.heroFilterFeatured = document.createElement("button");
    els.heroFilterProducer = document.createElement("button");
    els.heroFilterWriter = document.createElement("button");
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

describe("setupBubbleSetsToggle — SF-WEB-61", () => {
  beforeEach(() => {
    State.bubbleSetsEnabled = false;
    els.btnBubbleSets = document.createElement("button");
    State.network = { redraw: vi.fn() };
    setupBubbleSetsToggle();
  });

  it("starts OFF (not marked active) — no auto-management by node count or anything else", () => {
    expect(els.btnBubbleSets.classList.contains("active")).toBe(false);
    expect(els.btnBubbleSets.getAttribute("aria-pressed")).toBe("false");
  });

  it("turns on when clicked, marking the button active and redrawing", () => {
    els.btnBubbleSets.click();
    expect(State.bubbleSetsEnabled).toBe(true);
    expect(els.btnBubbleSets.classList.contains("active")).toBe(true);
    expect(els.btnBubbleSets.getAttribute("aria-pressed")).toBe("true");
    expect(State.network.redraw).toHaveBeenCalled();
  });

  it("turns back off on a second click", () => {
    els.btnBubbleSets.click();
    els.btnBubbleSets.click();
    expect(State.bubbleSetsEnabled).toBe(false);
    expect(els.btnBubbleSets.classList.contains("active")).toBe(false);
  });
});

describe("buildShadowNodes — SF-WEB-32", () => {
  const graphNodes = [
    {
      id: 1,
      name: "Has Photo",
      isSeed: true,
      imageUrl: "https://images.genius.com/real-photo.jpg",
    },
    { id: 2, name: "No Photo", isSeed: false, imageUrl: "" },
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
    const node1 = shadowNodes.find((n) => n.id === 1);
    expect(node1.image).toBe(
      `/api/v1/image?url=${encodeURIComponent("https://images.genius.com/real-photo.jpg")}`,
    );
  });

  it("keeps the local placeholder as brokenImage even for a node with a real photo", () => {
    const { shadowNodes } = buildShadowNodes(nodeItems, graphNodes, positions);
    const node1 = shadowNodes.find((n) => n.id === 1);
    expect(node1.brokenImage).toBe(placeholderFor("Has Photo", true));
    expect(node1.brokenImage).not.toBe(node1.image);
  });

  it("uses the local placeholder for both image and brokenImage when there is no real photo", () => {
    const { shadowNodes } = buildShadowNodes(nodeItems, graphNodes, positions);
    const node2 = shadowNodes.find((n) => n.id === 2);
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
    const node1 = shadowNodes.find((n) => n.id === 1);
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

describe("_computeFitView — SF-WEB-59", () => {
  it("centers the view on the midpoint of all node positions, not just the visible ones", () => {
    const positions = { 1: { x: 0, y: 0 }, 2: { x: 200, y: 0 } };
    const { position } = _computeFitView(positions, [1, 2], 1000, 1000);
    expect(position).toEqual({ x: 100, y: 0 });
  });

  it("picks a scale that fits the whole bounding box (plus margin) inside the canvas", () => {
    const positions = { 1: { x: -500, y: 0 }, 2: { x: 500, y: 0 } };
    const { scale } = _computeFitView(positions, [1, 2], 1000, 1000, 100);
    expect(scale).toBeCloseTo(1000 / 1200, 5);
  });

  it("caps the scale so a tiny (1-2 node) graph doesn't zoom in absurdly far", () => {
    const positions = { 1: { x: 0, y: 0 }, 2: { x: 1, y: 0 } };
    const { scale } = _computeFitView(positions, [1, 2], 2400, 1500, 140);
    expect(scale).toBeLessThanOrEqual(3);
  });

  it("falls back to a sane default (origin, scale 1) when no positions are available at all", () => {
    const result = _computeFitView({}, [1, 2, 3], 1000, 1000);
    expect(result).toEqual({ position: { x: 0, y: 0 }, scale: 1 });
  });

  it("ignores ids with no matching position instead of treating them as (0,0)", () => {
    const positions = { 1: { x: 500, y: 500 }, 2: { x: 520, y: 500 } };
    const { position } = _computeFitView(positions, [1, 2, 3], 1000, 1000);
    expect(position.x).toBeCloseTo(510, 5);
  });
});

describe("_drawExportBackground — SF-WEB-59", () => {
  it("fills the whole physical canvas in device-pixel space, resetting any world-space transform first", () => {
    const calls = [];
    const ctx = {
      canvas: { width: 800, height: 600 },
      save() {
        calls.push(["save"]);
      },
      restore() {
        calls.push(["restore"]);
      },
      setTransform(...args) {
        calls.push(["setTransform", ...args]);
      },
      fillRect(...args) {
        calls.push(["fillRect", ...args]);
      },
      set fillStyle(v) {
        calls.push(["fillStyle", v]);
      },
    };
    _drawExportBackground(ctx);
    expect(calls[0]).toEqual(["save"]);
    expect(calls).toContainEqual(["setTransform", 1, 0, 0, 1, 0, 0]);
    expect(calls).toContainEqual(["fillRect", 0, 0, 800, 600]);
    expect(calls[calls.length - 1]).toEqual(["restore"]);
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

    await vi.advanceTimersByTimeAsync(150);
    expect(done).not.toHaveBeenCalled();
    images.forEach((img) => img.onload());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toHaveBeenCalled();
  });

  it("resolves once every image has fired onerror too (one broken photo doesn't block export)", async () => {
    const done = vi.fn();
    waitForImages(["/api/v1/image?url=a"], 5000).then(done);

    await vi.advanceTimersByTimeAsync(150);
    images.forEach((img) => img.onerror());
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

  it("the empty-state card's action opens the full-screen landing modal, not docked search", () => {
    clearCanvas();
    els.canvasState.querySelector(".ui-state-action").click();
    expect(openSearchModal).toHaveBeenCalledWith();
  });

  it("the empty-state card's action resets hasRendered so the next search closes the modal again", () => {
    State.hasRendered = true;
    clearCanvas();
    els.canvasState.querySelector(".ui-state-action").click();
    expect(State.hasRendered).toBe(false);
  });

  it("clears the shareable query string but keeps #/graph, not a bare pathname", () => {
    history.pushState(null, "", "/?artist=Test&seed=123#/graph");
    clearCanvas();
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/graph");
  });

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

  it("resets hasRendered so the next search closes the modal again", () => {
    State.hasRendered = true;
    goHome();
    expect(State.hasRendered).toBe(false);
  });
});

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

  it("ArrowRight/ArrowLeft call focusNextHub via the real keydown listener", async () => {
    State.network = { focus: vi.fn() };
    State.currentSeedId = 1;
    State.expandedNodes = new Set();
    State.selectedNodeId = null;
    _resetHubFocusIndex();

    const { setupKeyboard } = await import("./canvas-controls.js");
    setupKeyboard();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));

    expect(State.network.focus).toHaveBeenCalledWith(1, expect.objectContaining({ scale: 1.2 }));
  });

  it("does not hijack ArrowRight when a modifier key is held (e.g. Alt+Right browser history nav)", async () => {
    State.network = { focus: vi.fn() };
    State.currentSeedId = 1;
    State.expandedNodes = new Set();
    _resetHubFocusIndex();

    const { setupKeyboard } = await import("./canvas-controls.js");
    setupKeyboard();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true }));

    expect(State.network.focus).not.toHaveBeenCalled();
  });
});

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
    expect(State.network.focus).toHaveBeenCalledWith(42, {
      scale: 1.2,
      locked: false,
      animation: false,
    });
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

describe("focusNextHub — keyboard navigation between hubs (SF-WEB-62)", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    State.network = { focus: vi.fn() };
    State.currentSeedId = 1;
    State.expandedNodes = new Set([5, 3]);
    State.selectedNodeId = null;
    _resetHubFocusIndex();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts at the seed on the first forward call", () => {
    focusNextHub(1);
    expect(State.network.focus).toHaveBeenCalledWith(1, expect.objectContaining({ scale: 1.2 }));
  });

  it("cycles forward through poles in sorted-id order after the seed", () => {
    focusNextHub(1);
    focusNextHub(1);
    focusNextHub(1);
    const order = State.network.focus.mock.calls.map(([id]) => id);
    expect(order).toEqual([1, 3, 5]);
  });

  it("wraps back to the seed after the last hub", () => {
    focusNextHub(1);
    focusNextHub(1);
    focusNextHub(1);
    focusNextHub(1);
    expect(State.network.focus).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ scale: 1.2 }),
    );
  });

  it("cycles backward with direction -1", () => {
    focusNextHub(1);
    focusNextHub(-1);
    expect(State.network.focus).toHaveBeenLastCalledWith(
      5,
      expect.objectContaining({ scale: 1.2 }),
    );
  });

  it("does nothing when there is no seed and no expanded nodes", () => {
    State.currentSeedId = null;
    State.expandedNodes = new Set();
    focusNextHub(1);
    expect(State.network.focus).not.toHaveBeenCalled();
  });

  it("starts cycling from the currently-selected node if it's one of the hubs", () => {
    State.selectedNodeId = 3;
    focusNextHub(1);
    expect(State.network.focus).toHaveBeenCalledWith(5, expect.objectContaining({ scale: 1.2 }));
  });

  it("exits Compare mode instead of navigating when a pick is in progress", async () => {
    const { isCompareModeActive, exitCompareMode } = await import("../vis-adapter/index.js");
    isCompareModeActive.mockReturnValue(true);

    focusNextHub(1);

    expect(exitCompareMode).toHaveBeenCalledTimes(1);
    expect(State.network.focus).not.toHaveBeenCalled();
  });
});

describe("updateRateLimitIndicator — quiet live dot ([SF-WEB-48])", () => {
  beforeEach(() => {
    els.rateLimitBadge = document.createElement("span");
    els.rateLimitBadge.hidden = true;
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
    updateRateLimitIndicator(15, 100);
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
    updateRateLimitIndicator(10, 100);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("re-fires the toast after recovering and dropping low again", () => {
    updateRateLimitIndicator(15, 100);
    expect(showToast).toHaveBeenCalledTimes(1);
    updateRateLimitIndicator(80, 100);
    updateRateLimitIndicator(15, 100);
    expect(showToast).toHaveBeenCalledTimes(2);
  });
});

describe("setupKeyboard", () => {
  let modals, compare, settings, candidatePicker;
  // Обработчик вешается на document и снять его нечем, поэтому ставим его
  // ровно один раз на весь блок — иначе каждый следующий тест ловил бы
  // событие столько раз, сколько тестов уже отработало.
  let keyboardAttached = false;

  const press = (key, opts = {}) =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts }));

  beforeEach(async () => {
    document.body.innerHTML = `
      <div id="node-search-overlay"></div>
      <div id="help-overlay"></div>
      <div id="candidate-overlay"></div>
      <input id="hero-input" />`;
    els.nodeSearchOverlay = document.getElementById("node-search-overlay");
    els.helpOverlay = document.getElementById("help-overlay");
    els.candidateOverlay = document.getElementById("candidate-overlay");
    els.heroInput = document.getElementById("hero-input");

    modals = await import("./modals.js");
    compare = await import("../vis-adapter/index.js");
    settings = await import("./settings-panel.js");
    candidatePicker = await import("./candidate-picker.js");

    vi.clearAllMocks();
    modals.isSearchModalOpen.mockReturnValue(false);
    modals.isPathPanelOpen.mockReturnValue(false);
    compare.isCompareModeActive.mockReturnValue(false);
    settings.isSettingsPanelOpen.mockReturnValue(false);

    State.hasRendered = false;
    State.pathHighlight = null;
    State.network = { fit: vi.fn(), moveTo: vi.fn(), getScale: () => 1, focus: vi.fn() };
    State.graphNodes = [];
    State.currentSeedId = null;

    if (!keyboardAttached) {
      setupKeyboard();
      keyboardAttached = true;
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("toggles the node search with Cmd/Ctrl+K", () => {
    press("k", { metaKey: true });
    expect(modals.openNodeSearch).toHaveBeenCalled();

    els.nodeSearchOverlay.classList.add("show");
    press("K", { ctrlKey: true });
    expect(modals.closeNodeSearch).toHaveBeenCalled();
  });

  // Escape разбирается по приоритету: сначала самый «верхний» слой.
  it("Escape leaves compare mode before anything else", () => {
    compare.isCompareModeActive.mockReturnValue(true);
    els.helpOverlay.classList.add("show");

    press("Escape");

    expect(compare.exitCompareMode).toHaveBeenCalled();
    expect(els.helpOverlay.classList.contains("show")).toBe(true);
  });

  it("Escape then closes the help overlay", () => {
    els.helpOverlay.classList.add("show");

    press("Escape");

    expect(els.helpOverlay.classList.contains("show")).toBe(false);
  });

  it("Escape then closes the candidate picker", () => {
    els.candidateOverlay.classList.add("show");
    settings.isSettingsPanelOpen.mockReturnValue(true);

    press("Escape");

    expect(candidatePicker.hideCandidatePicker).toHaveBeenCalled();
    expect(settings.closeSettingsPanel).not.toHaveBeenCalled();
  });

  it("Escape then closes Settings", () => {
    settings.isSettingsPanelOpen.mockReturnValue(true);
    els.nodeSearchOverlay.classList.add("show");

    press("Escape");

    expect(settings.closeSettingsPanel).toHaveBeenCalled();
    expect(modals.closeNodeSearch).not.toHaveBeenCalled();
  });

  it("Escape then closes the node search", () => {
    els.nodeSearchOverlay.classList.add("show");
    State.hasRendered = true;
    modals.isSearchModalOpen.mockReturnValue(true);

    press("Escape");

    expect(modals.closeNodeSearch).toHaveBeenCalled();
    expect(modals.closeSearchModal).not.toHaveBeenCalled();
  });

  it("Escape closes the search modal only once a graph is on screen", () => {
    modals.isSearchModalOpen.mockReturnValue(true);
    State.hasRendered = false;

    press("Escape");
    expect(modals.closeSearchModal).not.toHaveBeenCalled();

    State.hasRendered = true;
    press("Escape");
    expect(modals.closeSearchModal).toHaveBeenCalled();
  });

  it("Escape then closes the path panel", () => {
    modals.isPathPanelOpen.mockReturnValue(true);
    State.pathHighlight = { a: 1 };

    press("Escape");

    expect(modals.closePathPanel).toHaveBeenCalled();
  });

  it("Escape then clears a path highlight", async () => {
    const { clearPathHighlight } = await import("../api/analytics-client.js");
    State.pathHighlight = { a: 1 };

    press("Escape");

    expect(clearPathHighlight).toHaveBeenCalled();
  });

  it("Escape with nothing open falls back to re-centring the seed", () => {
    State.currentSeedId = 1;

    press("Escape");

    expect(State.network.focus).toHaveBeenCalledWith(1, expect.objectContaining({ scale: 1.2 }));
  });

  it("ignores shortcuts while the user is typing", () => {
    const input = els.heroInput;
    input.focus();

    press("f");
    press("+");

    expect(State.network.fit).not.toHaveBeenCalled();
    expect(State.network.moveTo).not.toHaveBeenCalled();
  });

  it("still handles Cmd+K and Escape from inside a field", () => {
    els.heroInput.focus();

    press("k", { metaKey: true });

    expect(modals.openNodeSearch).toHaveBeenCalled();
  });

  it("walks between hubs with the arrow keys", () => {
    State.graphNodes = [
      { id: 1, name: "A", isSeed: true },
      { id: 2, name: "B" },
    ];
    State.expandedNodes = new Set([2]);
    State.currentSeedId = 1;

    press("ArrowRight");
    press("ArrowLeft");

    expect(State.network.focus).toHaveBeenCalled();
  });

  it("leaves arrow keys alone when a modifier is held", () => {
    State.graphNodes = [{ id: 1, name: "A", isSeed: true }];
    State.currentSeedId = 1;

    press("ArrowRight", { shiftKey: true });
    press("ArrowRight", { altKey: true });
    press("ArrowRight", { ctrlKey: true });

    expect(State.network.focus).not.toHaveBeenCalled();
  });

  it("fits the view with f", () => {
    press("f");
    expect(State.network.fit).toHaveBeenCalled();
  });

  it("zooms in on + or = and out on - or _", () => {
    press("+");
    press("=");
    const zoomedIn = State.network.moveTo.mock.calls.map((c) => c[0].scale);
    expect(zoomedIn.every((s) => s > 1)).toBe(true);

    State.network.moveTo.mockClear();
    press("-");
    press("_");
    const zoomedOut = State.network.moveTo.mock.calls.map((c) => c[0].scale);
    expect(zoomedOut.length).toBeGreaterThan(0);
    expect(zoomedOut.every((s) => s < 1)).toBe(true);
  });

  it("opens the help overlay with ?", () => {
    press("?");
    expect(els.helpOverlay.classList.contains("show")).toBe(true);
  });

  it("ignores keys it has no shortcut for", () => {
    press("q");
    expect(State.network.fit).not.toHaveBeenCalled();
    expect(State.network.moveTo).not.toHaveBeenCalled();
  });
});

describe("updateStatus", () => {
  beforeEach(() => {
    document.body.innerHTML = `<input id="hero-input" /><span id="seed-card-name"></span><img id="seed-card-avatar" />`;
    els.heroInput = document.getElementById("hero-input");
    els.seedCardName = document.getElementById("seed-card-name");
    els.seedCardAvatar = document.getElementById("seed-card-avatar");
    State.graphNodes = [];
    State.currentSeedId = null;
  });

  it("names the seed from the graph payload", () => {
    updateStatus({ seed: "Drake" });
    expect(els.seedCardName.textContent).toBe("Drake");
  });

  it("falls back to the seed node's own name", () => {
    State.graphNodes = [{ id: 5, name: "Future", imageUrl: "" }];
    State.currentSeedId = 5;

    updateStatus({});

    expect(els.seedCardName.textContent).toBe("Future");
  });

  it("then falls back to whatever is typed in the search field", () => {
    els.heroInput.value = "Rosalía";
    updateStatus({});
    expect(els.seedCardName.textContent).toBe("Rosalía");
  });

  it("shows a dash when there is nothing to name at all", () => {
    updateStatus({});
    expect(els.seedCardName.textContent).toBe("—");
  });

  it("uses the seed's photo when there is one", () => {
    State.graphNodes = [{ id: 5, name: "Future", imageUrl: "http://img/f.jpg" }];
    State.currentSeedId = 5;

    updateStatus({});

    expect(els.seedCardAvatar.src).toContain("http://img/f.jpg");
  });

  it("swaps in a placeholder if the photo fails to load, only once", () => {
    State.graphNodes = [{ id: 5, name: "Future", imageUrl: "http://img/broken.jpg" }];
    State.currentSeedId = 5;
    updateStatus({});

    els.seedCardAvatar.onerror();

    expect(els.seedCardAvatar.onerror).toBeNull();
    expect(els.seedCardAvatar.src).toBe(placeholderFor("Future", true));
  });

  it("works on a page without the seed card", () => {
    els.seedCardName = null;
    els.seedCardAvatar = null;
    expect(() => updateStatus({ seed: "Drake" })).not.toThrow();
  });
});

describe("focusNextHub", () => {
  beforeEach(async () => {
    const compare = await import("../vis-adapter/index.js");
    compare.isCompareModeActive.mockReturnValue(false);
    _resetHubFocusIndex();
    State.network = { focus: vi.fn() };
    State.currentSeedId = 1;
    State.expandedNodes = new Set([3, 2]);
    State.selectedNodeId = null;
  });

  it("walks forward through the seed and every expanded hub", () => {
    focusNextHub(1);
    expect(State.network.focus).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ scale: 1.2 }),
    );

    focusNextHub(1);
    expect(State.network.focus).toHaveBeenLastCalledWith(2, expect.anything());

    focusNextHub(1);
    expect(State.network.focus).toHaveBeenLastCalledWith(3, expect.anything());
  });

  it("wraps around at both ends", () => {
    focusNextHub(1);
    focusNextHub(1);
    focusNextHub(1);
    focusNextHub(1);
    expect(State.network.focus).toHaveBeenLastCalledWith(1, expect.anything());

    focusNextHub(-1);
    expect(State.network.focus).toHaveBeenLastCalledWith(3, expect.anything());
  });

  it("continues from whatever node is currently selected", () => {
    State.selectedNodeId = 3;

    focusNextHub(1);

    expect(State.network.focus).toHaveBeenLastCalledWith(1, expect.anything());
  });

  it("ignores a selection that is not itself a hub", () => {
    State.selectedNodeId = 99;

    focusNextHub(1);

    expect(State.network.focus).toHaveBeenCalled();
  });

  it("leaves compare mode instead of moving the camera", async () => {
    const compare = await import("../vis-adapter/index.js");
    compare.isCompareModeActive.mockReturnValue(true);

    focusNextHub(1);

    expect(compare.exitCompareMode).toHaveBeenCalled();
    expect(State.network.focus).not.toHaveBeenCalled();
  });

  it("does nothing when there are no hubs at all", () => {
    State.currentSeedId = null;
    State.expandedNodes = new Set();

    focusNextHub(1);

    expect(State.network.focus).not.toHaveBeenCalled();
  });

  it("does nothing without a rendered network", () => {
    State.network = null;
    expect(() => focusNextHub(1)).not.toThrow();
  });
});

describe("zoomIn / zoomOut", () => {
  it("scales the camera up and down around the current scale", () => {
    State.network = { getScale: () => 2, moveTo: vi.fn() };

    zoomIn();
    expect(State.network.moveTo).toHaveBeenLastCalledWith(expect.objectContaining({ scale: 2.5 }));

    zoomOut();
    expect(State.network.moveTo).toHaveBeenLastCalledWith(expect.objectContaining({ scale: 1.6 }));
  });

  it("does nothing without a rendered network", () => {
    State.network = null;
    expect(() => zoomIn()).not.toThrow();
    expect(() => zoomOut()).not.toThrow();
  });
});
