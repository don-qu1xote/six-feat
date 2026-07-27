import { State, setPathHighlight } from "../state/state.js";
import { els } from "../dom/dom.js";
import { markCompareEndpoint, clearCompareEndpoints, highlightPath } from "./highlight.js";
import { showComparePanel, showToast } from "../ui/index.js";
import { bfsPath } from "../api/analytics-client.js";

function _syncButton() {
  els.btnCompareMode?.classList.toggle("active", State.compareMode === true);
  els.btnCompareMode?.setAttribute("aria-pressed", String(State.compareMode === true));
}

export function isCompareModeActive() {
  return State.compareMode === true;
}

export function enterCompareMode() {
  if (State.compareMode) return;
  State.compareMode = true;
  State.compareModeStartId = null;
  State.network?.setOptions({ interaction: { hover: false } });
  _syncButton();
  showToast("Compare mode — click a node to pick the first artist.", 5000, true);
}

export function exitCompareMode({ silent = false } = {}) {
  if (!State.compareMode && State.compareModeStartId == null) {
    _syncButton();
    return;
  }
  State.compareMode = false;
  State.compareModeStartId = null;
  clearCompareEndpoints();
  State.network?.setOptions({ interaction: { hover: true } });
  _syncButton();
  if (!silent) showToast("Compare mode off.", 2000, true);
}

export function toggleCompareMode() {
  isCompareModeActive() ? exitCompareMode() : enterCompareMode();
}

export function handleCompareModeNodeClick(nodeId) {
  if (!isCompareModeActive()) return;

  if (State.compareModeStartId == null) {
    State.compareModeStartId = nodeId;
    markCompareEndpoint(nodeId, "first");
    showToast("Pick the second artist to compare.", 5000, true);
    return;
  }

  const firstId = State.compareModeStartId;
  if (nodeId === firstId) {
    showToast("Pick a different node.", 2400);
    return;
  }

  const firstNode = State.graphNodes.find((n) => n.id === firstId);
  if (!firstNode) {
    exitCompareMode({ silent: true });
    showToast("The graph changed — Compare mode was reset. Try again.", 3200);
    return;
  }

  markCompareEndpoint(nodeId, "second");
  exitCompareMode({ silent: true });

  const path = bfsPath(firstId, nodeId);
  const validPath = path && path.length >= 2 ? path : null;

  showComparePanel(firstId, nodeId, validPath);

  if (validPath) {
    setPathHighlight(validPath);
    highlightPath(validPath, { dim: false });
  }
}

export function setupCompareModeToggle() {
  els.btnCompareMode?.addEventListener("click", toggleCompareMode);
}
