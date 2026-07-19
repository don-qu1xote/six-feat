// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/tooltips.js — node/edge tooltip HTML builders, plus the
//                           viewport-collision guard vis.js doesn't provide.
// ════════════════════════════════════════════════════════════════════════════
import { State, ROLE_ICON } from "../state/state.js";
import { escapeHtml } from "../state/helpers.js";
import { els } from "../dom/dom.js";

function wrapRoleIconGraph(roleIconUseString) {
  // For graph tooltips: compact 20×20
  return `<svg class="role-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">${roleIconUseString}</svg>`;
}

// ════════════════════════════════════════════════════════════════════════════
// ТЗ-H: TOOLTIP VIEWPORT COLLISION DETECTION
// ────────────────────────────────────────────────────────────────────────────
// vis.js рендерит .vis-tooltip как обычный DOM-элемент, позиционируемый
// абсолютно относительно курсора, без всякого collision-detection с краями
// viewport. У правого/нижнего края экрана подсказка может частично уйти за
// пределы видимой области. vis.js не даёт хука вроде "showPopup" — единственная
// точка перехвата это появление узла .vis-tooltip в DOM, поэтому используем
// MutationObserver на els.network (контейнер, в который vis.Network монтирует
// canvas и куда же вставляет .vis-tooltip — см. initNetwork в render.js) и,
// как только он появляется, проверяем getBoundingClientRect() и при
// необходимости сдвигаем его обратно в viewport через transform.
// Наблюдение ограничено этим контейнером, а не document.body: приложение
// постоянно меняет style у множества посторонних узлов (hover/physics), и
// слушать весь body означало бы срабатывать намного чаще, чем нужно.
// ════════════════════════════════════════════════════════════════════════════

let _tooltipObserverAttached = false;

// Отслеживаем последний transform, который МЫ сами поставили на элемент.
// Когда наблюдатель видит style-мутацию, сравниваем текущий el.style.transform
// с тем, что мы только что записали сюда — если совпадает, это наша же
// правка и её нужно проигнорировать. Это устойчиво к таймингу (в отличие от
// булева флага, который может быть сброшен до того, как microtask-очередь
// MutationObserver'а успеет его увидеть) — сравнение делается по значению,
// а не по window во времени.
const _lastAppliedTransform = new WeakMap();

function repositionTooltipIfNeeded(el) {
  if (!el || !el.isConnected) return;
  // Сбрасываем предыдущий сдвиг перед измерением, иначе накапливаем ошибку
  // при повторных вызовах (например, если тултип обновляется на месте).
  el.style.transform = "";
  const rect = el.getBoundingClientRect();
  const margin = 8;

  let shiftX = 0;
  let shiftY = 0;

  if (rect.right > window.innerWidth - margin) {
    shiftX = -(rect.right - window.innerWidth + margin);
  }
  if (rect.left + shiftX < margin) {
    shiftX = margin - rect.left;
  }
  if (rect.bottom > window.innerHeight - margin) {
    shiftY = -(rect.bottom - window.innerHeight + margin);
  }
  if (rect.top + shiftY < margin) {
    shiftY = margin - rect.top;
  }

  const next = (shiftX || shiftY) ? `translate(${Math.round(shiftX)}px, ${Math.round(shiftY)}px)` : "";
  el.style.transform = next;
  _lastAppliedTransform.set(el, next);
}

