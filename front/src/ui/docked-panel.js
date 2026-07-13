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
// ════════════════════════════════════════════════════════════════════════════

const _panels = [];
let _outsideClickBound = false;

// panel: { el, trigger, isOpen(), close() }. Returns the same object so the
// caller can hold onto it and later pass it to closeOtherDockedPanels() as
// the "except" argument (skip closing yourself when you're the one
// opening).
export function registerDockedPanel(panel) {
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

// Closes every OTHER registered docked panel besides `except` — each
// surface's own open() calls this instead of naming the other two's close
// functions directly. Non-docked-panel state (companion sidebar, candidate
// picker) stays each surface's own responsibility to close, same as before.
export function closeOtherDockedPanels(except) {
  for (const p of _panels) {
    if (p === except || !p.isOpen()) continue;
    p.close();
  }
}
