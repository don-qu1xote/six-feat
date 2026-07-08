// ════════════════════════════════════════════════════════════════════════════
// canvas-controls.test.js — unit tests for updateTruncationBanner (IDEA-50).
//
// Heavy sibling modules (api.js, vis-adapter, analytics-client,
// canvas-decorator, transition, toast, history, modals, sidebar,
// candidate-picker) are mocked so this file only exercises
// updateTruncationBanner's own show/hide/text logic against State.truncated/
// shownSongCount, not the rest of canvas-controls.js's DOM/network wiring.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

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
import { updateTruncationBanner } from "./canvas-controls.js";

beforeEach(() => {
  State.truncated = false;
  State.shownSongCount = 0;
  State.songLimit = 0;

  els.truncationBanner = document.createElement("span");
  els.truncationBanner.hidden = true;
  els.truncationBannerText = document.createElement("span");
  els.truncationBanner.appendChild(els.truncationBannerText);
});

describe("updateTruncationBanner", () => {
  it("stays hidden when the graph response was not truncated", () => {
    State.truncated = false;
    updateTruncationBanner();
    expect(els.truncationBanner.hidden).toBe(true);
  });

  it("shows the banner with the shown-song-count when truncated", () => {
    State.truncated = true;
    State.shownSongCount = 40;
    State.songLimit = 40;
    updateTruncationBanner();
    expect(els.truncationBanner.hidden).toBe(false);
    expect(els.truncationBannerText.textContent).toContain("40");
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
});
