// ════════════════════════════════════════════════════════════════════════════
// modals.test.js — [SF-WEB-12] unit tests for the companion panel's path
//                   context (ui/modals.js::isPathPanelOpen/openPathPanel/
//                   closePathPanel).
//
// Node/edge context is covered in sidebar.test.js; this file covers the
// other half of the companion panel's mutual exclusivity — opening the
// path section must close whatever node/edge context was showing, and vice
// versa (see sidebar.js's own tests for that direction).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./sidebar.js", () => ({
  hideArtistSidebar: vi.fn(),
  showArtistSidebar: vi.fn(),
  syncCompanionEmpty: vi.fn(),
}));
vi.mock("./candidate-picker.js", () => ({ hideCandidatePicker: vi.fn() }));
vi.mock("../vis-adapter/index.js", () => ({ setFocus: vi.fn() }));
// [SF-WEB-21] Command-row actions the palette reaches into — mocked here so
// this file doesn't pull in canvas-controls.js's/api.js's own heavy real
// dependency trees just to test the path-panel open/close behaviour above.
vi.mock("../api/api.js", () => ({ searchArtist: vi.fn() }));
vi.mock("./canvas-controls.js", () => ({
  exportGraphPng: vi.fn(), clearCanvas: vi.fn(),
  toggleRoleFilter: vi.fn(), openHelpOverlay: vi.fn(),
}));
vi.mock("./history.js", () => ({ copyShareableLink: vi.fn() }));
vi.mock("./theme.js", () => ({ setTheme: vi.fn() }));

import { els } from "../dom/dom.js";
import { hideArtistSidebar, syncCompanionEmpty } from "./sidebar.js";
import { hideCandidatePicker } from "./candidate-picker.js";
import { isPathPanelOpen, openPathPanel, closePathPanel } from "./modals.js";

function freshEl(tag = "div") { return document.createElement(tag); }

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  els.companionPanel = freshEl();
  els.pathPanel       = freshEl();
  els.pathFromInput   = freshEl("input");
  // Detached elements can't become document.activeElement in jsdom — attach
  // it, matching the real element always being in the page.
  document.body.appendChild(els.pathFromInput);
  els.searchModal     = freshEl();
  // openPathPanel() unconditionally calls closeNodeSearch(), which touches
  // these two — real elements needed so it doesn't throw on a null ref.
  els.nodeSearchOverlay = freshEl();
  els.nodeSearchInput   = freshEl("input");
});

describe("isPathPanelOpen", () => {
  it("reflects the path section's own .show class", () => {
    expect(isPathPanelOpen()).toBe(false);
    els.pathPanel.classList.add("show");
    expect(isPathPanelOpen()).toBe(true);
  });
});

describe("openPathPanel", () => {
  it("shows the path section and syncs the companion panel's empty state", () => {
    openPathPanel();
    expect(els.pathPanel.classList.contains("show")).toBe(true);
    // [SF-WEB-22] syncCompanionEmpty() (sidebar.js, mocked here) is now the
    // one place that toggles companionPanel/.companion-empty visibility —
    // real coverage of that logic lives in sidebar.test.js.
    expect(syncCompanionEmpty).toHaveBeenCalled();
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
});

describe("closePathPanel", () => {
  it("hides the path section and syncs the companion panel's empty state", () => {
    els.pathPanel.classList.add("show");
    closePathPanel();
    expect(els.pathPanel.classList.contains("show")).toBe(false);
    expect(syncCompanionEmpty).toHaveBeenCalled();
  });
});