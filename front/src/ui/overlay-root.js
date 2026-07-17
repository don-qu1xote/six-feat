// ════════════════════════════════════════════════════════════════════════════
// ui/overlay-root.js — [SF-WEB-41] Единая портальная точка монтирования для
//                      плавающих/выпадающих слоёв (дропдауны автокомплита,
//                      тултипы, любой anchored-слой).
//
// Раньше каждый дропдаун жил ВНУТРИ своего контейнера (position:absolute от
// .search-wrap/.path-input-wrap). Как только контейнер — компактная докнутая
// карточка с overflow:hidden или собственным stacking-context — дропдаун
// либо обрезался краем карточки, либо зажимался её z-index'ом и налезал на
// соседние слои. Это не отдельные баги, а следствие того, что всплывающий
// слой рендерился не там, где он логически живёт (над всем интерфейсом).
//
// Решение: один #overlay-root в конце <body> (см. index.html) — фиксированный
// вьюпорт-оверлей на полосе --z-dropdown. Всплывающий элемент переносится
// (portalToOverlayRoot) в этот корень и позиционируется от своего якоря
// (positionAnchored, fixed-координаты от getBoundingClientRect якоря), а при
// закрытии возвращается ровно на исходное место в DOM. Обрезание и наложение
// как класс исчезают: в overlay-root нет overflow-предков и нет чужих
// stacking-context'ов между слоем и вершиной страницы.
// ════════════════════════════════════════════════════════════════════════════

// Ленивая ссылка на #overlay-root. Элемент объявлен статически в index.html,
// но в юнит-тестах (jsdom) и в теории при позднем монтировании его может не
// быть — тогда создаём его сами, один раз, в конце <body>.
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

// Тестовый хук: сбросить закешированную ссылку, чтобы следующий overlayRoot()
// перечитал из документа (jsdom пересоздаёт body между файлами тестов).
export function _resetOverlayRoot() { _root = null; }

// Где элемент жил до переноса — чтобы вернуть его на то же место, а не просто
// «куда-нибудь в родителя». WeakMap: снятый со страницы узел не течёт.
const _origin = new WeakMap();

// Переносит el в overlay-root, запоминая исходную позицию (родитель + сосед
// справа). Идемпотентно: повторный вызов для уже перенесённого узла — no-op.
export function portalToOverlayRoot(el) {
  const root = overlayRoot();
  if (!el || el.parentElement === root) return;
  if (!_origin.has(el) && el.parentElement) {
    _origin.set(el, { parent: el.parentElement, next: el.nextSibling });
  }
  root.appendChild(el);
}

// Возвращает el туда, откуда его забрал portalToOverlayRoot. Если исходного
// соседа в родителе уже нет (DOM перерисовался) — просто append в родителя.
export function restoreFromOverlayRoot(el) {
  const o = el && _origin.get(el);
  if (!o || !o.parent) return;
  const before = o.next && o.parent.contains(o.next) ? o.next : null;
  o.parent.insertBefore(el, before);
  _origin.delete(el);
}

// Anchored positioning: ставит el фиксированно под якорем. Инлайн-стили
// перекрывают контейнер-относительные правила .ac-dropdown (top/left/position),
// которые в overlay-root уже не к чему привязывать.
export function positionAnchored(el, anchor, { gap = 8 } = {}) {
  if (!el || !anchor) return;
  const r = anchor.getBoundingClientRect();
  el.style.position = "fixed";
  el.style.top = `${r.bottom + gap}px`;
  el.style.left = `${r.left}px`;
  el.style.right = "auto";
  el.style.minWidth = `${r.width}px`;
}

// Якорь дропдауна задаётся один раз при привязке автокомплита (там, где есть
// inputEl), а открывать/закрывать дропдаун могут разные места, у которых
// inputEl под рукой нет (см. createGeniusAc). Храним связь дропдаун→якорь.
const _anchors = new WeakMap();
export function anchorDropdown(el, anchor) {
  if (el && anchor) _anchors.set(el, anchor);
}

// Открыть дропдаун: портал в overlay-root + позиционирование от якоря + класс
// .open. Если якорь не зарегистрирован — деградируем до старого поведения
// (просто показать на месте), не роняя вызов.
export function openDropdown(el) {
  if (!el) return;
  const anchor = _anchors.get(el);
  if (anchor) {
    portalToOverlayRoot(el);
    positionAnchored(el, anchor);
  }
  el.classList.add("open");
}

// Закрыть дропдаун: снять .open и вернуть узел на исходное место в DOM.
export function closeDropdown(el) {
  if (!el) return;
  el.classList.remove("open");
  restoreFromOverlayRoot(el);
}
