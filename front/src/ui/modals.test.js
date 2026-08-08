import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("./sidebar.js", () => ({
  hideArtistSidebar: vi.fn(),
  showArtistSidebar: vi.fn(),
}));
vi.mock("./candidate-picker.js", () => ({ hideCandidatePicker: vi.fn() }));
const highlightPath = vi.fn();
const restoreDefaultColors = vi.fn();
vi.mock("../vis-adapter/index.js", () => ({
  setFocus: vi.fn(),
  highlightPath: (...a) => highlightPath(...a),
  restoreDefaultColors: (...a) => restoreDefaultColors(...a),
}));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { hideArtistSidebar } from "./sidebar.js";
import { hideCandidatePicker } from "./candidate-picker.js";
import {
  isPathPanelOpen,
  openPathPanel,
  closePathPanel,
  isSearchModalOpen,
  openSearchModal,
  openNodeSearch,
  closeNodeSearch,
  renderNodeSearchResults,
  updateNodeSearchResults,
  setupDockedPanels,
  closeSearchModal,
  forceCloseSearchModal,
  setupSearchModal,
  setupNodeSearch,
} from "./modals.js";

function freshEl(tag = "div") {
  return document.createElement(tag);
}

beforeAll(() => {
  els.companionPanel = freshEl();
  els.pathPanel = freshEl();
  els.pathFromInput = freshEl("input");
  els.searchModal = freshEl();
  els.nodeSearchOverlay = freshEl();
  els.nodeSearchInput = freshEl("input");
  els.nodeSearchResults = freshEl();
  els.nodeSearchStatus = freshEl();
  els.btnSearchOpen = freshEl("button");
  els.btnNodeSearch = freshEl("button");
  els.btnFindPath = freshEl("button");
  els.heroInput = freshEl("input");
  els.heroModeSwitch = freshEl();
  els.heroModeTabExplore = freshEl("button");
  els.heroModeTabConnect = freshEl("button");
  els.heroModePanelExplore = freshEl();
  els.heroModePanelConnect = freshEl();
  document.body.append(
    els.pathFromInput,
    els.pathPanel,
    els.searchModal,
    els.nodeSearchOverlay,
    els.btnSearchOpen,
    els.btnNodeSearch,
    els.btnFindPath,
    els.heroInput,
  );

  setupDockedPanels();
});

beforeEach(() => {
  vi.clearAllMocks();
  els.companionPanel.className = "";
  els.pathPanel.className = "";
  els.searchModal.className = "";
  els.nodeSearchOverlay.className = "";
  els.pathFromInput.value = "";
  els.heroModeSwitch.dataset.mode = "connect";
  els.heroModeTabExplore.setAttribute("aria-selected", "false");
  els.heroModeTabExplore.tabIndex = -1;
  els.heroModeTabConnect.setAttribute("aria-selected", "true");
  els.heroModeTabConnect.tabIndex = 0;
  els.heroModePanelExplore.className = "hero-mode-panel";
  els.heroModePanelConnect.className = "hero-mode-panel is-active";
  State.heroMode = "connect";

  State.hasRendered = true;
  State.graphNodes = [];
  State.currentSeedId = null;
  State.expandedNodes = new Set();
});

describe("isPathPanelOpen", () => {
  it("reflects the path section's own .show class", () => {
    expect(isPathPanelOpen()).toBe(false);
    els.pathPanel.classList.add("show");
    expect(isPathPanelOpen()).toBe(true);
  });
});

