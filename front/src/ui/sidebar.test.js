import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../vis-adapter/index.js", () => ({
  openGeniusPage: vi.fn(),
  highlightEdgePair: vi.fn(),
  selectNode: vi.fn(),
  selectEdge: vi.fn(),
  clearSelectedNode: vi.fn(),
  clearSelectedEdge: vi.fn(),
}));
vi.mock("../api/analytics-client.js", () => ({ bfsPath: vi.fn(() => null) }));
vi.mock("./modals.js", () => ({
  isSearchModalOpen: vi.fn(() => false),
  closeSearchModal: vi.fn(),
  closeNodeSearch: vi.fn(),
  closePathPanel: vi.fn(),
}));
vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));
vi.mock("./toast.js", () => ({ showToast: vi.fn() }));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { showArtistSidebar, showEdgeSidebar, hideArtistSidebar } from "./sidebar.js";
import { closePathPanel } from "./modals.js";
import {
  selectNode,
  selectEdge,
  clearSelectedNode,
  clearSelectedEdge,
} from "../vis-adapter/index.js";
import { searchArtist } from "../api/api.js";

function freshEl(tag = "div") {
  return document.createElement(tag);
}

beforeEach(() => {
  vi.clearAllMocks();
  State.graphNodes = [];
  State.graphEdges = [];
  State.currentSeedId = null;
  State.expandedNodes = new Set();

  els.companionPanel = freshEl();
  els.artistSidebar = freshEl();
  els.pathPanel = freshEl();
  els.searchModal = freshEl();
  els.sidebarAvatar = freshEl("img");
  els.sidebarName = freshEl();
  els.sidebarMeta = freshEl();
  els.sidebarTracks = freshEl();
  els.sidebarRoleBreakdownTile = freshEl();
  els.sidebarRoleChips = freshEl();
  els.sidebarPathTile = freshEl();
  els.sidebarPathTrack = freshEl();
  els.sidebarEndpointsTile = freshEl();
  els.sidebarEndpointsTrack = freshEl();

  els.objectActionBar = freshEl();
  els.objectActionBar.hidden = true;
  els.objActionExpand = freshEl("button");
  els.objActionFocus = freshEl("button");
  els.objActionGenius = freshEl("button");
});

function mockNode(overrides = {}) {
  return {
    id: 1,
    name: "Drake",
    imageUrl: "",
    isSeed: false,
    _totalCollabs: 5,
    _topTracks: [{ song: "God's Plan", roles: ["featured"] }],
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
    expect(els.sidebarPathTile.style.display).toBe("none");
  });

  it("[SF-WEB-33] hides the edge-only endpoints tile in node context", () => {
    State.graphNodes = [mockNode()];
    els.sidebarEndpointsTile.style.display = "";
    showArtistSidebar(1);
    expect(els.sidebarEndpointsTile.style.display).toBe("none");
  });

  it("[SF-WEB-27] shows Genius as part of the (single) object action bar, wired to openGeniusPage(nodeId) — no separate Genius button", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    expect(els.objectActionBar.hidden).toBe(false);
    expect(typeof els.objActionGenius.onclick).toBe("function");
    expect(els.sidebarGenius).toBeUndefined();
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

  it("marks the avatar .is-seed when showing the seed node", () => {
    State.graphNodes = [mockNode({ isSeed: true })];
    showArtistSidebar(1);
    expect(els.sidebarAvatar.classList.contains("is-seed")).toBe(true);
  });

  it("does not mark the avatar .is-seed for a non-seed node", () => {
    State.graphNodes = [mockNode({ isSeed: false })];
    showArtistSidebar(1);
    expect(els.sidebarAvatar.classList.contains("is-seed")).toBe(false);
  });
});

describe("[SF-WEB-14/SF-WEB-27] object action bar — node context", () => {
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
});

