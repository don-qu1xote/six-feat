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
  setupDockedPanels,
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
