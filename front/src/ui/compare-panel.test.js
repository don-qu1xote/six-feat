// ════════════════════════════════════════════════════════════════════════════
// compare-panel.test.js — [SF-WEB-20] unit tests for the companion panel's
// compare section (ui/compare-panel.js): the pure intersection helper and
// the panel render (pair header + trace + list + click-to-focus).
// [SF-WEB-47] The pair (and the path between them) is now picked/computed
// graph-natively (vis-adapter/compare-mode.js) — see compare-mode.test.js
// for the "click two nodes" flow; this file only covers showComparePanel's
// own rendering once it's given a pair (+ optional path), which
// compare-mode.js calls straight into. renderHopChain (path-result.js) is
// mocked here — its own rendering is covered by path-result.test.js; this
// file only asserts showComparePanel calls it correctly / falls back
// correctly when no path is given.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./modals.js", () => ({ closePathPanel: vi.fn() }));
vi.mock("./sidebar.js", () => ({
  hideArtistSidebar: vi.fn(),
  showArtistSidebar: vi.fn(),
}));
const renderHopChain = vi.fn();
vi.mock("./path-result.js", () => ({
  renderHopChain: (...args) => renderHopChain(...args),
}));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import {
  neighboursOf, computeCommonCollaborators,
  showComparePanel, closeComparePanel, isComparePanelOpen,
} from "./compare-panel.js";
import { closePathPanel } from "./modals.js";
import { hideArtistSidebar, showArtistSidebar } from "./sidebar.js";

function freshEl(tag = "div") { return document.createElement(tag); }

function mockNode(id, name, overrides = {}) {
  return { id, name, imageUrl: "", isSeed: false, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  State.graphNodes = [];
  State.graphEdges = [];
  State.network = null;

  els.companionPanel = freshEl();
  els.comparePanel   = freshEl();
  els.comparePanelClose = freshEl("button");
  els.compareTitle   = freshEl();
  els.comparePair    = freshEl();
  els.compareHopChain = freshEl();
  els.compareList    = freshEl();
});

// Two mock neighbourhoods, per the ticket's own test spec: A shares 2 and 4
// with B, and each also has a collaborator the other doesn't.
const EDGES = [
  { from: 1, to: 2 }, // A–2 (shared)
  { from: 1, to: 3 }, // A–3 (only A)
  { from: 1, to: 4 }, // A–4 (shared)
  { from: 5, to: 2 }, // B–2 (shared)
  { from: 5, to: 4 }, // B–4 (shared)
  { from: 5, to: 6 }, // B–6 (only B)
];

describe("neighboursOf", () => {
  it("collects the other endpoint of every edge touching the node", () => {
    expect(neighboursOf(1, EDGES)).toEqual(new Set([2, 3, 4]));
    expect(neighboursOf(5, EDGES)).toEqual(new Set([2, 4, 6]));
  });
});

describe("computeCommonCollaborators", () => {
  it("returns the correct intersection for two mock neighbourhoods", () => {
    expect(computeCommonCollaborators(1, 5, EDGES).sort()).toEqual([2, 4]);
  });

  it("excludes the two compared artists from their own intersection", () => {
    const edges = [{ from: 1, to: 5 }, { from: 1, to: 2 }, { from: 5, to: 2 }];
    expect(computeCommonCollaborators(1, 5, edges)).toEqual([2]);
  });

  it("returns an empty array when neighbourhoods don't overlap", () => {
    const edges = [{ from: 1, to: 3 }, { from: 5, to: 6 }];
    expect(computeCommonCollaborators(1, 5, edges)).toEqual([]);
  });
});

