const DEFAULT_EMPTY_TITLE = "Map two artists' collaborations";
const DEFAULT_EMPTY_BODY =
  "Search for an artist to explore who they've worked with — or map a path between two artists.";
const DEFAULT_EMPTY_ACTION_LABEL = "Search an artist";
const DEFAULT_LOADING_MESSAGE = "Loading…";

const MANAGED_CLASSES = [
  "show",
  "is-loading",
  "is-error",
  "ui-state--empty",
  "ui-state--loading",
  "ui-state--error",
];

function resetSlot(container, stateClass) {
  container.innerHTML = "";
  container.classList.remove(...MANAGED_CLASSES);
  container.classList.add("ui-state", stateClass, "show");
}

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
