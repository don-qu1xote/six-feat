// ════════════════════════════════════════════════════════════════════════════
// ui/modals.js — Search modal (docked + full-screen), command palette (⌘K,
//                was just a node-search overlay), and path-panel open/close
//                state.
//
// These three overlays mutually close each other when one opens (same
// pattern as the original ui.js), so they're kept together rather than
// split into three files with a tangle of cross-imports.
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { debounce, escapeHtml, placeholderFor } from "../state/helpers.js";
import { els, $ } from "../dom/dom.js";
import { setFocus } from "../vis-adapter/index.js";
import { hideArtistSidebar, showArtistSidebar } from "./sidebar.js";
import { hideCandidatePicker } from "./candidate-picker.js";
// [SF-WEB-21] Command-row actions — the palette replaces the rail's
// search/find-path/copy-link/export/clear buttons plus the standalone
// theme-toggle and status row's help button, so it needs to reach all of
// them. searchArtist/canvas-controls.js/history.js/theme.js already import
// back from this file (isPathPanelOpen et al. / openNodeSearch et al.) —
// this is a deliberate two-way cycle, safe here since every cross-import on
// both sides is only ever used inside a function body, never at module
// top-level.
import { searchArtist } from "../api/api.js";
import { exportGraphPng, clearCanvas, toggleRoleFilter, openHelpOverlay } from "./canvas-controls.js";
import { copyShareableLink } from "./history.js";
import { setTheme } from "./theme.js";

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
  // Как и обычный поиск — закрываем прочие overlay'и перед открытием этого.
  if (isSearchModalOpen()) closeSearchModal();
  closeNodeSearch();
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
  if (isPathPanelOpen()) closePathPanel();
  closeNodeSearch();

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

  // Клик вне докнутой карточки закрывает её — тот же паттерн, что у
  // .path-panel. В обычном (недокнутом, полноэкранном) режиме модалка сама
  // и есть фон, по которому "клик мимо" не имеет смысла — поэтому проверяем
  // именно docked.
  els.searchModal?.addEventListener("click", e => {
    if (els.searchModal.classList.contains("docked")) e.stopPropagation();
  });
  document.addEventListener("click", e => {
    if (!isSearchModalOpen() || !els.searchModal?.classList.contains("docked")) return;
    if (els.searchModal.contains(e.target) || e.target === els.btnSearchOpen || els.btnSearchOpen?.contains(e.target)) return;
    closeSearchModal();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-21] Command palette ("Find on map" + new-seed search + actions,
//             all ⌘K) — extends what used to be a graph-node-only search
//             overlay into the app's one universal entry point.
// ════════════════════════════════════════════════════════════════════════════

// Static command list — one row per secondary action that used to be a
// permanent rail button, the standalone theme-toggle, or the status row's
// help button. Filtered by query (substring on label) exactly like graph-
// node results below, so this is one unified, arrow-navigable list instead
// of a separate "mode" the user has to switch into.
function _commands() {
  return [
    {
      id: "find-path", icon: "icon-shuffle", label: "Find a path between two artists",
      run: () => { isPathPanelOpen() ? closePathPanel() : openPathPanel(); },
    },
    {
      id: "filter-featured", icon: "icon-mic", label: "Toggle featured-role filter",
      active: State.activeFilters.has("featured"), run: () => toggleRoleFilter("featured"),
    },
    {
      id: "filter-producer", icon: "icon-sliders", label: "Toggle producer-role filter",
      active: State.activeFilters.has("producer"), run: () => toggleRoleFilter("producer"),
    },
    {
      id: "filter-writer", icon: "icon-pen", label: "Toggle writer-role filter",
      active: State.activeFilters.has("writer"), run: () => toggleRoleFilter("writer"),
    },
    {
      id: "export-png", icon: "icon-download", label: "Download graph as PNG",
      run: () => exportGraphPng(),
    },
    {
      id: "copy-link", icon: "icon-link", label: "Copy shareable link",
      run: () => copyShareableLink(),
    },
    {
      id: "theme", icon: State.theme === "light" ? "icon-moon" : "icon-sun",
      label: `Switch to ${State.theme === "light" ? "dark" : "light"} theme`,
      run: () => setTheme(State.theme === "light" ? "dark" : "light"),
    },
    {
      id: "help", icon: "icon-info", label: "Keyboard shortcuts",
      run: () => openHelpOverlay(),
    },
    {
      id: "clear", icon: "icon-close", label: "Clear graph",
      run: () => clearCanvas(),
    },
  ];
}

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

// Runs whichever of the three row kinds the user picked — a command, the
// always-present "search this as a new seed" row, or a graph node (the
// overlay's original job, unchanged).
function _paletteSelect(item) {
  const kind = item.dataset.kind;
  closeNodeSearch();
  if (kind === "cmd") {
    _commands().find(c => c.id === item.dataset.cmdId)?.run();
  } else if (kind === "search") {
    const q = item.dataset.query;
    if (q) searchArtist(q, false, true);
  } else {
    const id = item.getAttribute("data-id");
    if (!State.network) return;
    State.network.focus(id, { scale: 1.5, animation: { duration: 600, easingFunction: "easeInOutQuad" } });
    setFocus(id);
    showArtistSidebar(id);
  }
}

export function openNodeSearch() {
  if (!State.hasRendered) return;
  if (isPathPanelOpen()) closePathPanel();
  if (isSearchModalOpen()) closeSearchModal();
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

function _cmdRowHtml(cmd, index) {
  return `<div class="ns-item ns-item--cmd" id="ns-item-${index}" data-kind="cmd" data-cmd-id="${cmd.id}" role="option" aria-selected="false">` +
    `<span class="ns-cmd-label"><svg class="ri" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><use href="#${cmd.icon}"/></svg>${escapeHtml(cmd.label)}</span>` +
    `<span class="ns-weight">${cmd.active ? "✓" : ""}</span>` +
    `</div>`;
}

function _searchRowHtml(query, index) {
  return `<div class="ns-item ns-item--cmd" id="ns-item-${index}" data-kind="search" data-query="${escapeHtml(query)}" role="option" aria-selected="false">` +
    `<span class="ns-cmd-label"><svg class="ri" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><use href="#icon-search"/></svg>Search artist: "${escapeHtml(query)}"</span>` +
    `<span class="ns-weight"></span>` +
    `</div>`;
}

function _nodeRowHtml(n, index) {
  return `<div class="ns-item" id="ns-item-${index}" data-kind="node" data-id="${n.id}" role="option" aria-selected="false">` +
    `<span class="ns-name">${escapeHtml(n.name)}` +
    (State.expandedNodes.has(n.id) ? ` <span style="color:var(--signal);font-size:9px">✓</span>` : "") +
    `</span>` +
    `<span class="ns-weight">${n._totalCollabs || n.totalWeight || 0} collab${(n._totalCollabs || n.totalWeight) === 1 ? "" : "s"}</span>` +
    `</div>`;
}

export function renderNodeSearchResults(query) {
  // Trimmed-but-original-case text for the "search as new seed" row (both
  // its label and the eventual searchArtist() call) — only the match
  // itself (commands/nodes) is case-insensitive.
  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  const seedId = State.currentSeedId;  // FIX #1: Exclude seed from results

  const commands = _commands().filter(c => !q || c.label.toLowerCase().includes(q));

  const nodes = (q
    ? State.graphNodes.filter(n => n.id !== seedId && n.name.toLowerCase().includes(q))
    : State.graphNodes.filter(n => n.id !== seedId)
  ).slice(0, 12);

  let i = 0;
  const rows = [
    ...commands.map(c => _cmdRowHtml(c, i++)),
    // Always offered when there's a query — the palette's universal
    // "new seed" entry, same effect the old docked search-open rail
    // button eventually led to.
    ...(trimmed ? [_searchRowHtml(trimmed, i++)] : []),
    ...nodes.map(n => _nodeRowHtml(n, i++)),
  ];

  els.nodeSearchResults.innerHTML = rows.join("") || `<div class="ns-empty">No matches</div>`;

  _nsActiveIndex = -1;
  els.nodeSearchInput.setAttribute("aria-activedescendant", "");
  if (els.nodeSearchStatus) {
    const total = commands.length + nodes.length + (q ? 1 : 0);
    els.nodeSearchStatus.textContent = total
      ? `${total} result${total === 1 ? "" : "s"} found`
      : "No matches";
  }

  els.nodeSearchResults.querySelectorAll(".ns-item").forEach(item => {
    item.addEventListener("click", () => _paletteSelect(item));
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
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      _nsSetActive(Math.min(_nsActiveIndex + 1, items.length - 1), items);
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      _nsSetActive(Math.max(_nsActiveIndex - 1, 0), items);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (_nsActiveIndex >= 0 && items[_nsActiveIndex]) {
        _paletteSelect(items[_nsActiveIndex]);
      } else {
        // No row explicitly highlighted — bare Enter still submits the
        // typed name as a new-seed search, same muscle memory as the hero
        // form's own Enter-to-submit.
        const q = els.nodeSearchInput.value.trim();
        if (q) { closeNodeSearch(); searchArtist(q, false, true); }
      }
    }
  });
  // Раньше .node-search-overlay был полноэкранным тёмным фоном — клик по
  // фону (target === overlay) закрывал панель. Теперь это компактная
  // докнутая карточка (тот же материал/расположение, что у .path-panel),
  // фона для клика больше нет — закрываем по клику ВНЕ карточки, как и
  // path-panel/докнутый search-modal.
  els.nodeSearchOverlay.addEventListener("click", e => e.stopPropagation());
  document.addEventListener("click", e => {
    if (!els.nodeSearchOverlay.classList.contains("show")) return;
    if (els.nodeSearchOverlay.contains(e.target)) return;
    closeNodeSearch();
  });
}
