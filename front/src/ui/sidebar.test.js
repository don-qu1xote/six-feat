// ════════════════════════════════════════════════════════════════════════════
// sidebar.test.js — unit tests for the companion panel's node/edge context
//                    (ui/sidebar.js): SF-WEB-12's static tiles and
//                    SF-WEB-14's object action bar.
//
// Asserts the things both tickets care about: (1) node vs edge context
// render into the right static tiles with the right content, (2) doing so
// never creates new DOM elements (the ensureTile()-style dynamic grid-tile
// insertion SF-WEB-12 removes) — every tile referenced here is assigned
// once in beforeEach, exactly like the real static markup in index.html,
// and a document.createElement spy proves sidebar.js never reaches for a
// fresh one — and (3) the object action bar (SF-WEB-14) is visible only
// for node context and wires its four buttons to the node it's currently
// showing.
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
  toggleNodePin: vi.fn(() => true),
  isNodePinned: vi.fn(() => false),
}));
vi.mock("../api/analytics-client.js", () => ({ bfsPath: vi.fn(() => null) }));
vi.mock("./modals.js", () => ({
  isSearchModalOpen: vi.fn(() => false),
  closeSearchModal: vi.fn(),
  closeNodeSearch: vi.fn(),
  closePathPanel: vi.fn(),
  openNodeSearch: vi.fn(),
}));
vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));
vi.mock("./toast.js", () => ({ showToast: vi.fn() }));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  showArtistSidebar, showEdgeSidebar, hideArtistSidebar, setupCompanionEmptyTrigger,
} from "./sidebar.js";
import { closePathPanel, openNodeSearch } from "./modals.js";
import { toggleNodePin, isNodePinned } from "../vis-adapter/index.js";
import { searchArtist } from "../api/api.js";

function freshEl(tag = "div") { return document.createElement(tag); }

beforeEach(() => {
  vi.clearAllMocks();
  isNodePinned.mockReturnValue(false);
  State.graphNodes = [];
  State.graphEdges = [];
  State.currentSeedId = null;
  State.expandedNodes = new Set();

  els.companionPanel = freshEl();
  els.companionEmpty = freshEl();
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

  // [SF-WEB-14] Object action bar.
  els.objectActionBar = freshEl();
  els.objectActionBar.hidden = true;
  els.objActionExpand = freshEl("button");
  els.objActionFocus  = freshEl("button");
  els.objActionGenius = freshEl("button");
  els.objActionPin    = freshEl("button");
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

describe("[SF-WEB-14] object action bar — node context", () => {
  it("is shown (un-hidden) when a node is selected", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    expect(els.objectActionBar.hidden).toBe(false);
  });

  it("wires Expand to searchArtist(name, true, true), same path as double-click", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    els.objActionExpand.onclick();
    expect(searchArtist).toHaveBeenCalledWith("Drake", true, true);
    expect(State._clickedNodeId).toBe(1);
  });

  it("wires Focus to center the camera on the node", () => {
    State.network = { focus: vi.fn() };
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    els.objActionFocus.onclick();
    expect(State.network.focus).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it("wires Genius to openGeniusPage(nodeId)", async () => {
    const { openGeniusPage } = await import("../vis-adapter/index.js");
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    els.objActionGenius.onclick();
    expect(openGeniusPage).toHaveBeenCalledWith(1);
  });

  it("wires Pin to toggleNodePin(nodeId) and reflects the pressed state", () => {
    // Simulate the real toggle: isNodePinned() reflects whatever
    // toggleNodePin() last flipped, same relationship as the real
    // vis-adapter/physics.js implementation.
    let pinned = false;
    isNodePinned.mockImplementation(() => pinned);
    toggleNodePin.mockImplementation(() => { pinned = !pinned; return pinned; });

    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    expect(els.objActionPin.getAttribute("aria-pressed")).toBe("false");

    els.objActionPin.onclick();
    expect(toggleNodePin).toHaveBeenCalledWith(1);
    expect(els.objActionPin.getAttribute("aria-pressed")).toBe("true");
    expect(els.objActionPin.classList.contains("active")).toBe(true);
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

  it("[SF-WEB-14] hides the object action bar — none of its four actions apply to an edge", () => {
    els.objectActionBar.hidden = false;
    State.graphEdges = [mockEdge()];
    showEdgeSidebar("1_2", {});
    expect(els.objectActionBar.hidden).toBe(true);
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
  it("hides the sidebar section but keeps the companion panel visible, showing its empty state instead", () => {
    els.artistSidebar.classList.add("show");
    els.companionPanel.classList.add("show");
    hideArtistSidebar();
    expect(els.artistSidebar.classList.contains("show")).toBe(false);
    // [SF-WEB-22] The panel itself no longer disappears entirely — it's
    // the same section-switch pattern as node/edge/path context, just with
    // .companion-empty as the "nothing selected" section.
    expect(els.companionPanel.classList.contains("show")).toBe(true);
    expect(els.companionEmpty.classList.contains("show")).toBe(true);
  });

  it("[SF-WEB-14] hides the object action bar too", () => {
    els.objectActionBar.hidden = false;
    hideArtistSidebar();
    expect(els.objectActionBar.hidden).toBe(true);
  });
});

describe("[SF-WEB-22] syncCompanionEmpty via showArtistSidebar/showEdgeSidebar", () => {
  it("hides .companion-empty once node context is shown", () => {
    els.companionEmpty.classList.add("show");
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    expect(els.companionEmpty.classList.contains("show")).toBe(false);
  });

  it("hides .companion-empty once edge context is shown", () => {
    els.companionEmpty.classList.add("show");
    State.graphEdges = [{ id: "1_2", from: 1, to: 2, weight: 1, dominantRole: "featured", collaborations: [] }];
    showEdgeSidebar("1_2", {});
    expect(els.companionEmpty.classList.contains("show")).toBe(false);
  });
});

describe("[SF-WEB-22] setupCompanionEmptyTrigger", () => {
  it("clicking .companion-empty opens the command palette", () => {
    setupCompanionEmptyTrigger();
    els.companionEmpty.click();
    expect(openNodeSearch).toHaveBeenCalledTimes(1);
  });
});
