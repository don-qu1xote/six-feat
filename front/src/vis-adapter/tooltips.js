import { State, ROLE_ICON } from "../state/state.js";
import { escapeHtml } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { t, tPlural } from "../i18n/i18n.js";

function wrapRoleIconGraph(roleIconUseString) {
  return `<svg class="role-icon" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">${roleIconUseString}</svg>`;
}

let _tooltipObserverAttached = false;

const _lastAppliedTransform = new WeakMap();

function repositionTooltipIfNeeded(el) {
  if (!el || !el.isConnected) return;
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

  const next =
    shiftX || shiftY ? `translate(${Math.round(shiftX)}px, ${Math.round(shiftY)}px)` : "";
  el.style.transform = next;
  _lastAppliedTransform.set(el, next);
}

export function ensureTooltipCollisionGuard() {
  if (_tooltipObserverAttached) return;
  if (!els.network) return;
  _tooltipObserverAttached = true;

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.classList?.contains("vis-tooltip")) {
          requestAnimationFrame(() => repositionTooltipIfNeeded(node));
        }
      });
      const target = m.target;
      if (target.nodeType !== 1 || !target.classList?.contains("vis-tooltip")) continue;

      if (m.type === "attributes" && m.attributeName === "style") {
        const applied = _lastAppliedTransform.get(target);
        if (applied !== undefined && target.style.transform === applied) continue;
      }

      requestAnimationFrame(() => repositionTooltipIfNeeded(target));
    }
  });

  observer.observe(els.network, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
}

export function buildNodeTooltip(node) {
  const el = document.createElement("div");
  el.className = "tt";
  const seedBadge = node.isSeed ? ` <span class="tt-seed">focus</span>` : "";
  const isExpanded = State.expandedNodes.has(node.id)
    ? `<div class="tt-meta" style="color:var(--signal)">${t("tooltip.expanded")}</div>`
    : "";
  const inGame = State.game?.mode === true;
  const hint = inGame ? t("tooltip.hintGame") : t("tooltip.hint");
  el.innerHTML =
    `<div class="tt-name">${escapeHtml(node.name)}${seedBadge}</div>` +
    (node.totalWeight
      ? `<div class="tt-meta">${tPlural("sidebar.collabCount", node.totalWeight)}</div>`
      : "") +
    (inGame ? "" : isExpanded) +
    `<div class="tt-hint">${hint}</div>`;
  return el;
}

export function buildEdgeTooltip(e, nameById) {
  const fromName = nameById[e.from] || "?";
  const toName = nameById[e.to] || "?";
  const weight = Number(e.weight) > 0 ? Number(e.weight) : 1;
  const role = e.dominantRole || "primary";
  const icon = wrapRoleIconGraph(ROLE_ICON[role] || "");
  // [SF-API-23] Подсказка при наведении показывает сводку, а не список треков.
  // Списка у ребра больше нет: он приезжает по клику, из /api/v1/graph/edge.
  // Тянуть его на каждое наведение — ровно то, от чего уходили, только хуже:
  // наводят на десятки рёбер, раскрывают одно.
  //
  // Треки на рёбрах ПУТИ остаются в ответе поиска (их там смотрят всегда),
  // поэтому если они есть — показываем их, как показывали.
  const songs = Array.isArray(e.songs) ? e.songs : [];

  let rows = "";
  for (const s of songs) {
    const title = typeof s === "string" ? s : s.song || s.title || "";
    rows +=
      `<li class="tt-row"><span class="tt-song">${escapeHtml(title || t("tooltip.untitled"))}</span>` +
      `<span class="tt-roles"></span></li>`;
  }
  if (!rows) {
    const count = Number(e.collaboration_count) > 0 ? Number(e.collaboration_count) : weight;
    rows = `<li class="tt-row"><span class="tt-song">${escapeHtml(tPlural("tooltip.sharedTracks", count))}</span><span class="tt-roles"></span></li>`;
  }

  const el = document.createElement("div");
  el.className = "tt";
  el.innerHTML =
    `<div class="tt-head"><span class="tt-name">${escapeHtml(fromName)}</span>` +
    `<span class="tt-x"> × </span><span class="tt-name">${escapeHtml(toName)}</span></div>` +
    `<div class="tt-meta">${tPlural("tooltip.sharedTracks", weight)} ` +
    `<span class="tt-role-badge tt-role-badge--${escapeHtml(role)}" title="${escapeHtml(role)}">${icon}</span></div>` +
    `<ul class="tt-list">${rows}</ul>` +
    `<div class="tt-hint">${t("tooltip.edgeHint")}</div>`;
  return el;
}