describe("showComparePanel", () => {
  beforeEach(() => {
    State.graphNodes = [
      mockNode(1, "Artist A"), mockNode(5, "Artist B"),
      mockNode(2, "Common One"), mockNode(4, "Common Two"),
      mockNode(3, "Only A"), mockNode(6, "Only B"),
    ];
    State.graphEdges = EDGES;
  });

  it("closes competing companion-panel sections and shows the compare section", () => {
    showComparePanel(1, 5);

    expect(closePathPanel).toHaveBeenCalled();
    expect(hideArtistSidebar).toHaveBeenCalled();
    expect(els.comparePanel.classList.contains("show")).toBe(true);
    expect(els.companionPanel.classList.contains("show")).toBe(true);
    expect(isComparePanelOpen()).toBe(true);
  });

  it("titles the section and lists exactly the common collaborators", () => {
    showComparePanel(1, 5);

    expect(els.compareTitle.textContent).toBe("Artist A × Artist B");
    const items = els.compareList.querySelectorAll(".compare-item");
    expect(items.length).toBe(2);
    expect(els.compareList.textContent).toContain("Common One");
    expect(els.compareList.textContent).toContain("Common Two");
    expect(els.compareList.textContent).not.toContain("Only A");
    expect(els.compareList.textContent).not.toContain("Only B");
  });

  it("renders a no-overlap message when there is nothing in common", () => {
    State.graphEdges = [{ from: 1, to: 3 }, { from: 5, to: 6 }];
    showComparePanel(1, 5);

    expect(els.compareList.querySelectorAll(".compare-item").length).toBe(0);
    expect(els.compareList.textContent).toContain("No shared collaborators");
  });

  it("clicking a common-artist item focuses it and opens its sidebar", () => {
    State.network = { focus: vi.fn() };
    showComparePanel(1, 5);

    const item = els.compareList.querySelector('[data-node-id="2"]');
    item.dispatchEvent(new Event("click", { bubbles: true }));

    expect(State.network.focus).toHaveBeenCalledWith(2, expect.any(Object));
    expect(showArtistSidebar).toHaveBeenCalledWith(2);
  });

  it("does nothing if either compared node isn't in the current graph", () => {
    showComparePanel(1, 999);
    expect(els.comparePanel.classList.contains("show")).toBe(false);
  });

  // [fix] Reported as missing entirely — only the "A × B" text title
  // existed, no visual trace of which two artists are being compared.
  it("shows both compared artists (avatar + name) in the pair header", () => {
    showComparePanel(1, 5);

    const items = els.comparePair.querySelectorAll(".compare-pair-item");
    expect(items.length).toBe(2);
    expect(els.comparePair.textContent).toContain("Artist A");
    expect(els.comparePair.textContent).toContain("Artist B");
    expect(els.comparePair.querySelector('[data-node-id="1"]')).toBeTruthy();
    expect(els.comparePair.querySelector('[data-node-id="5"]')).toBeTruthy();
  });

  it("clicking either artist in the pair header focuses it and opens its sidebar", () => {
    State.network = { focus: vi.fn() };
    showComparePanel(1, 5);

    const second = els.comparePair.querySelector('[data-node-id="5"]');
    second.dispatchEvent(new Event("click", { bubbles: true }));

    expect(State.network.focus).toHaveBeenCalledWith(5, expect.any(Object));
    expect(showArtistSidebar).toHaveBeenCalledWith(5);
  });

  // [fix] Reported as confusing — the panel only ever showed "No shared
  // collaborators" with no trace at all connecting the two artists, even
  // though a path (via the seed or otherwise) may well exist.
  it("renders the trace via renderHopChain (reused from the six-degrees path result) when a path is given", () => {
    showComparePanel(1, 5, [1, 3, 5]);

    expect(renderHopChain).toHaveBeenCalledWith(
      [1, 3, 5], [], [],
      expect.objectContaining({ 1: "Artist A", 5: "Artist B" }),
      els.compareHopChain,
    );
  });

  it("shows a no-connection fallback instead of calling renderHopChain when no path is given", () => {
    showComparePanel(1, 5); // no 3rd arg — no path found

    expect(renderHopChain).not.toHaveBeenCalled();
    expect(els.compareHopChain.textContent).toContain("No connecting path");
  });
});

describe("closeComparePanel", () => {
  it("hides the compare section and the shared companion panel", () => {
    els.comparePanel.classList.add("show");
    els.companionPanel.classList.add("show");

    closeComparePanel();

    expect(els.comparePanel.classList.contains("show")).toBe(false);
    expect(els.companionPanel.classList.contains("show")).toBe(false);
  });
});

