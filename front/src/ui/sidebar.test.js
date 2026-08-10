import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../vis-adapter/index.js", () => ({
  openGeniusPage: vi.fn(),
  highlightEdgePair: vi.fn(),
  selectNode: vi.fn(),
  selectEdge: vi.fn(),
  clearSelectedNode: vi.fn(),
  clearSelectedEdge: vi.fn(),
}));
vi.mock("./modals.js", () => ({
  isSearchModalOpen: vi.fn(() => false),
  closeSearchModal: vi.fn(),
  closeNodeSearch: vi.fn(),
  closePathPanel: vi.fn(),
}));
vi.mock("../api/api.js", () => ({ searchArtist: vi.fn(), deepenArtistConnections: vi.fn() }));
vi.mock("./toast.js", () => ({ showToast: vi.fn() }));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  showArtistSidebar,
  showEdgeSidebar,
  showEdgeSidebarByPathEdgeId,
  hideArtistSidebar,
} from "./sidebar.js";
import { closePathPanel } from "./modals.js";
import {
  selectNode,
  selectEdge,
  clearSelectedNode,
  clearSelectedEdge,
} from "../vis-adapter/index.js";
import { searchArtist, deepenArtistConnections } from "../api/api.js";

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
  els.objActionDeepen = freshEl("button");
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

  it("[SF-YM-03] wires the deepen button to deepenArtistConnections(nodeId)", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);
    els.objActionDeepen.onclick();
    expect(deepenArtistConnections).toHaveBeenCalledWith(1);
  });

  it("[SF-YM-09] disables the deepen button for a node with no Genius link, without calling it", () => {
    State.graphNodes = [mockNode({ deepenAvailable: false })];
    showArtistSidebar(1);
    expect(els.objActionDeepen.disabled).toBe(true);
    expect(els.objActionDeepen.onclick).toBeNull();
    expect(deepenArtistConnections).not.toHaveBeenCalled();
  });

  it("[SF-YM-09] keeps the deepen button enabled for a node with a Genius link", () => {
    State.graphNodes = [mockNode({ deepenAvailable: true })];
    showArtistSidebar(1);
    expect(els.objActionDeepen.disabled).toBe(false);
    els.objActionDeepen.onclick();
    expect(deepenArtistConnections).toHaveBeenCalledWith(1);
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

describe("role breakdown chips", () => {
  it("shows a dash when the artist has no edges at all", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);

    expect(els.sidebarRoleChips.textContent).toContain("—");
  });

  it("counts edges per role, from either direction", () => {
    State.graphNodes = [mockNode()];
    State.graphEdges = [
      { id: "a", from: 1, to: 2, dominantRole: "featured" },
      { id: "b", from: 3, to: 1, dominantRole: "featured" },
      { id: "c", from: 1, to: 4, dominantRole: "producer" },
      { id: "d", from: 5, to: 6, dominantRole: "writer" },
    ];
    showArtistSidebar(1);

    const counts = [...els.sidebarRoleChips.querySelectorAll(".rbc-count")].map(
      (n) => n.textContent,
    );
    expect(counts).toEqual(["2", "1"]);
  });

  it("treats an edge with no role as featured", () => {
    State.graphNodes = [mockNode()];
    State.graphEdges = [{ id: "a", from: 1, to: 2 }];
    showArtistSidebar(1);

    expect(els.sidebarRoleChips.querySelector(".role-chip--featured")).not.toBeNull();
  });
});

