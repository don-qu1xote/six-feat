import { describe, it, expect, vi, beforeEach } from "vitest";
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { invalidateColorCache, resetHoverState } from "./highlight.js";

const showComparePanel = vi.fn();
const showToast = vi.fn();
vi.mock("../ui/index.js", () => ({
  showComparePanel: (...args) => showComparePanel(...args),
  showToast: (...args) => showToast(...args),
}));

const fetchPathBetween = vi.fn();
vi.mock("../api/analytics-client.js", () => ({
  fetchPathBetween: (...args) => fetchPathBetween(...args),
}));

const showLoading = vi.fn();
vi.mock("../ui/loading.js", () => ({
  showLoading: (...args) => showLoading(...args),
}));

function serverPath(path, extra = {}) {
  return { path, nodes: [], edges: [], error: null, ...extra };
}

import {
  isCompareModeActive,
  enterCompareMode,
  exitCompareMode,
  toggleCompareMode,
  handleCompareModeNodeClick,
} from "./compare-mode.js";

function mockDataSet(items) {
  const map = new Map(items.map((n) => [n.id, n]));
  return {
    get: (id) => map.get(id) || null,
    getIds: () => [...map.keys()],
    update: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchPathBetween.mockResolvedValue(serverPath([]));
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
    expect(showToast).toHaveBeenCalledWith(
      expect.stringMatching(/first/i),
      expect.any(Number),
      true,
    );
  });

  it("enterCompareMode disables the network's native hover (tooltip); exitCompareMode restores it", () => {
    enterCompareMode();
    expect(State.network.setOptions).toHaveBeenCalledWith({ interaction: { hover: false } });

    State.network.setOptions.mockClear();
    exitCompareMode();
    expect(State.network.setOptions).toHaveBeenCalledWith({ interaction: { hover: true } });
  });

  it("exitCompareMode turns the mode off, un-marks the button, and reverts any endpoint marker", () => {
    enterCompareMode();
    handleCompareModeNodeClick(1);
    expect(State.nodesDS.update).toHaveBeenCalled();
    State.nodesDS.update.mockClear();

    exitCompareMode();
    expect(isCompareModeActive()).toBe(false);
    expect(State.compareModeStartId).toBeNull();
    expect(els.btnCompareMode.classList.contains("active")).toBe(false);
    expect(State.nodesDS.update).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 1 })]),
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
    expect(showComparePanel).toHaveBeenCalledWith(1, 2, { loading: true });
  });

  it("paints visibly different markers for first vs. second", () => {
    enterCompareMode();
    handleCompareModeNodeClick(1);
    const firstUpd = State.nodesDS.update.mock.calls.at(-1)[0];
    State.nodesDS.update.mockClear();

    handleCompareModeNodeClick(2);
    const secondUpd = State.nodesDS.update.mock.calls.find((call) => call[0].id === 2)[0];

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
    State.graphNodes = State.graphNodes.filter((n) => n.id !== 1);
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
      ]),
    );
  });
});

describe("[SF-API-24] handleCompareModeNodeClick — the path comes from the server", () => {
  it("opens the panel in a loading state before the answer arrives", () => {
    let resolve;
    fetchPathBetween.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);

    expect(showComparePanel).toHaveBeenCalledWith(1, 2, { loading: true });
    expect(showLoading).toHaveBeenCalledWith(true, null, expect.stringMatching(/path/i));
    expect(showLoading).not.toHaveBeenCalledWith(false);

    resolve(serverPath([1, 3, 2]));
  });

  it("asks the single server endpoint for the picked pair, and highlights what it answers", async () => {
    fetchPathBetween.mockResolvedValue(serverPath([1, 3, 2]));
    enterCompareMode();
    handleCompareModeNodeClick(1);
    await handleCompareModeNodeClick(2);
    await vi.waitFor(() => expect(showLoading).toHaveBeenCalledWith(false));

    expect(fetchPathBetween).toHaveBeenCalledWith(1, 2);
    expect(State.pathHighlight).toEqual([1, 3, 2]);
    expect(showComparePanel).toHaveBeenLastCalledWith(1, 2, serverPath([1, 3, 2]));
  });

  it("passes the whole answer on, so the panel can name hops that are not on the canvas", async () => {
    const answer = serverPath([1, 42, 2], {
      nodes: [{ id: 42, name: "Never Drawn" }],
      edges: [{ from: 1, to: 42 }],
    });
    fetchPathBetween.mockResolvedValue(answer);
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);
    await vi.waitFor(() => expect(showLoading).toHaveBeenCalledWith(false));

    expect(showComparePanel).toHaveBeenLastCalledWith(1, 2, answer);
  });

  it("does not touch pathHighlight when the server reports no path", async () => {
    fetchPathBetween.mockResolvedValue(serverPath([], { error: "no_path" }));
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);
    await vi.waitFor(() => expect(showLoading).toHaveBeenCalledWith(false));

    expect(State.pathHighlight).toBeNull();
  });

  it("does not touch pathHighlight for a degenerate single-node answer", async () => {
    fetchPathBetween.mockResolvedValue(serverPath([1]));
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);
    await vi.waitFor(() => expect(showLoading).toHaveBeenCalledWith(false));

    expect(State.pathHighlight).toBeNull();
  });

  it("shows the failure in the panel instead of silently claiming there is no path", async () => {
    fetchPathBetween.mockRejectedValue(new Error("Network error"));
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);
    await vi.waitFor(() => expect(showLoading).toHaveBeenCalledWith(false));

    expect(showComparePanel).toHaveBeenLastCalledWith(1, 2, {
      error: "request_failed",
      message: "Network error",
    });
  });

  it("ignores a stale answer once a newer pair has been picked", async () => {
    let resolveFirst;
    fetchPathBetween.mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r;
      }),
    );
    fetchPathBetween.mockResolvedValueOnce(serverPath([1, 3]));

    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);

    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(3);
    await vi.waitFor(() => expect(showLoading).toHaveBeenCalledWith(false));

    resolveFirst(serverPath([1, 2]));
    await Promise.resolve();
    await Promise.resolve();

    expect(State.pathHighlight).toEqual([1, 3]);
    expect(showComparePanel).toHaveBeenLastCalledWith(1, 3, serverPath([1, 3]));
  });
});

describe("handleCompareModeNodeClick — dimming", () => {
  it("leaves an off-path node at full opacity — no deep-dim in Compare mode", async () => {
    fetchPathBetween.mockResolvedValue(serverPath([1, 2]));
    enterCompareMode();
    handleCompareModeNodeClick(1);
    handleCompareModeNodeClick(2);
    await vi.waitFor(() => expect(showLoading).toHaveBeenCalledWith(false));

    const [nodeUpdates] = State.nodesDS.update.mock.calls.at(-1);
    const off = nodeUpdates.find((u) => u.id === 3);
    expect(off.opacity).toBe(1);
  });
});