describe("openPathPanel", () => {
  it("shows the path section and the companion panel", () => {
    openPathPanel();
    expect(els.pathPanel.classList.contains("show")).toBe(true);
    expect(els.companionPanel.classList.contains("show")).toBe(true);
  });

  it("closes node/edge context first (mutual exclusivity)", () => {
    openPathPanel();
    expect(hideArtistSidebar).toHaveBeenCalled();
  });

  it("closes the candidate picker and focuses the from-field", () => {
    openPathPanel();
    expect(hideCandidatePicker).toHaveBeenCalled();
    expect(document.activeElement).toBe(els.pathFromInput);
  });

  it("[SF-WEB-24] closes an already-open docked search-modal", () => {
    openSearchModal({ docked: true });
    expect(isSearchModalOpen()).toBe(true);
    openPathPanel();
    expect(isSearchModalOpen()).toBe(false);
  });

  it("[SF-WEB-24] closes an already-open node-search overlay", () => {
    openNodeSearch();
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(true);
    openPathPanel();
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(false);
  });
});

describe("closePathPanel", () => {
  it("hides both the path section and the companion panel", () => {
    els.pathPanel.classList.add("show");
    els.companionPanel.classList.add("show");
    closePathPanel();
    expect(els.pathPanel.classList.contains("show")).toBe(false);
    expect(els.companionPanel.classList.contains("show")).toBe(false);
  });
});

describe("[SF-WEB-24] openSearchModal(docked) closes the other two docked panels", () => {
  it("closes an already-open path panel", () => {
    openPathPanel();
    expect(isPathPanelOpen()).toBe(true);
    openSearchModal({ docked: true });
    expect(isPathPanelOpen()).toBe(false);
  });

  it("closes an already-open node-search overlay", () => {
    openNodeSearch();
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(true);
    openSearchModal({ docked: true });
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(false);
  });
});

describe("[SF-WEB-30] openSearchModal(docked) shows only the Explore box", () => {
  it("adds the .docked class", () => {
    openSearchModal({ docked: true });
    expect(els.searchModal.classList.contains("docked")).toBe(true);
  });

  it("resets a leftover Connect-mode selection back to Explore", () => {
    expect(State.heroMode).toBe("connect");
    openSearchModal({ docked: true });
    expect(State.heroMode).toBe("explore");
    expect(els.heroModeSwitch.dataset.mode).toBe("explore");
    expect(els.heroModeTabExplore.getAttribute("aria-selected")).toBe("true");
    expect(els.heroModeTabConnect.getAttribute("aria-selected")).toBe("false");
    expect(els.heroModePanelExplore.classList.contains("is-active")).toBe(true);
    expect(els.heroModePanelConnect.classList.contains("is-active")).toBe(false);
  });

  it("focuses the hero (Explore) search input", () => {
    openSearchModal({ docked: true });
    expect(document.activeElement).toBe(els.heroInput);
  });
});

describe("[SF-WEB-30] openSearchModal without docked (landing/is-first-visit) leaves Explore/Connect untouched", () => {
  it("does not force Explore mode when opened full-screen", () => {
    expect(State.heroMode).toBe("connect");
    openSearchModal({ docked: false });
    expect(State.heroMode).toBe("connect");
    expect(els.heroModePanelConnect.classList.contains("is-active")).toBe(true);
  });

  it("does not add the .docked class", () => {
    openSearchModal({ docked: false });
    expect(els.searchModal.classList.contains("docked")).toBe(false);
  });
});

describe("[SF-WEB-24] openNodeSearch closes the other two docked panels", () => {
  it("closes an already-open path panel", () => {
    openPathPanel();
    expect(isPathPanelOpen()).toBe(true);
    openNodeSearch();
    expect(isPathPanelOpen()).toBe(false);
  });

  it("closes an already-open docked search-modal", () => {
    openSearchModal({ docked: true });
    expect(isSearchModalOpen()).toBe(true);
    openNodeSearch();
    expect(isSearchModalOpen()).toBe(false);
  });
});

describe("[SF-WEB-24] outside-click-to-close, wired through the real registry", () => {
  it("clicking outside the open node-search overlay closes it", () => {
    openNodeSearch();
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(true);
    document.body.click();
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(false);
  });

  it("clicking the node-search overlay's own trigger does not close it via the outside-click path", () => {
    openNodeSearch();
    els.btnNodeSearch.click();
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(true);
  });

  it("clicking inside the open path panel does not close it", () => {
    openPathPanel();
    els.pathPanel.click();
    expect(isPathPanelOpen()).toBe(true);
  });

  it("clicking outside the open (docked) search-modal closes it", () => {
    openSearchModal({ docked: true });
    expect(isSearchModalOpen()).toBe(true);
    document.body.click();
    expect(isSearchModalOpen()).toBe(false);
  });
});

