// ════════════════════════════════════════════════════════════════════════════
// ui/canvas-states.js — [SF-WEB-19] Единый набор состояний empty/loading/
// error на ките .ui-panel/.ui-btn (SF-WEB-11), вместо разнородных inline-
// вёрсток (ad-hoc <span class="spinner"> в path-result.js, голый textContent
// для "No path found" без retry, и т.д.).
//
// Каждая из трёх функций — чистый рендер в переданный container: полностью
// заменяет его содержимое/класс, не хранит собственного состояния и не
// заводит новый механизм показа — action-колбэки (retry / onAction) вызывают
// существующие обработчики (searchArtist/runServerPath/openSearchModal и
// т.п.), просто выбранные вызывающим кодом, а не этим модулем.
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_EMPTY_TITLE = "Map two artists' collaborations";
const DEFAULT_EMPTY_BODY =
  "Search for an artist to explore who they've worked with — or map a path between two artists.";
const DEFAULT_EMPTY_ACTION_LABEL = "Search an artist";
const DEFAULT_LOADING_MESSAGE = "Loading…";

// Only ever touches classes this module itself manages (including the old
// bespoke is-loading/is-error path-result.js used before SF-WEB-19) —
// never wipes container.className outright, so a caller's own base class
// (e.g. "path-result", "ui-state-slot") survives every render call.
const MANAGED_CLASSES = [
  "show", "is-loading", "is-error",
  "ui-state--empty", "ui-state--loading", "ui-state--error"
];

function resetSlot(container, stateClass) {
  container.innerHTML = "";
  container.classList.remove(...MANAGED_CLASSES);
  container.classList.add("ui-state", stateClass, "show");
}

// Pre-search onboarding: shown on an empty canvas, with a single action
// (default: open the search modal) — the caller passes onAction rather than
// this module reaching into ui/modals.js itself, so it stays reusable for
// any "empty" surface, not just the canvas.
export function renderEmptyState(container, { title, body, actionLabel, onAction } = {}) {
  if (!container) return null;
  resetSlot(container, "ui-state--empty");

  const card = document.createElement("div");
  card.className = "ui-panel ui-state-card";

  const heading = document.createElement("div");
  heading.className = "ui-state-title";
  heading.textContent = title ?? DEFAULT_EMPTY_TITLE;
  card.appendChild(heading);

  const body_ = document.createElement("div");
  body_.className = "ui-state-body";
  body_.textContent = body ?? DEFAULT_EMPTY_BODY;
  card.appendChild(body_);

  if (onAction) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ui-btn ui-btn--primary ui-state-action";
    btn.textContent = actionLabel ?? DEFAULT_EMPTY_ACTION_LABEL;
    btn.addEventListener("click", onAction);
    card.appendChild(btn);
  }

  container.appendChild(card);
  return card;
}

// Same .spinner markup ui/loading.js's canvas-wide overlay uses — one
// visual "loading" language everywhere instead of each surface hand-rolling
// its own spinner span.
export function renderLoadingState(container, message) {
  if (!container) return null;
  resetSlot(container, "ui-state--loading");

  const row = document.createElement("div");
  row.className = "ui-state-loading-row";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  row.appendChild(spinner);
  row.appendChild(document.createTextNode(" " + (message ?? DEFAULT_LOADING_MESSAGE)));

  container.appendChild(row);
  return row;
}

// Unified error card: message + an optional Retry button (omitted when the
// error isn't actionable, e.g. an ambiguous-name hint that would just fail
// again identically) — same retry contract as ui/toast.js's showRetryToast
// (call the given function, no built-in in-flight/abort handling of its
// own; the caller's retry function already goes through that).
export function renderErrorState(container, message, retry) {
  if (!container) return null;
  resetSlot(container, "ui-state--error");

  const card = document.createElement("div");
  card.className = "ui-panel ui-state-card ui-state-card--error";

  const body_ = document.createElement("div");
  body_.className = "ui-state-body";
  body_.textContent = message;
  card.appendChild(body_);

  if (retry) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ui-btn ui-state-action";
    btn.textContent = "Retry";
    btn.addEventListener("click", retry);
    card.appendChild(btn);
  }

  container.appendChild(card);
  return card;
}

export function clearCanvasState(container) {
  if (!container) return;
  container.innerHTML = "";
  container.classList.remove("ui-state", ...MANAGED_CLASSES);
}
