import { State, MOTION, visAnimation } from "../state/state.js";
import { escapeHtml, placeholderFor } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { closePathPanel } from "./modals.js";
import { hideArtistSidebar, showArtistSidebar } from "./sidebar.js";
import { renderHopChain } from "./path-result.js";

export function neighboursOf(nodeId, edges) {
  const ids = new Set();
  (edges || []).forEach((e) => {
    if (e.from === nodeId) ids.add(e.to);
    else if (e.to === nodeId) ids.add(e.from);
  });
  return ids;
}

export function computeCommonCollaborators(idA, idB, edges) {
  const a = neighboursOf(idA, edges);
  const b = neighboursOf(idB, edges);
  const common = [];
  a.forEach((id) => {
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

function _wireActivate(el, targetId) {
  const onActivate = () => {
    if (State.network) {
      State.network.focus(targetId, { scale: 1.2, animation: visAnimation(MOTION.flight) });
    }
    showArtistSidebar(targetId);
  };
  el.addEventListener("click", onActivate);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate();
    }
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

export function showComparePanel(idA, idB, path = null) {
  if (!els.comparePanel) return;
  const nodeA = State.graphNodes.find((n) => n.id === idA);
  const nodeB = State.graphNodes.find((n) => n.id === idB);
  if (!nodeA || !nodeB) return;

  closePathPanel();
  hideArtistSidebar();

  if (els.compareTitle) els.compareTitle.textContent = `${nodeA.name} × ${nodeB.name}`;

  if (els.comparePair) {
    els.comparePair.innerHTML =
      _comparePairItemHtml(nodeA, idA) +
      `<span class="compare-pair-x" aria-hidden="true">×</span>` +
      _comparePairItemHtml(nodeB, idB);
    els.comparePair.querySelectorAll(".compare-pair-item").forEach((item) => {
      const targetId = item.getAttribute("data-node-id") === String(idA) ? idA : idB;
      _wireActivate(item, targetId);
    });
  }

  if (els.compareHopChain) {
    const nameById = {};
    State.graphNodes.forEach((n) => {
      nameById[n.id] = n.name;
    });
    if (path && path.length >= 2) {
      renderHopChain(path, [], [], nameById, els.compareHopChain);
    } else {
      els.compareHopChain.innerHTML = `<div style="color:var(--mist);font-size:12px;">No connecting path in the loaded graph.</div>`;
    }
  }

  const commonIds = computeCommonCollaborators(idA, idB, State.graphEdges);
  if (commonIds.length) {
    els.compareList.innerHTML = commonIds
      .map((id) => {
        const n = State.graphNodes.find((nn) => nn.id === id);
        const name = n?.name || String(id);
        const avatar = n?.imageUrl || placeholderFor(name, !!n?.isSeed);
        return `<div class="compare-item" data-node-id="${escapeHtml(String(id))}" tabindex="0" role="button">
        <img class="compare-item-avatar" src="${avatar}" alt="" loading="lazy">
        <span class="compare-item-name">${escapeHtml(name)}</span>
      </div>`;
      })
      .join("");

    els.compareList.querySelectorAll(".compare-item").forEach((item) => {
      const targetId = commonIds.find((id) => String(id) === item.getAttribute("data-node-id"));
      _wireActivate(item, targetId);
    });
  } else {
    els.compareList.innerHTML = `<div style="color:var(--mist);font-size:12px;">No shared collaborators.</div>`;
  }

  els.comparePanel.classList.add("show");
  els.companionPanel?.classList.add("show");
}

if (els.comparePanelClose) els.comparePanelClose.onclick = () => closeComparePanel();
