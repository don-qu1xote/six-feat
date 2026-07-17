// ════════════════════════════════════════════════════════════════════════════
// ui/docked-panel.js — [SF-WEB-24] Shared shell mechanics for the graph
//                      view's three independent "docked panel" search
//                      surfaces (docked search-modal, node-search overlay,
//                      find-path panel): mutual exclusivity (opening one
//                      closes the other registered ones), a single
//                      document-level click-outside-to-close listener
//                      (not three, one per surface), and stopping clicks
//                      inside a panel from bubbling into that listener.
//
// Each surface keeps its own open()/close() and everything about what it's
// FOR (content, autocompletes, form submission) in its own module — this
// file only knows show/hide/exclusivity/outside-click, the part that used
// to be independently duplicated three times. Deliberately not a generic
// "modal manager" merging the three into one entry point/tabs — that was
// considered and rejected (see SF-WEB-24's ticket); they stay three
// distinct surfaces for three distinct jobs, just sharing one shell.
//
// [SF-WEB-41] Расширено до общего слой-менеджера. Тот же реестр и тот же
// единственный document-listener теперь обслуживают ЛЮБОЙ эксклюзивный слой,
// а не только три докнутые карточки: registerLayer/closeOtherLayers/
// openExclusiveLayer — обобщённые имена, docked-варианты оставлены алиасами
// для существующих вызовов (modals.js/path-panel.js), чтобы не заводить
// второй параллельный механизм. Правило «одновременно открыт один
// эксклюзивный слой» живёт здесь в одном месте.
// ════════════════════════════════════════════════════════════════════════════
import { overlayRoot } from "./overlay-root.js";

const _panels = [];
let _outsideClickBound = false;

// panel: { el, trigger, isOpen(), close() }. Returns the same object so the
// caller can hold onto it and later pass it to closeOtherDockedPanels() as
// the "except" argument (skip closing yourself when you're the one
// opening).
export function registerLayer(panel) {
  _panels.push(panel);

  // Раньше .node-search-overlay/.path-panel/.search-modal.docked были
  // полноэкранными тёмными фонами — клик по фону (target === overlay)
  // закрывал панель. Теперь это компактные докнутые карточки, фона для
  // клика больше нет — закрываем по клику ВНЕ карточки (see the shared
  // document listener below), so a click INSIDE the card must not bubble
  // there and immediately close it again.
  panel.el?.addEventListener("click", e => e.stopPropagation());

  // Bound once for the whole app, not once per registered panel — walks
  // every registered panel on each click instead of each surface running
  // its own independent document-level listener.
  if (!_outsideClickBound) {
    _outsideClickBound = true;
    document.addEventListener("click", e => {
      // [SF-WEB-41] Плавающие слои слоя-владельца (дропдаун автокомплита)
      // теперь рендерятся в #overlay-root — физически ВНЕ p.el. Клик по такому
      // слою логически принадлежит своей панели, поэтому не считаем его
      // «кликом снаружи»: иначе выбор подсказки в докнутом поиске/пути тут же
      // закрывал бы саму панель.
      if (overlayRoot().contains(e.target)) return;
      for (const p of _panels) {
        if (!p.isOpen()) continue;
        if (p.el?.contains(e.target)) continue;
        if (p.trigger && (e.target === p.trigger || p.trigger.contains(e.target))) continue;
        p.close();
      }
    });
  }

  return panel;
}

// Closes every OTHER registered layer besides `except` — each surface's own
// open() calls this instead of naming the other two's close functions
// directly. Non-layer state (companion sidebar, candidate picker) stays each
// surface's own responsibility to close, same as before.
export function closeOtherLayers(except) {
  for (const p of _panels) {
    if (p === except || !p.isOpen()) continue;
    p.close();
  }
}

// [SF-WEB-41] Открыть слой эксклюзивно: закрыть все прочие открытые слои и
// вернуть сам слой (его собственный open()/show живёт в модуле-владельце —
// сюда вынесена только часть «одновременно открыт один», общая для всех).
export function openExclusiveLayer(layer) {
  closeOtherLayers(layer);
  return layer;
}

// ─ Обратная совместимость с SF-WEB-24: докнутые панели — частный случай
//   слоёв. Существующие вызовы (modals.js/path-panel.js) продолжают работать
//   через те же имена, указывая на общий механизм. ─
export const registerDockedPanel = registerLayer;
export const closeOtherDockedPanels = closeOtherLayers;
