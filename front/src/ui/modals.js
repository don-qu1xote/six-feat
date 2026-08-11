import { State, MOTION, visAnimation } from "../state/state.js";
import { debounce, escapeHtml } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { setFocus, highlightPath, restoreDefaultColors } from "../vis-adapter/index.js";
import { hideArtistSidebar, showArtistSidebar } from "./sidebar.js";
import { hideCandidatePicker } from "./candidate-picker.js";
import { registerDockedPanel, closeOtherDockedPanels } from "./docked-panel.js";
import { closeComparePanel } from "./compare-panel.js";

let _searchModalPanel = null;
let _nodeSearchPanel = null;
let _pathPanel = null;

export function setupDockedPanels() {
  _searchModalPanel = registerDockedPanel({
    el: els.searchModal,
    trigger: els.btnSearchOpen,
    isOpen: () => isSearchModalOpen() && !!els.searchModal?.classList.contains("docked"),
    close: () => closeSearchModal(),
  });
  _nodeSearchPanel = registerDockedPanel({
    el: els.nodeSearchOverlay,
    trigger: els.btnNodeSearch,
    isOpen: () => !!els.nodeSearchOverlay?.classList.contains("show"),
    close: () => closeNodeSearch(),
  });
  _pathPanel = registerDockedPanel({
    el: els.pathPanel,
    trigger: els.btnFindPath,
    isOpen: () => isPathPanelOpen(),
    close: () => closePathPanel(),
  });
}

export function isPathPanelOpen() {
  return !!els.pathPanel?.classList.contains("show");
}

export function openPathPanel() {
  if (!els.pathPanel) return;
  closeOtherDockedPanels(_pathPanel);
  hideCandidatePicker();
  hideArtistSidebar();
  closeComparePanel();
  els.pathPanel.classList.add("show");
  els.companionPanel?.classList.add("show");
  els.pathFromInput?.focus();
}

export function closePathPanel() {
  els.pathPanel?.classList.remove("show");
  els.companionPanel?.classList.remove("show");
}

let isSearchModalOpenFlag = false;

export function isSearchModalOpen() {
  return isSearchModalOpenFlag;
}

export function openSearchModal(opts = {}) {
  const modal = els.searchModal;
  if (!modal) return;
  const docked = !!opts.docked;

  isSearchModalOpenFlag = true;
  modal.classList.remove("is-closed");
  modal.classList.toggle("docked", docked);
  closeOtherDockedPanels(_searchModalPanel);

  if (docked) {
    hideArtistSidebar();
    closeComparePanel();
    if (els.heroModeSwitch) els.heroModeSwitch.dataset.mode = "explore";
    els.heroModeTabExplore?.setAttribute("aria-selected", "true");
    if (els.heroModeTabExplore) els.heroModeTabExplore.tabIndex = 0;
    els.heroModeTabConnect?.setAttribute("aria-selected", "false");
    if (els.heroModeTabConnect) els.heroModeTabConnect.tabIndex = -1;
    els.heroModePanelExplore?.classList.add("is-active");
    els.heroModePanelConnect?.classList.remove("is-active");
    State.heroMode = "explore";
    if (els.heroInput) els.heroInput.focus();
    return;
  }

  if (State.hasRendered) modal.classList.remove("is-first-visit");
  if (State.hasRendered) els.appCanvas?.classList.add("search-open");
  document.body.classList.add("view-home");
  document.body.classList.remove("view-graph");
  if (els.heroInput) els.heroInput.focus();
}

export function closeSearchModal() {
  const modal = els.searchModal;
  if (!modal) return;

  isSearchModalOpenFlag = false;
  modal.classList.add("is-closed");
  modal.classList.remove("docked");
  els.appCanvas?.classList.remove("search-open");
  if (State.hasRendered) {
    document.body.classList.add("view-graph");
    document.body.classList.remove("view-home");
  }
}

export function forceCloseSearchModal() {
  closeSearchModal();
}

export function setupSearchModal() {
  els.btnSearchOpen?.addEventListener("click", () => {
    if (isSearchModalOpen()) closeSearchModal();
    else openSearchModal({ docked: true });
  });
}

