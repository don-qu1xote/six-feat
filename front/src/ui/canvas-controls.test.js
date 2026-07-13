// ════════════════════════════════════════════════════════════════════════════
// canvas-controls.test.js — unit tests for updateTruncationBanner (IDEA-50),
//                           [SF-WEB-21] toggleRoleFilter, the ⌘K binding in
//                           setupKeyboard, and openHelpOverlay/closeHelpOverlay.
//
// Heavy sibling modules (api.js, vis-adapter, analytics-client,
// canvas-decorator, transition, toast, history, modals, sidebar,
// candidate-picker) are mocked so this file only exercises
// canvas-controls.js's own logic, not the rest of the app's DOM/network wiring.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

vi.mock("../api/api.js", () => ({
  searchArtist: vi.fn(),
  showMoreCollaborations: vi.fn(),
}));
vi.mock("../vis-adapter/index.js", () => ({
  clearFocus: vi.fn(),
  destroyNetwork: vi.fn(),
  networkOptions: vi.fn(() => ({})),
}));
vi.mock("../api/analytics-client.js", () => ({ clearPathHighlight: vi.fn() }));
vi.mock("../dom/canvas-decorator.js", () => ({ startCanvasDecorator: vi.fn() }));
vi.mock("../dom/transition.js", () => ({ runHeroGraphTransition: vi.fn() }));
vi.mock("./toast.js", () => ({ showToast: vi.fn(), hideToast: vi.fn() }));
vi.mock("./history.js", () => ({ updateShareableUrl: vi.fn() }));
vi.mock("./modals.js", () => ({
  isSearchModalOpen: vi.fn(),
  closeSearchModal: vi.fn(),
  openSearchModal: vi.fn(),
  isPathPanelOpen: vi.fn(),
  closePathPanel: vi.fn(),
  closeNodeSearch: vi.fn(),
  openNodeSearch: vi.fn(),
}));
vi.mock("./sidebar.js", () => ({ hideArtistSidebar: vi.fn() }));
vi.mock("./candidate-picker.js", () => ({ hideCandidatePicker: vi.fn() }));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { showMoreCollaborations } from "../api/api.js";
import { closeNodeSearch, openNodeSearch } from "./modals.js";
import {
  updateTruncationBanner, setupLoadMoreCollabs, setupKeyboard,
  toggleRoleFilter, openHelpOverlay, closeHelpOverlay,
} from "./canvas-controls.js";

function freshEl(tag = "div") { return document.createElement(tag); }

beforeEach(() => {
  vi.clearAllMocks();
  State.truncated = false;
  State.shownSongCount = 0;
  State.songLimit = 0;
  State.activeFilters = new Set(["featured", "producer", "writer"]);
  State.pathHighlight = null;

  // [style pass] The banner is now a single plus-icon <button> — no
  // separate text/action children — the descriptive message lives in
  // title/aria-label, and a click on the button itself is the action.
  els.truncationBanner = document.createElement("button");
  els.truncationBanner.hidden = true;

  // [SF-WEB-21] ⌘K / Escape / help-overlay wiring.
  els.nodeSearchOverlay = freshEl();
  els.helpOverlay       = freshEl();
  els.helpClose         = freshEl("button");
  els.candidateOverlay  = freshEl();

  showMoreCollaborations.mockClear();
});

