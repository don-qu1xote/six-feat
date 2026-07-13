// ════════════════════════════════════════════════════════════════════════════
// ui/modals.js — Search modal (docked + full-screen), node-search overlay,
//                and path-panel open/close state.
//
// These three overlays mutually close each other when one opens (same
// pattern as the original ui.js), so they're kept together rather than
// split into three files with a tangle of cross-imports.
//
// [SF-WEB-24] The three overlays' shared "docked panel" shell mechanics —
// mutual exclusivity, click-outside-to-close, stopping clicks inside a
// panel from closing it — now live once in ui/docked-panel.js instead of
// being independently duplicated (a separate document click-listener
// each, slightly different each time). setupDockedPanels() below
// registers all three; each open()/close() keeps its own content-specific
// logic (what shows, what gets focused, body view-state) exactly as
// before, just calling closeOtherDockedPanels() instead of naming the
// other two's close functions by hand.
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { debounce, escapeHtml, placeholderFor } from "../state/helpers.js";
import { els, $ } from "../dom/dom.js";
import { setFocus } from "../vis-adapter/index.js";
import { hideArtistSidebar, showArtistSidebar } from "./sidebar.js";
import { hideCandidatePicker } from "./candidate-picker.js";
import { registerDockedPanel, closeOtherDockedPanels } from "./docked-panel.js";

let _searchModalPanel = null;
let _nodeSearchPanel  = null;
let _pathPanel        = null;

