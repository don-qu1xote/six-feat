// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/compare-mode.js — SF-WEB-47: graph-native Compare mode. A
// toggle that changes what a node click DOES (pick a comparison endpoint)
// instead of requiring the (now-removed) pin-to-select mechanic. Deliberately
// a thin layer on top of what already exists:
//   - showComparePanel (ui/compare-panel.js) — the exact same comparison
//     render the old pinned-pair rail button already ran.
//   - bfsPath/highlightPath (analytics-client.js / highlight.js) — the same
//     client-side BFS + three-level path dimming the six-degrees text
//     search already uses, so the connecting path between the two compared
//     artists lights up on the canvas alongside the panel. Client-side
//     only: both compared artists are necessarily already-loaded graph
//     nodes, same reasoning compare-panel.js's own header comment gives for
//     computeCommonCollaborators not needing a backend call either.
//   - markCompareEndpoint/clearCompareEndpoints (highlight.js) — the visual
//     first/second pick markers, a third marker kind distinct from
//     selectNode's persistent-selection ring (SF-WEB-28). Physics.js's old
//     position-pin is gone entirely — it only ever existed to gate
//     Compare, and picking a pair now has nothing to do with locking a
//     node's position.
// events.js's click handler calls isCompareModeActive()/
// handleCompareModeNodeClick at the very top of its node-click branch when
// the mode is on, bypassing the ordinary selectObject() flow entirely for
// as long as it's on.
// ════════════════════════════════════════════════════════════════════════════
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
  // [fix] All ambient highlighting off while picking — this used to only
  // suppress our OWN highlightNeighborhood/highlightEdgePair calls (via
  // isSelectionActive() in events.js); vis.js's native hover/tooltip
  // (interaction.hover, driven independently of that) kept firing
  // regardless, reported as distracting tooltips/edge coloring showing up
  // mid-pick. Restored on exit below.
  State.network?.setOptions({ interaction: { hover: false } });
  _syncButton();
  showToast("Compare mode — click a node to pick the first artist.", 5000, true);
}

// silent: true skips the "exited" toast — used when exiting mid-flow (a
// completed pick immediately opens the Compare panel, which is its own
// feedback; a second "off" toast right on top of that would just be noise)
// and when the graph itself was replaced out from under an in-progress pick
// (state.js::resetExpansionState already dropped compareModeStartId by the
// time that happens — see its own comment).
export function exitCompareMode({ silent = false } = {}) {
  if (!State.compareMode && State.compareModeStartId == null) { _syncButton(); return; }
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

// Called by events.js instead of selectObject() when Compare mode is
// active. First node click → first pick; second (different) node click →
// second pick, which immediately opens the Compare panel for the pair and
// exits the mode. Guards its own isCompareModeActive() rather than trusting
// every caller to check first — events.js already does, but a no-op here
// (instead of silently reading State.compareModeStartId as if a pick were
// in progress) is the safer default.
export function handleCompareModeNodeClick(nodeId) {
  if (!isCompareModeActive()) return;

  if (State.compareModeStartId == null) {
    // [SF-WEB-47] The graph may have changed since Compare mode was toggled
    // on (e.g. the seed itself was swapped) — nodeId is always freshly
    // clicked, so it's live by construction; nothing to validate here.
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

  // Defensive: the graph could in principle have been rebuilt between the
  // first pick and this click without exitCompareMode() running (every
  // deliberate exit already clears compareModeStartId — see clearCanvas()
  // and resetExpansionState() — so this only guards a path neither covers
  // yet).
  const firstNode = State.graphNodes.find(n => n.id === firstId);
  if (!firstNode) {
    exitCompareMode({ silent: true });
    showToast("The graph changed — Compare mode was reset. Try again.", 3200);
    return;
  }

  markCompareEndpoint(nodeId, "second");
  // Nothing async or canvas-rebuilding involved — safe to revert the pick
  // markers immediately, the panel/path-highlight are their own feedback.
  exitCompareMode({ silent: true });

  // [SF-WEB-47] Computed once, used two ways: the trace rendered inside the
  // Compare panel (showComparePanel's 3rd arg — every hop from firstId to
  // nodeId inclusive) AND the same three-level dimming highlight the
  // six-degrees text search uses, lit up on the canvas alongside it.
  // Client-side (both nodes are already loaded, no backend round-trip
  // needed) via the same BFS the artist sidebar's "1 hop from seed" chain
  // uses. null/too-short means no path exists in the currently-loaded
  // graph — showComparePanel renders its own "no connection" fallback for
  // that case, and the canvas simply isn't touched.
  const path = bfsPath(firstId, nodeId);
  const validPath = path && path.length >= 2 ? path : null;

  showComparePanel(firstId, nodeId, validPath);

  if (validPath) {
    setPathHighlight(validPath);
    highlightPath(validPath);
  }
}

export function setupCompareModeToggle() {
  els.btnCompareMode?.addEventListener("click", toggleCompareMode);
}
