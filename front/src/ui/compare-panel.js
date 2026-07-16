// ════════════════════════════════════════════════════════════════════════════
// ui/compare-panel.js — SF-WEB-20 "Compare two artists" companion-panel
// section: given two pinned artists (object-action-bar's Pin/Unpin, see
// State.pinnedNodes), show the artists they both immediately collaborate
// with, as a clickable list — click focuses that node on the canvas and
// opens its own artist-sidebar context, same interaction as every other
// companion-panel entry point (path-chain cards, node-search results).
//
// Client-side only, no new backend endpoint: both compared artists are
// necessarily already-loaded graph nodes (State.pinnedNodes only ever
// contains ids of nodes currently on the canvas), so their immediate
// neighbours are already fully present in State.graphEdges — a plain set
// intersection is enough. A backend endpoint would only be justified if
// comparison needed to reach beyond the currently-loaded graph (e.g.
// artists never rendered together), which this mode doesn't need.
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { escapeHtml, placeholderFor } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { closePathPanel } from "./modals.js";
import { hideArtistSidebar, showArtistSidebar } from "./sidebar.js";
import { showToast } from "./toast.js";

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

export function showComparePanel(idA, idB) {
  if (!els.comparePanel) return;
  const nodeA = State.graphNodes.find(n => n.id === idA);
  const nodeB = State.graphNodes.find(n => n.id === idB);
  if (!nodeA || !nodeB) return;

  // [SF-WEB-12] Companion panel shows exactly one context at a time.
  closePathPanel();
  hideArtistSidebar();

  if (els.compareTitle) els.compareTitle.textContent = `${nodeA.name} × ${nodeB.name}`;

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
      const onActivate = () => {
        if (State.network) {
          State.network.focus(targetId, { scale: 1.2, animation: { duration: 400, easingFunction: "easeInOutQuad" } });
        }
        showArtistSidebar(targetId);
      };
      item.addEventListener("click", onActivate);
      item.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
      });
    });
  } else {
    els.compareList.innerHTML = `<div style="color:var(--mist);font-size:12px;">No shared collaborators.</div>`;
  }

  els.comparePanel.classList.add("show");
  els.companionPanel?.classList.add("show");
}

/**
 * Wires the rail's "Compare pinned artists" button: enabled only while
 * exactly two nodes are pinned (State.pinnedNodes), reflecting the count on
 * every pin/unpin via the same syncPinState-style pattern already used for
 * the object-action-bar's own pin button.
 */
export function wireComparePinnedButton() {
  const btn = els.btnComparePinned;
  if (!btn) return;

  btn.onclick = () => {
    const ids = Array.from(State.pinnedNodes);
    if (ids.length !== 2) {
      showToast("Pin exactly two artists to compare", 2400, true);
      return;
    }
    showComparePanel(ids[0], ids[1]);
  };
}

/** Reflects State.pinnedNodes.size on the rail button's disabled state — call after every pin/unpin. */
export function syncComparePinnedButton() {
  const btn = els.btnComparePinned;
  if (!btn) return;
  btn.disabled = State.pinnedNodes.size !== 2;
}

if (els.comparePanelClose) els.comparePanelClose.onclick = () => closeComparePanel();