describe("showEdgeSidebar (edge context)", () => {
  function mockEdge(overrides = {}) {
    return {
      id: "1_2",
      from: 1,
      to: 2,
      weight: 3,
      dominantRole: "featured",
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

  it("hides the path-to-seed tile — it only makes sense for a single artist", () => {
    State.graphEdges = [mockEdge()];
    showEdgeSidebar("1_2", {});

    expect(els.sidebarPathTile.style.display).toBe("none");
  });

  it("clears .is-seed on the avatar — a combined edge avatar is never the seed", () => {
    els.sidebarAvatar.classList.add("is-seed");
    State.graphEdges = [mockEdge()];
    showEdgeSidebar("1_2", {});

    expect(els.sidebarAvatar.classList.contains("is-seed")).toBe(false);
  });

  it("[SF-WEB-33] shows and populates the role-breakdown tile with THIS edge's roles, not a per-node breakdown", () => {
    State.graphEdges = [
      mockEdge({
        collaborations: [
          { song: "Jumpman", roles: ["featured"] },
          { song: "Life Is Good", roles: ["producer", "featured"] },
        ],
      }),
    ];
    showEdgeSidebar("1_2", {});

    expect(els.sidebarRoleBreakdownTile.style.display).toBe("");
    expect(els.sidebarRoleChips.innerHTML).toContain("role-chip--producer");
    expect(els.sidebarRoleChips.innerHTML).toContain("role-chip--featured");
  });

  it("[SF-WEB-33] shows both endpoints as clickable cards, and hides the tile for node context", () => {
    State.graphNodes = [
      { id: 1, name: "Drake", imageUrl: "", isSeed: false },
      { id: 2, name: "Future", imageUrl: "", isSeed: false },
    ];
    State.graphEdges = [mockEdge()];
    showEdgeSidebar("1_2", { 1: "Drake", 2: "Future" });

    expect(els.sidebarEndpointsTile.style.display).toBe("");
    const cards = els.sidebarEndpointsTrack.querySelectorAll(".path-node-card[data-node-id]");
    expect(cards).toHaveLength(2);
    expect(els.sidebarEndpointsTrack.innerHTML).toContain("Drake");
    expect(els.sidebarEndpointsTrack.innerHTML).toContain("Future");
  });

  it("[SF-WEB-33] clicking an endpoint card shows that node's context (mutual exclusion with the edge)", () => {
    State.graphNodes = [
      { id: 1, name: "Drake", imageUrl: "", isSeed: false, _totalCollabs: 5, _topTracks: [] },
      { id: 2, name: "Future", imageUrl: "", isSeed: false, _totalCollabs: 3, _topTracks: [] },
    ];
    State.graphEdges = [mockEdge()];
    showEdgeSidebar("1_2", { 1: "Drake", 2: "Future" });

    const card = els.sidebarEndpointsTrack.querySelector('.path-node-card[data-node-id="2"]');
    card.dispatchEvent(new Event("click", { bubbles: true }));

    expect(els.sidebarName.textContent).toBe("Future");
    expect(selectNode).toHaveBeenCalledWith(2);
  });

  it("[SF-WEB-14/SF-WEB-27] hides the object action bar (incl. Genius, now one of its three buttons) — none of its actions apply to an edge", () => {
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

  it("falls back to songs[] + the edge's dominant role when collaborations[] is empty", () => {
    State.graphEdges = [
      mockEdge({
        collaborations: [],
        songs: ["A-B Track", "B-C Track"],
        dominantRole: "producer",
      }),
    ];
    showEdgeSidebar("1_2", {});

    const tracks = els.sidebarTracks.querySelectorAll(".sidebar-track");
    expect(tracks).toHaveLength(2);
    expect(els.sidebarTracks.innerHTML).toContain("A-B Track");
    expect(els.sidebarTracks.innerHTML).toContain("B-C Track");
    expect(els.sidebarTracks.innerHTML).toContain("role-chip--producer");
  });

  it("prefers collaborations[] (per-song roles) over songs[] when both are present", () => {
    State.graphEdges = [
      mockEdge({
        collaborations: [{ song: "Regular Graph Track", roles: ["producer"] }],
        songs: ["Path Track"],
      }),
    ];
    showEdgeSidebar("1_2", {});

    expect(els.sidebarTracks.innerHTML).toContain("Regular Graph Track");
    expect(els.sidebarTracks.innerHTML).not.toContain("Path Track");
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

  it("[SF-WEB-14] hides the object action bar too", () => {
    els.objectActionBar.hidden = false;
    hideArtistSidebar();
    expect(els.objectActionBar.hidden).toBe(true);
  });

  it("[SF-WEB-28] clears both the node and edge selection markers, regardless of which was active", () => {
    hideArtistSidebar();
    expect(clearSelectedEdge).toHaveBeenCalled();
    expect(clearSelectedNode).toHaveBeenCalled();
  });
});

describe("[SF-WEB-28] node and edge selection go through equivalent marker calls", () => {
  it("showArtistSidebar calls selectNode(nodeId) — the single place mutual exclusion with an edge is enforced", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    expect(selectNode).toHaveBeenCalledWith(1);
  });

  function mockEdge(overrides = {}) {
    return {
      id: "1_2",
      from: 1,
      to: 2,
      weight: 3,
      dominantRole: "featured",
      collaborations: [{ song: "Jumpman", roles: ["featured"] }],
      ...overrides,
    };
  }

  it("showEdgeSidebar calls selectEdge(edgeId) — the single place mutual exclusion with a node is enforced", () => {
    State.graphEdges = [mockEdge()];
    showEdgeSidebar("1_2", {});
    expect(selectEdge).toHaveBeenCalledWith("1_2");
  });
});
