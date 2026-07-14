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
  // [SF-WEB-30] Docked search forces Explore mode on open — see
  // openSearchModal's docked branch — so these need real elements too.
  els.heroInput             = freshEl("input");
  els.heroModeSwitch        = freshEl();
  els.heroModeTabExplore    = freshEl("button");
  els.heroModeTabConnect    = freshEl("button");
  els.heroModePanelExplore  = freshEl();
  els.heroModePanelConnect  = freshEl();
  // Detached elements can't become document.activeElement in jsdom, NOR do
  // clicks on them bubble anywhere (a detached node has no parent to
  // bubble into, so they'd never reach the shared document click listener
  // at all) — attach everything the outside-click tests below click on,
  // matching how these elements are always actually in the page.
  document.body.append(
    els.pathFromInput, els.pathPanel, els.searchModal, els.nodeSearchOverlay,
    els.btnSearchOpen, els.btnNodeSearch, els.btnFindPath, els.heroInput,
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
  // [SF-WEB-30] Simulate a Connect-mode selection left over from a previous
  // full-screen landing visit — openSearchModal({docked:true}) must reset
  // this every time, not just on first open.
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

// [SF-WEB-30] Docked search (.search-modal.docked) shows only the Explore
// (new-seed) search box — the Explore/Connect switch, Connect panel, and
// role-filter row are hidden entirely (CSS, not asserted here — jsdom
// doesn't load index.html's stylesheet). What IS testable here: the
// `.docked` class itself gets applied, and that opening docked mode always
// resets any leftover Connect-mode selection back to Explore, so the
// (now-hidden) Connect panel can never be the one left active underneath.
describe("[SF-WEB-30] openSearchModal(docked) shows only the Explore box", () => {
  it("adds the .docked class", () => {
    openSearchModal({ docked: true });
    expect(els.searchModal.classList.contains("docked")).toBe(true);
  });

  it("resets a leftover Connect-mode selection back to Explore", () => {
    // beforeEach above leaves heroModeSwitch/panels in Connect mode,
    // simulating a prior full-screen landing visit.
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
    expect(State.heroMode).toBe("connect"); // set by beforeEach
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