let _nsActiveIndex = -1;

function _nsItems() {
  return [...els.nodeSearchResults.querySelectorAll(".ns-item")];
}

function _nsSetActive(index, items) {
  items.forEach((item) => {
    item.classList.remove("ns-active");
    item.setAttribute("aria-selected", "false");
  });
  _nsActiveIndex = index;
  const active = items[index];
  if (active) {
    active.classList.add("ns-active");
    active.setAttribute("aria-selected", "true");
    active.scrollIntoView({ block: "nearest" });
  }
  els.nodeSearchInput.setAttribute("aria-activedescendant", active ? active.id : "");
}

function _nsSelect(item) {
  const id = item.getAttribute("data-id");
  closeNodeSearch();
  if (!State.network) return;
  State.network.focus(id, { scale: 1.5, animation: visAnimation(MOTION.xxslow) });
  setFocus(id);
  showArtistSidebar(id);
}

export function openNodeSearch() {
  if (!State.hasRendered) return;
  closeOtherDockedPanels(_nodeSearchPanel);
  hideArtistSidebar();
  els.nodeSearchOverlay.classList.add("show");
  els.nodeSearchInput.setAttribute("aria-expanded", "true");
  els.nodeSearchInput.value = "";
  els.nodeSearchInput.focus();
  renderNodeSearchResults("");
}

export function closeNodeSearch() {
  els.nodeSearchOverlay.classList.remove("show");
  els.nodeSearchInput.setAttribute("aria-expanded", "false");
  els.nodeSearchInput.setAttribute("aria-activedescendant", "");
  _nsActiveIndex = -1;
  restoreDefaultColors();
}

export function renderNodeSearchResults(query) {
  const q = query.toLowerCase().trim();
  const seedId = State.currentSeedId;
  const results = q
    ? State.graphNodes
        .filter((n) => n.id !== seedId && n.name.toLowerCase().includes(q))
        .slice(0, 12)
    : State.graphNodes.filter((n) => n.id !== seedId).slice(0, 12);

  els.nodeSearchResults.innerHTML =
    results
      .map(
        (n, i) =>
          `<div class="ns-item" id="ns-item-${i}" data-id="${n.id}" role="option" aria-selected="false">` +
          `<span class="ns-name">${escapeHtml(n.name)}` +
          (State.expandedNodes.has(n.id)
            ? ` <span style="color:var(--signal);font-size:9px">✓</span>`
            : "") +
          `</span>` +
          `<span class="ns-weight">${n._totalCollabs || n.totalWeight || 0} collab${(n._totalCollabs || n.totalWeight) === 1 ? "" : "s"}</span>` +
          `</div>`,
      )
      .join("") || `<div class="ns-empty">No nodes match</div>`;

  if (q && results.length) {
    highlightPath(
      results.map((n) => n.id),
      { dim: false },
    );
  } else {
    restoreDefaultColors();
  }

  _nsActiveIndex = -1;
  els.nodeSearchInput.setAttribute("aria-activedescendant", "");
  if (els.nodeSearchStatus)
    els.nodeSearchStatus.textContent = results.length
      ? `${results.length} artist${results.length === 1 ? "" : "s"} found`
      : "No nodes match";

  els.nodeSearchResults.querySelectorAll(".ns-item").forEach((item) => {
    item.addEventListener("click", () => _nsSelect(item));
  });
}

export function updateNodeSearchResults(query) {
  renderNodeSearchResults(query);
}

export function setupNodeSearch() {
  const onInput = debounce((e) => renderNodeSearchResults(e.target.value), 120);
  els.nodeSearchInput.addEventListener("input", onInput);
  els.nodeSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeNodeSearch();
      return;
    }
    const items = _nsItems();
    if (!items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      _nsSetActive(Math.min(_nsActiveIndex + 1, items.length - 1), items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      _nsSetActive(Math.max(_nsActiveIndex - 1, 0), items);
    } else if (e.key === "Enter" && _nsActiveIndex >= 0) {
      e.preventDefault();
      _nsSelect(items[_nsActiveIndex]);
    }
  });
}
