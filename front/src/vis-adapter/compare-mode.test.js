// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/compare-mode.test.js — SF-WEB-47: graph-native Compare mode
// (click two nodes to compare them, replacing the old pin-to-select
// mechanic). showComparePanel/bfsPath/highlightPath (ui/index.js,
// api/analytics-client.js) are mocked — this file is about compare-mode.js's
// own state machine (enter/exit/toggle, first→second pick sequencing, and
// the extra path-highlight step on a completed pick) and its use of
// highlight.js's real markCompareEndpoint/clearCompareEndpoints (exercised
// for real, not mocked, so a marker/revert bug would actually fail these
// tests).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { invalidateColorCache, resetHoverState } from "./highlight.js";

const showComparePanel = vi.fn();
const showToast        = vi.fn();
vi.mock("../ui/index.js", () => ({
  showComparePanel: (...args) => showComparePanel(...args),
  showToast:        (...args) => showToast(...args),
}));

const bfsPath = vi.fn(() => null);
vi.mock("../api/analytics-client.js", () => ({
  bfsPath: (...args) => bfsPath(...args),
}));

import {
  isCompareModeActive, enterCompareMode, exitCompareMode, toggleCompareMode,
  handleCompareModeNodeClick,
} from "./compare-mode.js";

function mockDataSet(items) {
  const map = new Map(items.map(n => [n.id, n]));
  return {
    get: id => map.get(id) || null,
    getIds: () => [...map.keys()],
    update: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  bfsPath.mockReturnValue(null);
  invalidateColorCache();
  resetHoverState();
  State.graphNodes = [
    { id: 1, name: "Alpha" },
    { id: 2, name: "Beta" },
    { id: 3, name: "Gamma" },
  ];
  State.graphEdges = [];
  State.nodesDS = mockDataSet(State.graphNodes);
  State.edgesDS = mockDataSet([]);
  State.expandedNodes = new Set();
  State.compareMode = false;
  State.compareModeStartId = null;
  State.pathHighlight = null;
  State.network = { setOptions: vi.fn() };
  els.btnCompareMode = document.createElement("button");
});

describe("enterCompareMode / exitCompareMode / toggleCompareMode", () => {
  it("enterCompareMode turns the mode on, marks the button active, and hints for a first pick", () => {
    enterCompareMode();
    expect(isCompareModeActive()).toBe(true);
    expect(State.compareModeStartId).toBeNull();
    expect(els.btnCompareMode.classList.contains("active")).toBe(true);
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/first/i), expect.any(Number), true);
  });

  // [fix] Reported as tooltips/edge-coloring still showing while picking —
  // our own highlightNeighborhood/highlightEdgePair were already suppressed
  // via isSelectionActive(), but vis.js's native hover/tooltip is
  // independent of that and needed its own explicit off/on toggle.
  it("enterCompareMode disables the network's native hover (tooltip); exitCompareMode restores it", () => {
    enterCompareMode();
    expect(State.network.setOptions).toHaveBeenCalledWith({ interaction: { hover: false } });

    State.network.setOptions.mockClear();
    exitCompareMode();
    expect(State.network.setOptions).toHaveBeenCalledWith({ interaction: { hover: true } });
  });

  it("exitCompareMode turns the mode off, un-marks the button, and reverts any endpoint marker", () => {
    enterCompareMode();
    handleCompareModeNodeClick(1); // picks a first, paints a marker
    expect(State.nodesDS.update).toHaveBeenCalled();
    State.nodesDS.update.mockClear();

    exitCompareMode();
    expect(isCompareModeActive()).toBe(false);
    expect(State.compareModeStartId).toBeNull();
    expect(els.btnCompareMode.classList.contains("active")).toBe(false);
    expect(State.nodesDS.update).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 1 })])
    );
  });

  it("exitCompareMode({silent:true}) does not show the 'off' toast", () => {
    enterCompareMode();
    showToast.mockClear();
    exitCompareMode({ silent: true });
    expect(showToast).not.toHaveBeenCalled();
  });

  it("toggleCompareMode flips between entered and exited", () => {
    toggleCompareMode();
    expect(isCompareModeActive()).toBe(true);
    toggleCompareMode();
    expect(isCompareModeActive()).toBe(false);
  });
});