// Устанавливается один раз за время жизни страницы (не привязан к
// конкретному State.network, т.к. .vis-tooltip всегда монтируется заново в
// els.network при каждой пересборке графа, а сам els.network — один и тот же
// DOM-узел на протяжении всей жизни страницы).
export function ensureTooltipCollisionGuard() {
  if (_tooltipObserverAttached) return;
  if (!els.network) return;
  _tooltipObserverAttached = true;

  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.classList?.contains("vis-tooltip")) {
          // Даём браузеру один кадр на layout перед измерением размеров.
          requestAnimationFrame(() => repositionTooltipIfNeeded(node));
        }
      });
      const target = m.target;
      if (target.nodeType !== 1 || !target.classList?.contains("vis-tooltip")) continue;

      // Если это style-мутация и текущий transform совпадает с тем, что мы
      // сами только что записали — это наша же правка, пропускаем её, иначе
      // получаем бесконечный цикл observer → repositionTooltipIfNeeded →
      // style-мутация → observer → ...
      if (m.type === "attributes" && m.attributeName === "style") {
        const applied = _lastAppliedTransform.get(target);
        if (applied !== undefined && target.style.transform === applied) continue;
      }

      // vis.js переиспользует один и тот же .vis-tooltip элемент и просто
      // меняет его innerHTML/style при перемещении курсора между узлами —
      // отслеживаем и такие обновления через childList/attributes на самом узле.
      requestAnimationFrame(() => repositionTooltipIfNeeded(target));
    }
  });

  observer.observe(els.network, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"]
  });
}

// ════════════════════════════════════════════════════════════════════════════
// TOOLTIP BUILDERS
// ════════════════════════════════════════════════════════════════════════════

export function buildNodeTooltip(node) {
  const el = document.createElement("div");
  el.className = "tt";
  const seedBadge  = node.isSeed ? ` <span class="tt-seed">focus</span>` : "";
  const isExpanded = State.expandedNodes.has(node.id)
    ? `<div class="tt-meta" style="color:var(--signal)">expanded ✓</div>` : "";
  // [SF-WEB-59] Централити убрана снова — SF-WEB-58 A её вернула, это была
  // регрессия (не нужна при текущем состоянии графа).
  el.innerHTML =
    `<div class="tt-name">${escapeHtml(node.name)}${seedBadge}</div>` +
    (node.totalWeight ? `<div class="tt-meta">${node.totalWeight} collab${node.totalWeight === 1 ? "" : "s"}</div>` : "") +
    isExpanded +
    `<div class="tt-hint">click → details · dbl-click → expand · ctrl+click → set as seed</div>`;
  return el;
}

export function buildEdgeTooltip(e, nameById) {
  const fromName = nameById[e.from] || "?";
  const toName   = nameById[e.to]   || "?";
  const weight   = Number(e.weight) > 0 ? Number(e.weight) : 1;
  const role     = e.dominantRole || "primary";
  const icon     = wrapRoleIconGraph(ROLE_ICON[role] || "");
  const collabs  = Array.isArray(e.collaborations) ? e.collaborations : [];

  let rows = "";
  for (const c of collabs) {
    const roles = Array.isArray(c.roles) ? c.roles : [];
    const pills = roles.map(r => {
      const slug = String(r).toLowerCase().replace(/[^a-z0-9]/g, "");
      const ico  = wrapRoleIconGraph(ROLE_ICON[slug] || "");
      return `<span class="tt-role tt-role--${slug}" title="${escapeHtml(r)}">${ico}</span>`;
    }).join("");
    rows += `<li class="tt-row"><span class="tt-song">${escapeHtml(c.song || "Untitled")}</span>` +
            `<span class="tt-roles">${pills}</span></li>`;
  }
  if (!rows) rows = `<li class="tt-empty">No track details available.</li>`;

  const el = document.createElement("div");
  el.className = "tt";
  el.innerHTML =
    `<div class="tt-head"><span class="tt-name">${escapeHtml(fromName)}</span>` +
    `<span class="tt-x"> × </span><span class="tt-name">${escapeHtml(toName)}</span></div>` +
    `<div class="tt-meta">${weight} shared track${weight === 1 ? "" : "s"} ` +
    `<span class="tt-role-badge tt-role-badge--${escapeHtml(role)}" title="${escapeHtml(role)}">${icon}</span></div>` +
    `<ul class="tt-list">${rows}</ul>` +
    `<div class="tt-hint">click edge → full detail in panel</div>`;
  return el;
}
