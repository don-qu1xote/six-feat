// ════════════════════════════════════════════════════════════════════════════
// sidebar.test.js — [SF-WEB-12] unit tests for the companion panel's
//                    node/edge context (ui/sidebar.js).
//
// Asserts the two things the ticket cares about: (1) node vs edge context
// render into the right static tiles with the right content, and (2) doing
// so never creates new DOM elements (the ensureTile()-style dynamic grid-
// tile insertion this ticket removes) — every tile referenced here is
// assigned once in beforeEach, exactly like the real static markup in
// index.html, and a document.createElement spy proves sidebar.js never
// reaches for a fresh one.
//
// Path context (openPathPanel/closePathPanel mutual exclusivity with node/
// edge context) is covered separately in modals.test.js, since that's where
// the actual show/hide logic for the path section lives.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../vis-adapter/index.js", () => ({
  openGeniusPage: vi.fn(),
  highlightEdgePair: vi.fn(),
  selectEdge: vi.fn(),
  clearSelectedEdge: vi.fn(),
}));
vi.mock("../api/analytics-client.js", () => ({ bfsPath: vi.fn(() => null) }));
vi.mock("./modals.js", () => ({
  isSearchModalOpen: vi.fn(() => false),
  closeSearchModal: vi.fn(),
  closeNodeSearch: vi.fn(),
  closePathPanel: vi.fn(),
}));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { showArtistSidebar, showEdgeSidebar, hideArtistSidebar } from "./sidebar.js";
import { closePathPanel } from "./modals.js";

function freshEl(tag = "div") { return document.createElement(tag); }

beforeEach(() => {
  vi.clearAllMocks();
  State.graphNodes = [];
  State.graphEdges = [];
  State.currentSeedId = null;
  State.expandedNodes = new Set();

  els.companionPanel = freshEl();
  els.artistSidebar   = freshEl();
  els.pathPanel        = freshEl();
  els.searchModal      = freshEl();
  els.sidebarAvatar    = freshEl("img");
  els.sidebarName      = freshEl();
  els.sidebarMeta      = freshEl();
  els.sidebarTracks    = freshEl();
  els.sidebarRoleBreakdownTile = freshEl();
  els.sidebarRoleChips         = freshEl();
  els.sidebarPathTile          = freshEl();
  els.sidebarPathTrack         = freshEl();
  els.sidebarGenius    = freshEl("button");
});

function mockNode(overrides = {}) {
  return {
    id: 1, name: "Drake", imageUrl: "", isSeed: false,
    _totalCollabs: 5, _topTracks: [{ song: "God's Plan", roles: ["featured"] }],
    ...overrides,
  };
}

describe("showArtistSidebar (node context)", () => {
  it("renders name/meta/tracks and shows the companion panel", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);

    expect(els.sidebarName.textContent).toBe("Drake");
    expect(els.sidebarMeta.textContent).toContain("5 collabs");
    expect(els.sidebarTracks.innerHTML).toContain("God's Plan");
    expect(els.artistSidebar.classList.contains("show")).toBe(true);
    expect(els.companionPanel.classList.contains("show")).toBe(true);
  });

  it("populates the static role-breakdown tile and shows it, without touching the path tile's visibility when there is no seed", () => {
    State.graphNodes = [mockNode()];
    State.graphEdges = [{ from: 1, to: 2, dominantRole: "producer" }];
    showArtistSidebar(1);

    expect(els.sidebarRoleBreakdownTile.style.display).toBe("");
    expect(els.sidebarRoleChips.innerHTML).toContain("role-chip--producer");
    // No current seed → getPathToSeed() is null → tile stays hidden.
    expect(els.sidebarPathTile.style.display).toBe("none");
  });

  it("shows the Genius button and wires it to openGeniusPage(nodeId)", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    expect(els.sidebarGenius.style.display).toBe("");
    expect(typeof els.sidebarGenius.onclick).toBe("function");
  });

  it("closes the path section before showing node context (mutual exclusivity)", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    expect(closePathPanel).toHaveBeenCalled();
  });

  it("never creates new DOM elements — no dynamically-inserted grid tiles", () => {
    State.graphNodes = [mockNode()];
    const createSpy = vi.spyOn(document, "createElement");
    showArtistSidebar(1);
    showArtistSidebar(1);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe("showEdgeSidebar (edge context)", () => {
  function mockEdge(overrides = {}) {
    return {
      id: "1_2", from: 1, to: 2, weight: 3, dominantRole: "featured",
      collaborations: [{ song: "Jumpman", roles: ["featured"] }],
      ...overrides,
    };
  }

  it("renders the shared header/tracks section reused from node context, without duplicating it", () => {
    State.graphEdges = [mockEdge()];
    showEdgeSidebar("1_2", { 1: "Drake", 2: "Future" });

    expect(els.sidebarName.textContent).toBe("Drake × Future");
    expect(els.sidebarTracks.innerHTML).toContain("Jumpman");
    expect(els.artistSidebar.classList.contains("show")).toBe(true);
    expect(els.companionPanel.classList.contains("show")).toBe(true);
  });

  it("hides the node-only tiles (role breakdown, path-to-seed, Genius button) — they only make sense for a single artist", () => {
    State.graphEdges = [mockEdge()];
    showEdgeSidebar("1_2", {});

    expect(els.sidebarRoleBreakdownTile.style.display).toBe("none");
    expect(els.sidebarPathTile.style.display).toBe("none");
    expect(els.sidebarGenius.style.display).toBe("none");
  });

  it("closes the path section before showing edge context (mutual exclusivity)", () => {
    State.graphEdges = [mockEdge()];
    showEdgeSidebar("1_2", {});
    expect(closePathPanel).toHaveBeenCalled();
  });

  it("does nothing for an unknown edge id", () => {
    State.graphEdges = [];
    showEdgeSidebar("nope", {});
    expect(els.artistSidebar.classList.contains("show")).toBe(false);
  });
});

describe("hideArtistSidebar", () => {
  it("hides both the sidebar section and the companion panel", () => {
    els.artistSidebar.classList.add("show");
    els.companionPanel.classList.add("show");
    hideArtistSidebar();
    expect(els.artistSidebar.classList.contains("show")).toBe(false);
    expect(els.companionPanel.classList.contains("show")).toBe(false);
  });
});