// [SF-WEB-24] Registers all three docked-panel surfaces at once — path-
// panel's own trigger-button/close-button/autocomplete/form wiring stays
// in ui/path-panel.js::setupPathPanel, but isPathPanelOpen/openPathPanel/
// closePathPanel (the open/close state itself) already lived here, so its
// docked-panel registration does too, alongside the other two.
export function setupDockedPanels() {
  _searchModalPanel = registerDockedPanel({
    el: els.searchModal,
    trigger: els.btnSearchOpen,
    // Only the docked variant behaves like the other two "docked panels" —
    // the full-screen (non-docked) search modal has no outside-click-to-
    // close concept (there's no "outside" — it IS the whole background).
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

// ════════════════════════════════════════════════════════════════════════════
// Path panel open/close
// ════════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────────
// Баг: окно поиска пути жило по своей собственной логике (toggle класса
// "show" напрямую в обработчике клика) вместо переиспользования того же
// паттерна open/close, что уже есть у обычного поиска (openSearchModal/
// closeSearchModal) и у node-search (openNodeSearch/closeNodeSearch):
// фокус в первое поле при открытии, закрытие остальных overlay'ев при
// открытии этого, закрытие по клику вне панели. Приводим к тому же
// единообразному поведению.
// ────────────────────────────────────────────────────────────────────────────
export function isPathPanelOpen() {
  return !!els.pathPanel?.classList.contains("show");
}

export function openPathPanel() {
  if (!els.pathPanel) return;
  // [SF-WEB-24] Closes the other two docked panels (search-modal/node-
  // search) — was two explicit calls, now the shared registry.
  closeOtherDockedPanels(_pathPanel);
  hideCandidatePicker();
  // [SF-WEB-12] The companion panel shows exactly one context at a time —
  // opening the path section replaces whatever node/edge context was shown.
  hideArtistSidebar();
  els.pathPanel.classList.add("show");
  els.companionPanel?.classList.add("show");
  els.pathFromInput?.focus();
}

export function closePathPanel() {
  els.pathPanel?.classList.remove("show");
  els.companionPanel?.classList.remove("show");
}

// ════════════════════════════════════════════════════════════════════════════
// Search modal & candidate picker modal
// ════════════════════════════════════════════════════════════════════════════

let isSearchModalOpen_flag = false;

export function isSearchModalOpen() {
  return isSearchModalOpen_flag;
}

export function openSearchModal(opts = {}) {
  const modal = els.searchModal;
  if (!modal) return;
  const docked = !!opts.docked;

  isSearchModalOpen_flag = true;
  modal.classList.remove("is-closed");
  modal.classList.toggle("docked", docked);
  // [SF-WEB-24] Closes the other two docked panels (node-search/path-
  // panel) — was two explicit calls, now the shared registry. Runs
  // unconditionally (docked or not), matching the previous behaviour.
  closeOtherDockedPanels(_searchModalPanel);

  // ТЗ (bento-редизайн, "поиск на странице графа как find-path"): раньше
  // кнопка "Search artist" на рейле открывала ТУ ЖЕ полноэкранную домашнюю
  // модалку (затемнение канвы, скрытие rail/status, view-home) — по сути
  // "выйди обратно на главную", хотя по смыслу это быстрый поиск ПОВЕРХ уже
  // нарисованного графа, как find-path. docked=true превращает тот же
  // #search-modal в компактную докнутую карточку (см. .search-modal.docked
  // в CSS — тот же материал/расположение, что у .path-panel), без
  // полноэкранного scrim/blur и без скрытия rail/status/context-panel.
  if (docked) {
    hideArtistSidebar();
    if (els.heroInput) els.heroInput.focus();
    return;
  }

  // Баг: .is-first-visit (transparent, no blur/darken) стоит в статичной
  // разметке и раньше никогда не снимался — из-за этого усиленное
  // затемнение/блюр фона (см. .search-modal CSS) не срабатывало вообще,
  // модалка всегда открывалась "прозрачной" версией, даже поверх уже
  // нарисованного графа. Снимаем класс, как только на канвасе есть граф —
  // .is-first-visit должен работать только при самом первом, пустом экране.
  if (State.hasRendered) modal.classList.remove("is-first-visit");
  // Баг: blur всё ещё не был виден визуально даже после снятия
  // is-first-visit — backdrop-filter на .search-modal не подхватывает
  // содержимое <canvas> (vis.js) на части браузеров/GPU из-за того, как
  // canvas компонуется в отдельный слой. Дублируем эффект прямым
  // filter:blur() на самом #network через класс на общем родителе — это
  // не зависит от backdrop-capture и блюрит канвас надёжно везде.
  if (State.hasRendered) els.appCanvas?.classList.add("search-open");
  // Явное состояние страницы (см. CSS body.view-home) — держим синхронно
  // с search-open: пока полноэкранный search-modal открыт (не docked), мы
  // всегда "на главной", независимо от того, дорисован ли граф под ней.
  document.body.classList.add("view-home");
  document.body.classList.remove("view-graph");
  if (els.heroInput) els.heroInput.focus();
}

export function closeSearchModal() {
  const modal = els.searchModal;
  if (!modal) return;

  isSearchModalOpen_flag = false;
  modal.classList.add("is-closed");
  modal.classList.remove("docked");
  els.appCanvas?.classList.remove("search-open");
  // Граф закрывает модалку только когда он реально есть на канве —
  // до первого построения графа closeSearchModal() не должен случиться.
  if (State.hasRendered) {
    document.body.classList.add("view-graph");
    document.body.classList.remove("view-home");
  }
}

// Synchronous, unconditional close used inside the FLIP/View-Transitions
// `mutate()` callback (see transition.js + vis-adapter/render.js::initGraphOnCanvas).
// Distinct name from closeSearchModal purely for call-site clarity — same
// effect, but this one is always safe to call mid-transition.
export function forceCloseSearchModal() {
  closeSearchModal();
}

export function setupSearchModal() {
  els.btnSearchOpen?.addEventListener("click", () => {
    // Баг: кнопка поиска умела только открывать панель — повторный клик,
    // пока модалка уже открыта, ничего не делал вместо ожидаемого "скрыть".
    if (isSearchModalOpen()) closeSearchModal();
    // С рейла (доступен только когда граф уже нарисован, см. body.view-home
    // в CSS) поиск всегда открывается в docked-режиме — компактной
    // карточкой поверх графа, а не "обратно на главную". Полноэкранная
    // домашняя модалка остаётся только за clearCanvas()/первым визитом.
    else openSearchModal({ docked: true });
  });
  // [SF-WEB-24] Click-outside-to-close (docked mode only — the full-screen
  // mode has no "outside") and click-inside-doesn't-bubble-and-self-close
  // both now come from the shared registration in setupDockedPanels().
}

// ════════════════════════════════════════════════════════════════════════════
// Node search overlay ("Find on map" / ⌘K)
// ════════════════════════════════════════════════════════════════════════════

// Screen-reader/keyboard-only alternative to dragging/clicking nodes on the
// <canvas>: an ARIA combobox+listbox pair, kept in sync via
// aria-activedescendant so arrow keys move a "active" option without moving
// DOM focus off the input (same pattern as attachGeniusAutocomplete's
// dropdown, just roving-index instead of item-focus since here focus needs
// to stay on the input for typing to keep filtering the list).
let _nsActiveIndex = -1;

function _nsItems() {
  return [...els.nodeSearchResults.querySelectorAll(".ns-item")];
}

function _nsSetActive(index, items) {
  items.forEach(item => { item.classList.remove("ns-active"); item.setAttribute("aria-selected", "false"); });
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
  State.network.focus(id, { scale: 1.5, animation: { duration: 600, easingFunction: "easeInOutQuad" } });
  setFocus(id);
  showArtistSidebar(id);
}

export function openNodeSearch() {
  if (!State.hasRendered) return;
  // [SF-WEB-24] Closes the other two docked panels (search-modal/path-
  // panel) — was two explicit calls, now the shared registry.
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
}

export function renderNodeSearchResults(query) {
  const q = query.toLowerCase().trim();
  const seedId = State.currentSeedId;  // FIX #1: Exclude seed from results

  const results = q
    ? State.graphNodes
        .filter(n => n.id !== seedId && n.name.toLowerCase().includes(q))
        .slice(0, 12)
    : State.graphNodes
        .filter(n => n.id !== seedId)
        .slice(0, 12);

  els.nodeSearchResults.innerHTML = results.map((n, i) =>
    `<div class="ns-item" id="ns-item-${i}" data-id="${n.id}" role="option" aria-selected="false">` +
    `<span class="ns-name">${escapeHtml(n.name)}` +
    (State.expandedNodes.has(n.id) ? ` <span style="color:var(--signal);font-size:9px">✓</span>` : "") +
    `</span>` +
    `<span class="ns-weight">${n._totalCollabs || n.totalWeight || 0} collab${(n._totalCollabs || n.totalWeight) === 1 ? "" : "s"}</span>` +
    `</div>`
  ).join("") || `<div class="ns-empty">No nodes match</div>`;

  _nsActiveIndex = -1;
  els.nodeSearchInput.setAttribute("aria-activedescendant", "");
  if (els.nodeSearchStatus)
    els.nodeSearchStatus.textContent = results.length
      ? `${results.length} artist${results.length === 1 ? "" : "s"} found`
      : "No nodes match";

  els.nodeSearchResults.querySelectorAll(".ns-item").forEach(item => {
    item.addEventListener("click", () => _nsSelect(item));
  });
}

// Kept for backward-compat with any callers expecting the old name.
export function updateNodeSearchResults(query) { renderNodeSearchResults(query); }

export function setupNodeSearch() {
  const onInput = debounce(e => renderNodeSearchResults(e.target.value), 120);
  els.nodeSearchInput.addEventListener("input", onInput);
  els.nodeSearchInput.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeNodeSearch(); return; }
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
  // [SF-WEB-24] Click-outside-to-close and click-inside-doesn't-bubble-and-
  // self-close both now come from the shared registration in
  // setupDockedPanels() — this used to be its own document click listener.
}