describe("showArtistSidebar — tracks and avatar", () => {
  it("says so when the artist has no known tracks", () => {
    State.graphNodes = [mockNode({ _topTracks: [] })];
    showArtistSidebar(1);

    expect(els.sidebarTracks.textContent.toLowerCase()).toContain("no");
  });

  it("labels an untitled track rather than leaving it blank", () => {
    State.graphNodes = [mockNode({ _topTracks: [{ roles: ["featured"] }] })];
    showArtistSidebar(1);

    expect(els.sidebarTracks.querySelector(".sidebar-track-name").textContent.trim()).not.toBe("");
  });

  it("defaults a track with no roles to primary", () => {
    State.graphNodes = [mockNode({ _topTracks: [{ song: "X", roles: [] }] })];
    showArtistSidebar(1);

    expect(els.sidebarTracks.querySelector(".role-chip--primary")).not.toBeNull();
  });

  it("uses the artist's own image when there is one", () => {
    State.graphNodes = [mockNode({ imageUrl: "http://img/d.jpg" })];
    showArtistSidebar(1);

    expect(els.sidebarAvatar.src).toContain("http://img/d.jpg");
  });

  it("marks the seed artist's avatar", () => {
    State.graphNodes = [mockNode({ isSeed: true })];
    showArtistSidebar(1);

    expect(els.sidebarAvatar.classList.contains("is-seed")).toBe(true);
  });

  it("notes in the meta line that this node was already expanded", () => {
    State.graphNodes = [mockNode()];
    State.expandedNodes = new Set([1]);
    showArtistSidebar(1);

    expect(els.sidebarMeta.textContent.toLowerCase()).toContain("expanded");
  });

  it("falls back to totalWeight when the detailed count is missing", () => {
    State.graphNodes = [mockNode({ _totalCollabs: undefined, totalWeight: 9 })];
    showArtistSidebar(1);

    expect(els.sidebarMeta.textContent).toContain("9");
  });

  it("ignores a node that is not in the graph", () => {
    showArtistSidebar(404);
    expect(els.artistSidebar.classList.contains("show")).toBe(false);
  });
});

describe("object action bar", () => {
  it("expands the artist's neighbourhood from the action bar", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);

    els.objActionExpand.onclick();

    expect(searchArtist).toHaveBeenCalledWith("Drake", true, true);
    expect(State._clickedNodeId).toBe(1);
  });

  it("offers deepen for a node the backend says is deepenable", () => {
    State.graphNodes = [mockNode({ deepenAvailable: true })];
    showArtistSidebar(1);

    expect(els.objActionDeepen.disabled).toBe(false);
    els.objActionDeepen.onclick();
    expect(deepenArtistConnections).toHaveBeenCalledWith(1);
  });

  it("treats a node with no deepen flag as deepenable", () => {
    State.graphNodes = [mockNode()];
    showArtistSidebar(1);

    expect(els.objActionDeepen.disabled).toBe(false);
  });

  it("disables deepen, with an explanation, when the backend says it cannot work", () => {
    State.graphNodes = [mockNode({ deepenAvailable: false })];
    showArtistSidebar(1);

    expect(els.objActionDeepen.disabled).toBe(true);
    expect(els.objActionDeepen.onclick).toBeNull();
    expect(els.objActionDeepen.title.toLowerCase()).toContain("genius");
  });

  it("focuses the node on the canvas from the action bar", () => {
    State.graphNodes = [mockNode()];
    State.network = { focus: vi.fn() };
    showArtistSidebar(1);

    els.objActionFocus.onclick();

    expect(State.network.focus).toHaveBeenCalledWith(1, expect.objectContaining({ scale: 1.2 }));
    State.network = null;
  });

  it("does not blow up focusing when the canvas is not rendered", () => {
    State.graphNodes = [mockNode()];
    State.network = null;
    showArtistSidebar(1);

    expect(() => els.objActionFocus.onclick()).not.toThrow();
  });

  it("stays hidden on a page with no action bar", () => {
    State.graphNodes = [mockNode()];
    els.objectActionBar = null;

    expect(() => showArtistSidebar(1)).not.toThrow();
  });
});

