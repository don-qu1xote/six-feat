let _root = null;
export function overlayRoot() {
  if (_root && document.body?.contains(_root)) return _root;
  _root = document.getElementById("overlay-root");
  if (!_root) {
    _root = document.createElement("div");
    _root.id = "overlay-root";
    document.body.appendChild(_root);
  }
  return _root;
}

export function _resetOverlayRoot() {
  _root = null;
}

const _origin = new WeakMap();

export function portalToOverlayRoot(el) {
  const root = overlayRoot();
  if (!el || el.parentElement === root) return;
  if (!_origin.has(el) && el.parentElement) {
    _origin.set(el, { parent: el.parentElement, next: el.nextSibling });
  }
  root.appendChild(el);
}

export function restoreFromOverlayRoot(el) {
  const o = el && _origin.get(el);
  if (!o || !o.parent) return;
  const before = o.next && o.parent.contains(o.next) ? o.next : null;
  o.parent.insertBefore(el, before);
  _origin.delete(el);
}

const EDGE_MARGIN = 8;

export function positionAnchored(el, anchor, { gap = 8 } = {}) {
  if (!el || !anchor) return;
  const r = anchor.getBoundingClientRect();
  el.style.position = "fixed";
  el.style.top = `${r.bottom + gap}px`;
  el.style.left = `${r.left}px`;
  el.style.right = "auto";
  el.style.minWidth = `${r.width}px`;

  const actualWidth = el.getBoundingClientRect().width;
  const overflowRight = r.left + actualWidth - (window.innerWidth - EDGE_MARGIN);
  if (overflowRight > 0) {
    el.style.left = `${Math.max(EDGE_MARGIN, r.left - overflowRight)}px`;
  }
}

const _anchors = new WeakMap();
export function anchorDropdown(el, anchor) {
  if (el && anchor) _anchors.set(el, anchor);
}

const COMPACT_ANCHOR_SELECTOR = ".search-modal.docked, .path-panel";

export function openDropdown(el) {
  if (!el) return;
  const anchor = _anchors.get(el);
  if (anchor) {
    const compact =
      typeof anchor.closest === "function" && !!anchor.closest(COMPACT_ANCHOR_SELECTOR);
    el.classList.toggle("ac-dropdown--compact", compact);
    portalToOverlayRoot(el);
    positionAnchored(el, anchor);
  }
  el.classList.add("open");
}

export function closeDropdown(el) {
  if (!el) return;
  el.classList.remove("open");
  restoreFromOverlayRoot(el);
}

export function closeAllDropdowns() {
  if (!_root || !document.body?.contains(_root)) return;
  Array.from(_root.children).forEach((el) => closeDropdown(el));
}