describe("renderNodeSearchResults — live canvas highlight (SF-WEB-75)", () => {
  beforeEach(() => {
    State.graphNodes = [
      { id: 1, name: "Seed Artist", isSeed: true },
      { id: 2, name: "Alpha", totalWeight: 3 },
      { id: 3, name: "Beta", totalWeight: 1 },
      { id: 4, name: "Alphabet", totalWeight: 2 },
    ];
    State.currentSeedId = 1;
    State.expandedNodes = new Set();
  });

  it("highlights every matching node on the canvas, same as a real path highlight", () => {
    renderNodeSearchResults("alpha");
    expect(highlightPath).toHaveBeenCalledWith([2, 4], { dim: false });
    expect(restoreDefaultColors).not.toHaveBeenCalled();
  });

  it("clears the canvas highlight instead of lighting up the whole graph when the query is empty", () => {
    renderNodeSearchResults("");
    expect(highlightPath).not.toHaveBeenCalled();
    expect(restoreDefaultColors).toHaveBeenCalledTimes(1);
  });

  it("clears the canvas highlight when a query matches nothing", () => {
    renderNodeSearchResults("zzz-no-match");
    expect(highlightPath).not.toHaveBeenCalled();
    expect(restoreDefaultColors).toHaveBeenCalledTimes(1);
  });

  it("closing the overlay without picking a result clears the highlight", () => {
    renderNodeSearchResults("alpha");
    highlightPath.mockClear();
    closeNodeSearch();
    expect(restoreDefaultColors).toHaveBeenCalledTimes(1);
  });
});

describe("search modal — docked vs full", () => {
  it("docks over the graph and forces explore mode", () => {
    State.heroMode = "connect";
    openSearchModal({ docked: true });

    expect(isSearchModalOpen()).toBe(true);
    expect(els.searchModal.classList.contains("docked")).toBe(true);
    expect(State.heroMode).toBe("explore");
    expect(els.heroModeSwitch.dataset.mode).toBe("explore");
    expect(els.heroModeTabExplore.getAttribute("aria-selected")).toBe("true");
    expect(els.heroModeTabConnect.getAttribute("aria-selected")).toBe("false");
    expect(els.heroModePanelExplore.classList.contains("is-active")).toBe(true);
  });

  it("hides the node sidebar when docking, which would otherwise overlap", () => {
    openSearchModal({ docked: true });
    expect(hideArtistSidebar).toHaveBeenCalled();
  });

  it("opens full-screen by default and switches the page to the home view", () => {
    openSearchModal();

    expect(els.searchModal.classList.contains("docked")).toBe(false);
    expect(document.body.classList.contains("view-home")).toBe(true);
    expect(document.body.classList.contains("view-graph")).toBe(false);
  });

  it("drops the first-visit styling once a graph has been drawn", () => {
    els.appCanvas = freshEl();
    els.searchModal.classList.add("is-first-visit");
    State.hasRendered = true;

    openSearchModal();

    expect(els.searchModal.classList.contains("is-first-visit")).toBe(false);
    expect(els.appCanvas.classList.contains("search-open")).toBe(true);
    State.hasRendered = false;
    els.appCanvas = null;
  });

  it("keeps the first-visit styling for a visitor who has not searched yet", () => {
    els.searchModal.classList.add("is-first-visit");
    State.hasRendered = false;

    openSearchModal();

    expect(els.searchModal.classList.contains("is-first-visit")).toBe(true);
  });

  it("returns the page to the graph view on close, once something is drawn", () => {
    State.hasRendered = true;
    openSearchModal();
    closeSearchModal();

    expect(isSearchModalOpen()).toBe(false);
    expect(els.searchModal.classList.contains("is-closed")).toBe(true);
    expect(document.body.classList.contains("view-graph")).toBe(true);
    State.hasRendered = false;
  });

  it("leaves the view classes alone on close when nothing has been drawn", () => {
    document.body.classList.remove("view-graph", "view-home");
    State.hasRendered = false;

    openSearchModal();
    closeSearchModal();

    expect(document.body.classList.contains("view-graph")).toBe(false);
  });

  it("does nothing on a page with no search modal", () => {
    const modal = els.searchModal;
    els.searchModal = null;

    expect(() => openSearchModal()).not.toThrow();
    expect(() => closeSearchModal()).not.toThrow();

    els.searchModal = modal;
  });

  it("forceCloseSearchModal closes it like the ordinary path", () => {
    openSearchModal();
    forceCloseSearchModal();
    expect(isSearchModalOpen()).toBe(false);
  });
});