describe("handleCompareModeNodeClick", () => {
  it("first click picks the first artist and marks it, second click picks a different second artist and opens the Compare panel", () => {
    enterCompareMode();

    handleCompareModeNodeClick(1);
    expect(State.compareModeStartId).toBe(1);
    expect(showComparePanel).not.toHaveBeenCalled();

    handleCompareModeNodeClick(2);
    expect(showComparePanel).toHaveBeenCalledWith(1, 2, null);
  });

  it("paints visibly different markers for first vs. second", () => {
    enterCompareMode();
    handleCompareModeNodeClick(1);
    const firstUpd = State.nodesDS.update.mock.calls.at(-1)[0];
    State.nodesDS.update.mockClear();

    handleCompareModeNodeClick(2);
    const secondUpd = State.nodesDS.update.mock.calls.find(call => call[0].id === 2)[0];

    expect(firstUpd.color.border).not.toBe(secondUpd.color.border);
  });

  it("a completed pick exits Compare mode (single-shot, not a persistent tool)", () => {
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);
    expect(isCompareModeActive()).toBe(false);
    expect(State.compareModeStartId).toBeNull();
  });

  it("clicking the same node twice keeps waiting for a different second pick, without opening the panel", () => {
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(1);
    expect(State.compareModeStartId).toBe(1);
    expect(showComparePanel).not.toHaveBeenCalled();
  });

  it("is a no-op outside Compare mode", () => {
    expect(isCompareModeActive()).toBe(false);
    handleCompareModeNodeClick(1);
    expect(State.compareModeStartId).toBeNull();
    expect(showComparePanel).not.toHaveBeenCalled();
  });

  it("resets gracefully instead of opening the panel if the first node vanished mid-pick (graph changed under it)", () => {
    enterCompareMode();
    handleCompareModeNodeClick(1);
    State.graphNodes = State.graphNodes.filter(n => n.id !== 1); // simulate a graph replaced mid-pick

    handleCompareModeNodeClick(2);
    expect(showComparePanel).not.toHaveBeenCalled();
    expect(isCompareModeActive()).toBe(false);
  });

  it("reverts both pick markers synchronously once the panel opens — no async settle needed, unlike a path search", () => {
    enterCompareMode();
    handleCompareModeNodeClick(1);
    State.nodesDS.update.mockClear();
    handleCompareModeNodeClick(2);

    expect(State.nodesDS.update).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 }),
      ])
    );
  });
});

// [SF-WEB-47] "additionally highlight the path" — the whole point of this
// round: Compare mode doesn't just open the panel, it also lights up the
// connecting path between the two picked artists, same three-level dimming
// the six-degrees text search already uses.
describe("handleCompareModeNodeClick — path highlight", () => {
  it("highlights the BFS path between the two picked artists when one exists, and passes it to showComparePanel", () => {
    bfsPath.mockReturnValue([1, 3, 2]);
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);

    expect(bfsPath).toHaveBeenCalledWith(1, 2);
    expect(State.pathHighlight).toEqual([1, 3, 2]);
    expect(showComparePanel).toHaveBeenCalledWith(1, 2, [1, 3, 2]);
  });

  it("does not touch pathHighlight when no path exists between the two artists, and passes null to showComparePanel", () => {
    bfsPath.mockReturnValue(null);
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);

    expect(State.pathHighlight).toBeNull();
    expect(showComparePanel).toHaveBeenCalledWith(1, 2, null);
  });

  it("does not touch pathHighlight for a degenerate single-node BFS result", () => {
    bfsPath.mockReturnValue([1]);
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);

    expect(State.pathHighlight).toBeNull();
    expect(showComparePanel).toHaveBeenCalledWith(1, 2, null);
  });

  // [SF-WEB-61] "убери затемнения при компаир моде и оставь только
  // подсветку всех нод пути и крайних" — a node NOT on the found path
  // (here: id 3, a bystander unrelated to the 1<->2 path) must be left at
  // full resting opacity, not the path finder's usual deep-dim.
  it("leaves an off-path node at full opacity — no deep-dim in Compare mode", () => {
    bfsPath.mockReturnValue([1, 2]);  // node 3 is not on this path
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);

    const [nodeUpdates] = State.nodesDS.update.mock.calls.at(-1);
    const off = nodeUpdates.find(u => u.id === 3);
    expect(off.opacity).toBe(1);
  });
});
