// ════════════════════════════════════════════════════════════════════════════
// ui/canvas-controls.test.js — SF-WEB-05: updateScanStatus reflects the
//                                inline data-completeness indicator through a
//                                sequence of mock /api/v1/status/stream
//                                events (partial → background scan → full).
//                                SF-WEB-04: buildGraphExportData/
//                                exportGraphJson — the JSON export's data
//                                shape and its "nothing to export" guard.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from "vitest";
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { updateScanStatus, buildGraphExportData, exportGraphJson, setupFilterToggles } from "./canvas-controls.js";
import { showToast } from "./toast.js";
import { searchArtist } from "../api/api.js";
import { updateShareableUrl } from "./history.js";

vi.mock("./toast.js", () => ({ showToast: vi.fn(), hideToast: vi.fn() }));
vi.mock("../api/api.js", () => ({ searchArtist: vi.fn(), showMoreCollaborations: vi.fn() }));
vi.mock("./history.js", () => ({ updateShareableUrl: vi.fn() }));
vi.mock("../vis-adapter/index.js", () => ({ clearFocus: vi.fn(), destroyNetwork: vi.fn(), networkOptions: vi.fn() }));
vi.mock("../api/analytics-client.js", () => ({ clearPathHighlight: vi.fn() }));
vi.mock("../dom/canvas-decorator.js", () => ({ startCanvasDecorator: vi.fn() }));
vi.mock("../dom/transition.js", () => ({ runHeroGraphTransition: vi.fn() }));
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