describe("setupSearchModal button", () => {
  it("toggles the docked modal from the toolbar button", () => {
    setupSearchModal();

    els.btnSearchOpen.click();
    expect(isSearchModalOpen()).toBe(true);
    expect(els.searchModal.classList.contains("docked")).toBe(true);

    els.btnSearchOpen.click();
    expect(isSearchModalOpen()).toBe(false);
  });
});

describe("node search results", () => {
  beforeEach(() => {
    State.hasRendered = true;
    State.currentSeedId = 1;
    State.expandedNodes = new Set();
    State.graphNodes = [
      { id: 1, name: "Drake", _totalCollabs: 10 },
      { id: 2, name: "Future", _totalCollabs: 1 },
      { id: 3, name: "Drizzy Drake", totalWeight: 4 },
    ];
    State.network = { focus: vi.fn() };
  });

  const items = () => [...els.nodeSearchResults.querySelectorAll(".ns-item")];

  it("lists every node except the seed when the query is empty", () => {
    renderNodeSearchResults("");
    expect(items().map((i) => i.getAttribute("data-id"))).toEqual(["2", "3"]);
  });

  it("filters by name, still excluding the seed", () => {
    renderNodeSearchResults("drake");
    expect(items().map((i) => i.getAttribute("data-id"))).toEqual(["3"]);
  });

  it("caps the list at twelve", () => {
    State.graphNodes = Array.from({ length: 30 }, (_, i) => ({
      id: i + 100,
      name: `A${i}`,
      totalWeight: 1,
    }));
    renderNodeSearchResults("");
    expect(items()).toHaveLength(12);
  });

  it("says so when nothing matches", () => {
    renderNodeSearchResults("zzzz");

    expect(els.nodeSearchResults.querySelector(".ns-empty")).not.toBeNull();
    expect(els.nodeSearchStatus.textContent).toBe("No nodes match");
  });

  it("pluralises the found-count for screen readers", () => {
    renderNodeSearchResults("future");
    expect(els.nodeSearchStatus.textContent).toBe("1 artist found");

    renderNodeSearchResults("");
    expect(els.nodeSearchStatus.textContent).toBe("2 artists found");
  });

  it("pluralises each row's collaboration count", () => {
    renderNodeSearchResults("");
    const weights = items().map((i) => i.querySelector(".ns-weight").textContent);
    expect(weights[0]).toBe("1 collab");
    expect(weights[1]).toBe("4 collabs");
  });

  it("ticks nodes the user already expanded", () => {
    State.expandedNodes = new Set([2]);
    renderNodeSearchResults("");

    expect(items()[0].querySelector(".ns-name").textContent).toContain("✓");
  });

  it("highlights the matches on the canvas, and restores colours for an empty query", () => {
    renderNodeSearchResults("drake");
    expect(highlightPath).toHaveBeenCalledWith([3], { dim: false });

    restoreDefaultColors.mockClear();
    renderNodeSearchResults("");
    expect(restoreDefaultColors).toHaveBeenCalled();
  });

  it("focuses the picked node and opens its sidebar", async () => {
    const { showArtistSidebar } = await import("./sidebar.js");
    renderNodeSearchResults("");

    items()[0].click();

    expect(State.network.focus).toHaveBeenCalledWith("2", expect.objectContaining({ scale: 1.5 }));
    expect(showArtistSidebar).toHaveBeenCalledWith("2");
  });

  it("still closes the overlay when picking with no rendered network", async () => {
    const { showArtistSidebar } = await import("./sidebar.js");
    State.network = null;
    renderNodeSearchResults("");

    items()[0].click();

    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(false);
    expect(showArtistSidebar).not.toHaveBeenCalled();
  });

  it("updateNodeSearchResults is the same render under another name", () => {
    updateNodeSearchResults("future");
    expect(items()).toHaveLength(1);
  });
});

