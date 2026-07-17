// ════════════════════════════════════════════════════════════════════════════
// ui/compare-panel.js — SF-WEB-20 "Compare two artists" companion-panel
// section: given two artists (+ optionally the BFS path between them), show
// the trace connecting them and the artists they both immediately
// collaborate with, both as clickable lists — click focuses that node on
// the canvas and opens its own artist-sidebar context, same interaction as
// every other companion-panel entry point (path-chain cards, node-search
// results). showComparePanel(idA, idB, path) itself is the whole public
// surface here — [SF-WEB-47] the two artists (and the path between them)
// are picked/computed graph-natively via vis-adapter/compare-mode.js's
// Compare mode toggle, which calls straight in here on a completed pick
// (and separately highlights that same path on the canvas). The old
// pin-to-select mechanic (State.pinnedNodes + physics.js's node-position
// pin) this used to gate on is gone entirely — it only ever existed for
// this, and picking a pair has nothing to do with locking a node's
// position.
//
// Client-side only, no new backend endpoint: both compared artists are
// necessarily already-loaded graph nodes (Compare mode only ever offers
// nodes currently on the canvas), so their immediate neighbours are
// already fully present in State.graphEdges — a plain set intersection is
// enough. A backend endpoint would only be justified if comparison needed
// to reach beyond the currently-loaded graph (e.g. artists never rendered
// together), which this mode doesn't need.
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { escapeHtml, placeholderFor } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { closePathPanel } from "./modals.js";
import { hideArtistSidebar, showArtistSidebar } from "./sidebar.js";
import { renderHopChain } from "./path-result.js";

/**
 * Pure: the immediate-neighbour id set of `nodeId` within `edges` — the
 * other endpoint of every edge touching nodeId. Same "1 hop" adjacency
 * sidebar.js's computeRoleBreakdown already derives from State.graphEdges.
 */
export function neighboursOf(nodeId, edges) {
  const ids = new Set();
  (edges || []).forEach(e => {
    if (e.from === nodeId) ids.add(e.to);
    else if (e.to === nodeId) ids.add(e.from);
  });
  return ids;
}

/**
 * Pure: ids common to both artists' immediate-neighbour sets, excluding the
 * two compared artists themselves.
 */
export function computeCommonCollaborators(idA, idB, edges) {
  const a = neighboursOf(idA, edges);
  const b = neighboursOf(idB, edges);
  const common = [];
  a.forEach(id => {
    if (id !== idA && id !== idB && b.has(id)) common.push(id);
  });
  return common;
}

export function isComparePanelOpen() {
  return !!els.comparePanel?.classList.contains("show");
}

export function closeComparePanel() {
  els.comparePanel?.classList.remove("show");
  els.companionPanel?.classList.remove("show");
}

// Shared click/Enter/Space "focus this node on canvas + open its sidebar"
// activation — used by both the compare-pair header (the two artists being
// compared) and the shared-collaborators list below it.
function _wireActivate(el, targetId) {
  const onActivate = () => {
    if (State.network) {
      State.network.focus(targetId, { scale: 1.2, animation: { duration: 400, easingFunction: "easeInOutQuad" } });
    }
    showArtistSidebar(targetId);
  };
  el.addEventListener("click", onActivate);
  el.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
  });
}

function _comparePairItemHtml(node, id) {
  const name = node?.name || String(id);
  const avatar = node?.imageUrl || placeholderFor(name, !!node?.isSeed);
  return `<div class="compare-pair-item" data-node-id="${escapeHtml(String(id))}" tabindex="0" role="button">
    <img class="compare-pair-avatar" src="${avatar}" alt="" loading="lazy">
    <span class="compare-pair-name">${escapeHtml(name)}</span>
  </div>`;
}

// [fix] path is the BFS chain from idA to idB (inclusive), already computed
// once by vis-adapter/compare-mode.js for the canvas highlight — passed in
// rather than recomputed here, and rendered via the exact same
// renderHopChain the six-degrees path result uses (State.graphEdges/
// graphNodes already carry everything it needs: both compared artists are
// necessarily already-loaded nodes). null/too-short means no path exists
// within the currently-loaded graph.
export function showComparePanel(idA, idB, path = null) {
  if (!els.comparePanel) return;
  const nodeA = State.graphNodes.find(n => n.id === idA);
  const nodeB = State.graphNodes.find(n => n.id === idB);
  if (!nodeA || !nodeB) return;

  // [SF-WEB-12] Companion panel shows exactly one context at a time.
  closePathPanel();
  hideArtistSidebar();

  if (els.compareTitle) els.compareTitle.textContent = `${nodeA.name} × ${nodeB.name}`;

  // [fix] The two compared artists themselves — was only ever visible as
  // plain text in the title above; reported as missing entirely.
  if (els.comparePair) {
    els.comparePair.innerHTML =
      _comparePairItemHtml(nodeA, idA) +
      `<span class="compare-pair-x" aria-hidden="true">×</span>` +
      _comparePairItemHtml(nodeB, idB);
    els.comparePair.querySelectorAll(".compare-pair-item").forEach(item => {
      const targetId = item.getAttribute("data-node-id") === String(idA) ? idA : idB;
      _wireActivate(item, targetId);
    });
  }

  // [fix] The trace from A to B (including both endpoints) — reported as
  // confusing/missing when the panel only ever showed "No shared
  // collaborators" with nothing tying the two artists together visually.
  if (els.compareHopChain) {
    const nameById = {};
    State.graphNodes.forEach(n => { nameById[n.id] = n.name; });
    if (path && path.length >= 2) {
      renderHopChain(path, [], [], nameById, els.compareHopChain);
    } else {
      els.compareHopChain.innerHTML =
        `<div style="color:var(--mist);font-size:12px;">No connecting path in the loaded graph.</div>`;
    }
  }

  const commonIds = computeCommonCollaborators(idA, idB, State.graphEdges);
  if (commonIds.length) {
    els.compareList.innerHTML = commonIds.map(id => {
      const n = State.graphNodes.find(nn => nn.id === id);
      const name = n?.name || String(id);
      const avatar = n?.imageUrl || placeholderFor(name, !!n?.isSeed);
      return `<div class="compare-item" data-node-id="${escapeHtml(String(id))}" tabindex="0" role="button">
        <img class="compare-item-avatar" src="${avatar}" alt="" loading="lazy">
        <span class="compare-item-name">${escapeHtml(name)}</span>
      </div>`;
    }).join("");

    els.compareList.querySelectorAll(".compare-item").forEach(item => {
      const targetId = commonIds.find(id => String(id) === item.getAttribute("data-node-id"));
      _wireActivate(item, targetId);
    });
  } else {
    els.compareList.innerHTML = `<div style="color:var(--mist);font-size:12px;">No shared collaborators.</div>`;
  }

  els.comparePanel.classList.add("show");
  els.companionPanel?.classList.add("show");
}

if (els.comparePanelClose) els.comparePanelClose.onclick = () => closeComparePanel();
