// ════════════════════════════════════════════════════════════════════════════
// command-palette.test.js — [SF-WEB-21] unit tests for the command palette
//                           (⌘K): ui/modals.js's renderNodeSearchResults now
//                           renders command rows + a "search as new seed"
//                           row alongside graph-node results, all in one
//                           arrow-navigable list, and clicking/Entering a
//                           row runs the right action.
//
// setupKeyboard's ⌘K open/close binding is covered in
// canvas-controls.test.js (that's where the keydown listener actually
// lives); this file only exercises what's rendered/selected once the
// palette is open. "No duplicate visible entry points" is covered in
// canvas-declutter.test.js (markup-existence assertions against the real
// index.html).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../vis-adapter/index.js", () => ({ setFocus: vi.fn() }));
vi.mock("./sidebar.js", () => ({
  hideArtistSidebar: vi.fn(),
  showArtistSidebar: vi.fn(),
}));
vi.mock("./candidate-picker.js", () => ({ hideCandidatePicker: vi.fn() }));
vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));
vi.mock("./canvas-controls.js", () => ({
  exportGraphPng: vi.fn(), clearCanvas: vi.fn(),
  toggleRoleFilter: vi.fn(), openHelpOverlay: vi.fn(),
}));
vi.mock("./history.js", () => ({ copyShareableLink: vi.fn() }));
vi.mock("./theme.js", () => ({ setTheme: vi.fn() }));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { searchArtist } from "../api/api.js";
import { exportGraphPng, clearCanvas, toggleRoleFilter, openHelpOverlay } from "./canvas-controls.js";
import { copyShareableLink } from "./history.js";
import { setTheme } from "./theme.js";
import { showArtistSidebar } from "./sidebar.js";
import { openNodeSearch, renderNodeSearchResults, setupNodeSearch } from "./modals.js";

function freshEl(tag = "div") { return document.createElement(tag); }

function itemsByKind(kind) {
  return [...els.nodeSearchResults.querySelectorAll(".ns-item")]
    .filter(el => el.dataset.kind === kind);
}

beforeEach(() => {
  vi.clearAllMocks();
  State.hasRendered = true;
  State.graphNodes = [];
  State.expandedNodes = new Set();
  State.currentSeedId = null;
  State.activeFilters = new Set(["featured", "producer", "writer"]);
  State.theme = "dark";
  State.network = null;
  State.pathHighlight = null;

  els.nodeSearchOverlay = freshEl();
  els.nodeSearchInput   = Object.assign(freshEl("input"), { value: "" });
  els.nodeSearchResults = freshEl();
  els.nodeSearchStatus  = freshEl();
  els.searchModal       = freshEl();
  els.pathPanel         = freshEl();
  els.companionPanel    = freshEl();
  els.pathFromInput     = freshEl("input");
  document.body.appendChild(els.pathFromInput);
});

describe("renderNodeSearchResults — unified command + node list", () => {
  it("lists every command row, in order, when the query is empty", () => {
    renderNodeSearchResults("");
    const cmdIds = itemsByKind("cmd").map(el => el.dataset.cmdId);
    expect(cmdIds).toEqual([
      "find-path", "filter-featured", "filter-producer", "filter-writer",
      "export-png", "copy-link", "theme", "help", "clear",
    ]);
  });

  it("narrows to matching commands only when the query matches a label", () => {
    renderNodeSearchResults("theme");
    const cmdIds = itemsByKind("cmd").map(el => el.dataset.cmdId);
    expect(cmdIds).toEqual(["theme"]);
  });

  it("offers a 'search artist' row, in the original casing, only once a query is typed", () => {
    renderNodeSearchResults("");
    expect(itemsByKind("search")).toHaveLength(0);

    renderNodeSearchResults("Drake");
    const rows = itemsByKind("search");
    expect(rows).toHaveLength(1);
    expect(rows[0].dataset.query).toBe("Drake");
  });

  it("still lists matching graph nodes, excluding the current seed", () => {
    State.graphNodes = [
      { id: 1, name: "Drake", isSeed: true },
      { id: 2, name: "Drake's Collaborator" },
      { id: 3, name: "Someone Else" },
    ];
    State.currentSeedId = 1;
    renderNodeSearchResults("drake");
    const nodeRows = itemsByKind("node");
    expect(nodeRows.map(el => el.getAttribute("data-id"))).toEqual(["2"]);
  });

  it("marks an active role filter's command row with a checkmark", () => {
    renderNodeSearchResults("filter");
    const featured = itemsByKind("cmd").find(el => el.dataset.cmdId === "filter-featured");
    expect(featured.querySelector(".ns-weight").textContent).toBe("✓");
  });

  it("drops the checkmark once that role filter is inactive", () => {
    State.activeFilters = new Set(["producer", "writer"]);
    renderNodeSearchResults("filter");
    const featured = itemsByKind("cmd").find(el => el.dataset.cmdId === "filter-featured");
    expect(featured.querySelector(".ns-weight").textContent).toBe("");
  });
});