describe("path-to-seed track", () => {
  // [SF-API-24] Плитка читает ребро прямо из нарисованного графа — сетевого
  // ответа тут нет и никогда не было нужно, поэтому и подменять нечего:
  // сценарии задаются составом State.graphEdges.
  beforeEach(() => {
    State.currentSeedId = 2;
    State.graphNodes = [
      mockNode({ id: 1, name: "Drake" }),
      mockNode({ id: 2, name: "Future", isSeed: true }),
    ];
    State.graphEdges = [{ id: "e1", from: 1, to: 2, dominantRole: "producer", weight: 3 }];
  });

  it("shows the hop from this artist to the seed", () => {
    showArtistSidebar(1);

    expect(els.sidebarPathTile.style.display).toBe("");
    expect(els.sidebarPathTrack.querySelectorAll(".path-node-card")).toHaveLength(2);
    expect(els.sidebarPathTrack.querySelector(".path-edge-connector")).not.toBeNull();
  });

  it("hides the tile for the seed artist itself", () => {
    showArtistSidebar(2);
    expect(els.sidebarPathTile.style.display).toBe("none");
  });

  it("hides the tile when there is no seed yet", () => {
    State.currentSeedId = null;
    showArtistSidebar(1);
    expect(els.sidebarPathTile.style.display).toBe("none");
  });

  it("hides the tile when the artist is more than one hop away", () => {
    State.graphNodes.push(mockNode({ id: 3, name: "Metro" }));
    State.graphEdges = [
      { id: "e1", from: 1, to: 3, dominantRole: "producer", weight: 3 },
      { id: "e2", from: 3, to: 2, dominantRole: "producer", weight: 2 },
    ];

    showArtistSidebar(1);

    expect(els.sidebarPathTile.style.display).toBe("none");
  });

  it("hides the tile when there is no path at all", () => {
    State.graphEdges = [];

    showArtistSidebar(1);

    expect(els.sidebarPathTile.style.display).toBe("none");
  });

  it("shows the hop no matter which way round the edge is stored", () => {
    State.graphEdges = [{ id: "e1", from: 2, to: 1, dominantRole: "producer", weight: 3 }];

    showArtistSidebar(1);

    expect(els.sidebarPathTile.style.display).toBe("");
  });

  it("jumps to the other artist when their card is clicked", () => {
    State.network = { focus: vi.fn() };
    showArtistSidebar(1);

    const other = [...els.sidebarPathTrack.querySelectorAll(".path-node-card")].find(
      (c) => c.getAttribute("data-node-id") === "2",
    );
    other.click();

    expect(State.network.focus).toHaveBeenCalled();
    State.network = null;
  });

  it("does not make the current artist's own card clickable", () => {
    showArtistSidebar(1);

    const self = [...els.sidebarPathTrack.querySelectorAll(".path-node-card")].find(
      (c) => c.getAttribute("data-node-id") === "1",
    );
    expect(self.getAttribute("style")).toContain("cursor:default");
  });

  it("opens the edge sidebar from the connector, by click or keyboard", async () => {
    const { highlightEdgePair } = await import("../vis-adapter/index.js");
    showArtistSidebar(1);

    const connector = els.sidebarPathTrack.querySelector(".path-edge-connector");
    connector.click();
    expect(highlightEdgePair).toHaveBeenCalled();

    highlightEdgePair.mockClear();
    connector.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(highlightEdgePair).toHaveBeenCalled();

    highlightEdgePair.mockClear();
    connector.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(highlightEdgePair).not.toHaveBeenCalled();
  });
});