describe("node search open/close", () => {
  beforeEach(() => {
    State.graphNodes = [{ id: 2, name: "Future", totalWeight: 1 }];
    State.currentSeedId = 1;
    State.expandedNodes = new Set();
  });

  it("refuses to open before anything has been drawn", () => {
    State.hasRendered = false;
    openNodeSearch();
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(false);
  });

  it("opens with an empty field and a full list", () => {
    State.hasRendered = true;
    els.nodeSearchInput.value = "stale";

    openNodeSearch();

    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(true);
    expect(els.nodeSearchInput.value).toBe("");
    expect(els.nodeSearchInput.getAttribute("aria-expanded")).toBe("true");
  });

  it("resets its a11y state on close", () => {
    State.hasRendered = true;
    openNodeSearch();
    closeNodeSearch();

    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(false);
    expect(els.nodeSearchInput.getAttribute("aria-expanded")).toBe("false");
    expect(els.nodeSearchInput.getAttribute("aria-activedescendant")).toBe("");
  });
});

describe("node search keyboard", () => {
  const key = (k) =>
    els.nodeSearchInput.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  beforeEach(() => {
    // jsdom не реализует scrollIntoView, а подсветка активной строки его зовёт.
    Element.prototype.scrollIntoView = vi.fn();
    State.hasRendered = true;
    State.currentSeedId = 1;
    State.expandedNodes = new Set();
    State.network = { focus: vi.fn() };
    State.graphNodes = [
      { id: 1, name: "Drake", totalWeight: 1 },
      { id: 2, name: "Future", totalWeight: 1 },
      { id: 3, name: "Sia", totalWeight: 1 },
    ];
    setupNodeSearch();
    renderNodeSearchResults("");
  });

  const items = () => [...els.nodeSearchResults.querySelectorAll(".ns-item")];

  it("walks down the list and stops at the bottom", () => {
    key("ArrowDown");
    expect(items()[0].classList.contains("ns-active")).toBe(true);

    key("ArrowDown");
    key("ArrowDown");
    expect(items()[1].classList.contains("ns-active")).toBe(true);
    expect(els.nodeSearchInput.getAttribute("aria-activedescendant")).toBe(items()[1].id);
  });

  it("walks back up and stops at the top", () => {
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowUp");
    key("ArrowUp");

    expect(items()[0].classList.contains("ns-active")).toBe(true);
  });

  it("marks only one row as selected at a time", () => {
    key("ArrowDown");
    key("ArrowDown");

    expect(els.nodeSearchResults.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  });

  it("picks the highlighted row on Enter", () => {
    key("ArrowDown");
    key("Enter");

    expect(State.network.focus).toHaveBeenCalled();
  });

  it("ignores Enter when nothing is highlighted", () => {
    key("Enter");
    expect(State.network.focus).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    els.nodeSearchOverlay.classList.add("show");
    key("Escape");
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(false);
  });

  it("ignores arrow keys when the list is empty", () => {
    renderNodeSearchResults("zzzz");
    expect(() => key("ArrowDown")).not.toThrow();
  });
});