describe("updateTruncationBanner", () => {
  it("stays hidden when the graph response was not truncated", () => {
    State.truncated = false;
    updateTruncationBanner();
    expect(els.truncationBanner.hidden).toBe(true);
  });

  it("shows the banner with the shown-song-count in its title/aria-label when truncated", () => {
    State.truncated = true;
    State.shownSongCount = 40;
    State.songLimit = 40;
    updateTruncationBanner();
    expect(els.truncationBanner.hidden).toBe(false);
    expect(els.truncationBanner.title).toContain("40");
    expect(els.truncationBanner.getAttribute("aria-label")).toContain("40");
  });

  it("hides the banner again once a bigger-limit fetch is no longer truncated", () => {
    State.truncated = true;
    State.shownSongCount = 40;
    updateTruncationBanner();
    expect(els.truncationBanner.hidden).toBe(false);

    // Simulate "Show more collaborations" merging a fetch that now fits
    // comfortably under the new limit.
    State.truncated = false;
    State.shownSongCount = 45;
    updateTruncationBanner();
    expect(els.truncationBanner.hidden).toBe(true);
  });

  it("does nothing when the banner element is missing from the DOM", () => {
    els.truncationBanner = null;
    State.truncated = true;
    expect(() => updateTruncationBanner()).not.toThrow();
  });

  it("triggers showMoreCollaborations exactly once per click on the icon itself", () => {
    State.truncated = true;
    State.shownSongCount = 40;
    updateTruncationBanner();
    setupLoadMoreCollabs();

    els.truncationBanner.click();

    expect(showMoreCollaborations).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-21] ⌘K now opens/closes the command palette — same overlay/
// element, just a broader job (see ui/modals.js). setupKeyboard's own
// binding is unchanged; this asserts it still fires openNodeSearch/
// closeNodeSearch, ruling out a regression from the rail's #btn-node-search
// removal (which used to duplicate this exact toggle).
// ════════════════════════════════════════════════════════════════════════════
describe("[SF-WEB-21] setupKeyboard ⌘K binding", () => {
  // setupKeyboard() registers a real document-level listener with no
  // teardown hook — called once for the whole block (not per-`it`) so
  // repeat calls don't stack up duplicate listeners that would double-fire
  // on later assertions in this same jsdom document.
  beforeAll(() => setupKeyboard());

  function cmdK() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true }));
  }

  it("opens the palette when it isn't already shown", () => {
    cmdK();
    expect(openNodeSearch).toHaveBeenCalledTimes(1);
    expect(closeNodeSearch).not.toHaveBeenCalled();
  });

  it("closes the palette instead when it's already shown", () => {
    els.nodeSearchOverlay.classList.add("show");
    cmdK();
    expect(closeNodeSearch).toHaveBeenCalledTimes(1);
    expect(openNodeSearch).not.toHaveBeenCalled();
  });

  it("also toggles on Ctrl+K (non-Mac)", () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true }));
    expect(openNodeSearch).toHaveBeenCalledTimes(1);
  });
});

describe("[SF-WEB-21] toggleRoleFilter", () => {
  beforeEach(() => {
    els.heroInput = Object.assign(freshEl("input"), { value: "Drake" });
  });

  it("deactivates an active role and re-runs the current search", () => {
    toggleRoleFilter("featured");
    expect(State.activeFilters.has("featured")).toBe(false);
  });

  it("refuses to deactivate the last remaining active role", () => {
    State.activeFilters = new Set(["featured"]);
    toggleRoleFilter("featured");
    expect(State.activeFilters.has("featured")).toBe(true);
  });

  it("activates an inactive role", () => {
    State.activeFilters = new Set(["featured"]);
    toggleRoleFilter("producer");
    expect(State.activeFilters.has("producer")).toBe(true);
  });

  it("syncs .active on every button sharing that role's data-role attribute", () => {
    const btn = document.body.appendChild(freshEl("button"));
    btn.setAttribute("data-role", "featured");
    btn.classList.add("active");
    els.heroInput = freshEl("input");
    toggleRoleFilter("featured");
    expect(btn.classList.contains("active")).toBe(false);
    btn.remove();
  });
});

describe("[SF-WEB-21] openHelpOverlay / closeHelpOverlay", () => {
  it("open adds .show, close removes it", () => {
    openHelpOverlay();
    expect(els.helpOverlay.classList.contains("show")).toBe(true);
    closeHelpOverlay();
    expect(els.helpOverlay.classList.contains("show")).toBe(false);
  });

  it("setupHelpOverlay's close button and backdrop click still work without a #help-btn trigger", async () => {
    const { setupHelpOverlay } = await import("./canvas-controls.js");
    setupHelpOverlay();
    openHelpOverlay();
    els.helpClose.click();
    expect(els.helpOverlay.classList.contains("show")).toBe(false);
  });
});