describe("selecting a row runs the matching action", () => {
  it("find-path toggles the path panel and closes the palette", () => {
    openNodeSearch();
    renderNodeSearchResults("path");
    els.nodeSearchResults.querySelector('[data-cmd-id="find-path"]').click();
    expect(els.pathPanel.classList.contains("show")).toBe(true);
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(false);
  });

  it("a filter row calls toggleRoleFilter with its role", () => {
    renderNodeSearchResults("producer");
    els.nodeSearchResults.querySelector('[data-cmd-id="filter-producer"]').click();
    expect(toggleRoleFilter).toHaveBeenCalledWith("producer");
  });

  it("export/copy-link/theme/help/clear rows call their own actions", () => {
    renderNodeSearchResults("");
    els.nodeSearchResults.querySelector('[data-cmd-id="export-png"]').click();
    expect(exportGraphPng).toHaveBeenCalledTimes(1);

    renderNodeSearchResults("");
    els.nodeSearchResults.querySelector('[data-cmd-id="copy-link"]').click();
    expect(copyShareableLink).toHaveBeenCalledTimes(1);

    renderNodeSearchResults("");
    els.nodeSearchResults.querySelector('[data-cmd-id="theme"]').click();
    expect(setTheme).toHaveBeenCalledTimes(1);

    renderNodeSearchResults("");
    els.nodeSearchResults.querySelector('[data-cmd-id="help"]').click();
    expect(openHelpOverlay).toHaveBeenCalledTimes(1);

    renderNodeSearchResults("");
    els.nodeSearchResults.querySelector('[data-cmd-id="clear"]').click();
    expect(clearCanvas).toHaveBeenCalledTimes(1);
  });

  it("the search-artist row calls searchArtist with the typed name", () => {
    renderNodeSearchResults("Some New Artist");
    els.nodeSearchResults.querySelector('[data-kind="search"]').click();
    expect(searchArtist).toHaveBeenCalledWith("Some New Artist", false, true);
  });

  it("a node row focuses/pans to it and shows the sidebar (unchanged 'find on map' behaviour)", () => {
    State.graphNodes = [{ id: 7, name: "Some Artist" }];
    State.network = { focus: vi.fn() };
    renderNodeSearchResults("some artist");
    els.nodeSearchResults.querySelector('[data-kind="node"]').click();
    expect(State.network.focus).toHaveBeenCalledWith("7", expect.any(Object));
    expect(showArtistSidebar).toHaveBeenCalledWith("7");
  });
});

describe("bare Enter with no row explicitly highlighted", () => {
  it("still submits the typed name as a new-seed search — same muscle memory as the hero form", () => {
    setupNodeSearch();
    openNodeSearch();
    els.nodeSearchInput.value = "Some New Artist";
    els.nodeSearchInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true })
    );
    expect(searchArtist).toHaveBeenCalledWith("Some New Artist", false, true);
    expect(els.nodeSearchOverlay.classList.contains("show")).toBe(false);
  });

  it("does nothing when the field is empty", () => {
    setupNodeSearch();
    openNodeSearch();
    els.nodeSearchInput.value = "";
    els.nodeSearchInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true })
    );
    expect(searchArtist).not.toHaveBeenCalled();
  });
});
