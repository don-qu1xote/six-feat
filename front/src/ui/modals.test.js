// ════════════════════════════════════════════════════════════════════════════
// modals.test.js — [SF-WEB-12] unit tests for the companion panel's path
//                   context (ui/modals.js::isPathPanelOpen/openPathPanel/
//                   closePathPanel). [SF-WEB-24] also covers setupDockedPanels
//                   and the shared-registry exclusivity it gives openPathPanel/
//                   openSearchModal/openNodeSearch — ui/docked-panel.js's own
//                   generic mechanics (single document listener, outside-
//                   click, trigger exemption) are covered in
//                   docked-panel.test.js; this file only checks that the real
//                   three surfaces are actually wired to it correctly.
//
// Node/edge context is covered in sidebar.test.js; this file covers the
// other half of the companion panel's mutual exclusivity — opening the
// path section must close whatever node/edge context was showing, and vice
// versa (see sidebar.js's own tests for that direction). docked-panel.js
// itself is used for real (unmocked) here — it's a small, dependency-free
// module, so an integration-style test against the real registry is more
// useful than mocking it away.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("./sidebar.js", () => ({
  hideArtistSidebar: vi.fn(),
  showArtistSidebar: vi.fn(),
}));
vi.mock("./candidate-picker.js", () => ({ hideCandidatePicker: vi.fn() }));
vi.mock("../vis-adapter/index.js", () => ({ setFocus: vi.fn() }));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { hideArtistSidebar } from "./sidebar.js";
import { hideCandidatePicker } from "./candidate-picker.js";
import {
  isPathPanelOpen, openPathPanel, closePathPanel,
  isSearchModalOpen, openSearchModal,
  openNodeSearch,
  setupDockedPanels,
} from "./modals.js";

function freshEl(tag = "div") { return document.createElement(tag); }

// [SF-WEB-24] setupDockedPanels() registers each surface's el/trigger ONCE,
// by reference — creating fresh els.pathPanel/els.searchModal/
// els.nodeSearchOverlay per-test (the old pattern) would leave the
// registry holding stale references to a PREVIOUS test's elements, since
// registration only happens once here (see below for why). So this file
// creates every docked-panel-relevant element exactly once in beforeAll,
// and beforeEach only resets their state (classes/values), never their
// identity.
beforeAll(() => {
  els.companionPanel    = freshEl();
  els.pathPanel         = freshEl();
  els.pathFromInput     = freshEl("input");
  els.searchModal       = freshEl();
  els.nodeSearchOverlay = freshEl();
  els.nodeSearchInput   = freshEl("input");
  els.nodeSearchResults = freshEl();
  els.nodeSearchStatus  = freshEl();
  els.btnSearchOpen     = freshEl("button");
  els.btnNodeSearch     = freshEl("button");
  els.btnFindPath       = freshEl("button");
  // Detached elements can't become document.activeElement in jsdom, NOR do
  // clicks on them bubble anywhere (a detached node has no parent to
  // bubble into, so they'd never reach the shared document click listener
  // at all) — attach everything the outside-click tests below click on,
  // matching how these elements are always actually in the page.
  document.body.append(
    els.pathFromInput, els.pathPanel, els.searchModal, els.nodeSearchOverlay,
    els.btnSearchOpen, els.btnNodeSearch, els.btnFindPath,
  );

  // [SF-WEB-24] Registers all three surfaces with the shared ui/docked-
  // panel.js registry, which binds its one document click listener at
  // most once ever, module-wide — called here in beforeAll (not per-`it`),
  // same reasoning as docked-panel.test.js's own beforeAll. Every panel's
  // isOpen()/close() re-reads the current els.* state live, so this single
  // registration stays correct across every test below even though
  // beforeEach resets that state each time.
  setupDockedPanels();
});

beforeEach(() => {
  vi.clearAllMocks();
  els.companionPanel.className = "";
  els.pathPanel.className = "";
  els.searchModal.className = "";
  els.nodeSearchOverlay.className = "";
  els.pathFromInput.value = "";

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

  // [SF-WEB-24] Was two explicit calls (closeSearchModal()/closeNodeSearch())
  // inside openPathPanel() — now the shared docked-panel registry. These
  // assert the OBSERVABLE behaviour is unchanged, not the mechanism.
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