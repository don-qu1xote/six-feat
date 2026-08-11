import { overlayRoot } from "./overlay-root.js";

const _panels = [];
let _outsideClickBound = false;

export function registerLayer(panel) {
  _panels.push(panel);

  panel.el?.addEventListener("click", (e) => e.stopPropagation());

  if (!_outsideClickBound) {
    _outsideClickBound = true;
    document.addEventListener("click", (e) => {
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

export function closeOtherLayers(except) {
  for (const p of _panels) {
    if (p === except || !p.isOpen()) continue;
    p.close();
  }
}

export function openExclusiveLayer(layer) {
  closeOtherLayers(layer);
  return layer;
}

export const registerDockedPanel = registerLayer;
export const closeOtherDockedPanels = closeOtherLayers;