describe("showEdgeSidebar", () => {
  const names = { 1: "Drake", 2: "Future" };
  const edge = (over = {}) => ({ id: "e1", from: 1, to: 2, weight: 3, ...over });

  beforeEach(() => {
    State.graphNodes = [mockNode({ id: 1, name: "Drake" }), mockNode({ id: 2, name: "Future" })];
  });

  it("titles the sidebar with both artists", () => {
    State.graphEdges = [edge()];
    showEdgeSidebar("e1", names);

    expect(els.sidebarName.textContent).toBe("Drake × Future");
    expect(els.artistSidebar.classList.contains("show")).toBe(true);
  });

  it("ignores an edge id that is not in the graph", () => {
    State.graphEdges = [];
    showEdgeSidebar("nope", names);
    expect(els.artistSidebar.classList.contains("show")).toBe(false);
  });

  it("falls back to the node list, then a placeholder, for a missing name", () => {
    State.graphEdges = [edge({ from: 1, to: 99 })];
    showEdgeSidebar("e1", {});

    expect(els.sidebarName.textContent).toBe("Drake × ?");
  });

  it("lists each collaboration with a chip per credited role", () => {
    State.graphEdges = [
      edge({ collaborations: [{ song: "Life Is Good", roles: ["featured", "writer"] }] }),
    ];
    showEdgeSidebar("e1", names);

    expect(els.sidebarTracks.querySelectorAll(".sidebar-track")).toHaveLength(1);
    expect(els.sidebarTracks.querySelectorAll(".sidebar-track-role")).toHaveLength(2);
  });

  it("falls back to a plain song list when there are no role credits", () => {
    State.graphEdges = [edge({ songs: ["Way 2 Sexy", { song: "Wants and Needs" }, {}] })];
    showEdgeSidebar("e1", names);

    const names_ = [...els.sidebarTracks.querySelectorAll(".sidebar-track-name")].map(
      (n) => n.textContent,
    );
    expect(names_[0]).toBe("Way 2 Sexy");
    expect(names_[1]).toBe("Wants and Needs");
    expect(names_[2].trim()).not.toBe("");
  });

  it("says so when the pair has no known tracks", () => {
    State.graphEdges = [edge()];
    showEdgeSidebar("e1", names);

    expect(els.sidebarTracks.textContent.toLowerCase()).toContain("no");
  });

  it("counts roles across collaborations for the breakdown", () => {
    State.graphEdges = [
      edge({
        collaborations: [
          { song: "A", roles: ["featured"] },
          { song: "B", roles: ["featured", "writer"] },
        ],
      }),
    ];
    showEdgeSidebar("e1", names);

    const counts = [...els.sidebarRoleChips.querySelectorAll(".rbc-count")].map(
      (n) => n.textContent,
    );
    expect(counts).toEqual(["2", "1"]);
  });

  it("falls back to the shared-track count when there are no role credits", () => {
    State.graphEdges = [edge({ weight: 4, dominantRole: "producer" })];
    showEdgeSidebar("e1", names);

    expect(els.sidebarRoleChips.querySelector(".rbc-count").textContent).toBe("4");
  });

  it("shows both endpoints and jumps to one when clicked", () => {
    State.graphEdges = [edge()];
    State.network = { focus: vi.fn() };
    showEdgeSidebar("e1", names);

    expect(els.sidebarEndpointsTile.style.display).toBe("");
    const cards = els.sidebarEndpointsTrack.querySelectorAll(".path-node-card");
    expect(cards).toHaveLength(2);

    cards[1].click();
    expect(State.network.focus).toHaveBeenCalledWith(2, expect.anything());
    State.network = null;
  });

  it("hides the object action bar, which only makes sense for a node", () => {
    State.graphEdges = [edge()];
    showEdgeSidebar("e1", names);

    expect(els.objectActionBar.hidden).toBe(true);
    expect(selectEdge).toHaveBeenCalledWith("e1");
  });

  it("works on a page without the endpoints tile", () => {
    State.graphEdges = [edge()];
    els.sidebarEndpointsTile = null;

    expect(() => showEdgeSidebar("e1", names)).not.toThrow();
  });
});

describe("showEdgeSidebarByPathEdgeId", () => {
  const names = { 1: "Drake", 2: "Future" };

  beforeEach(() => {
    State.graphNodes = [mockNode({ id: 1, name: "Drake" }), mockNode({ id: 2, name: "Future" })];
    State.graphEdges = [{ id: "e1", from: 2, to: 1, weight: 1 }];
  });

  it("resolves a synthetic lo_hi id back to the real edge", () => {
    showEdgeSidebarByPathEdgeId("1_2", names);
    expect(selectEdge).toHaveBeenCalledWith("e1");
  });

  it("passes a real edge id straight through", () => {
    showEdgeSidebarByPathEdgeId("e1", names);
    expect(selectEdge).toHaveBeenCalledWith("e1");
  });

  it("does nothing for an id that matches no edge either way", () => {
    showEdgeSidebarByPathEdgeId("7_8", names);
    expect(selectEdge).not.toHaveBeenCalled();
  });
});

describe("hideArtistSidebar", () => {
  it("clears the selection and hides the panels", () => {
    els.artistSidebar.classList.add("show");
    els.companionPanel.classList.add("show");

    hideArtistSidebar();

    expect(els.artistSidebar.classList.contains("show")).toBe(false);
    expect(els.companionPanel.classList.contains("show")).toBe(false);
    expect(els.objectActionBar.hidden).toBe(true);
    expect(clearSelectedEdge).toHaveBeenCalled();
    expect(clearSelectedNode).toHaveBeenCalled();
  });

  it("works on a page without the companion panel or action bar", () => {
    els.companionPanel = null;
    els.objectActionBar = null;

    expect(() => hideArtistSidebar()).not.toThrow();
  });
});
