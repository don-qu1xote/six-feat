import { State, MAX_HISTORY, GRAPH_DEFAULT_LIMIT } from "../state/state.js";
import { escapeHtml } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { searchArtist } from "../api/api.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/i18n.js";

export function loadHistory() {
  try {
    const raw = localStorage.getItem("feat-atlas-history");
    State.history = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(State.history)) State.history = [];
  } catch {
    State.history = [];
  }
}

export function saveHistory() {
  try {
    localStorage.setItem("feat-atlas-history", JSON.stringify(State.history));
  } catch {}
}

export function pushHistory(name) {
  State.history = [name, ...State.history.filter((h) => h !== name)].slice(0, MAX_HISTORY);
  saveHistory();
  renderChips();
}

const DEFAULT_CHIPS = [
  "Kendrick Lamar",
  "Gorillaz",
  "Rosalía",
  "Calvin Harris",
  "Tyler, the Creator",
];

export function renderChips() {
  if (!els.chips) return;
  const hasHistory = State.history.length > 0;
  const names = hasHistory ? State.history.slice(0, 5) : DEFAULT_CHIPS;

  if (els.chipsLabel)
    els.chipsLabel.textContent = hasHistory ? t("hero.chips.labelRecent") : t("hero.chips.label");

  els.chips.innerHTML = names
    .map(
      (name) =>
        `<button class="chip" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</button>`,
    )
    .join("");
}

window.addEventListener("six-feat-langchange", renderChips);

// [SF-WEB-78] Chips (recent searches or, for a first-time visitor, curated
// examples) used to render permanently under the search bar — on every
// landing, whether or not the user asked to see anything. Now hidden until
// the search field is actually focused, matching how a real search box's
// suggestions behave, and re-hidden once something is picked. blur uses a
// short delay: it fires (moving focus off the input) before the chip's own
// click handler runs, so hiding immediately would remove the chip before
// its click could register.
let _chipsHideTimer = null;

function showChips() {
  clearTimeout(_chipsHideTimer);
  if (els.chipsLabel) els.chipsLabel.hidden = false;
  if (els.chips) els.chips.hidden = false;
}

function hideChips() {
  if (els.chipsLabel) els.chipsLabel.hidden = true;
  if (els.chips) els.chips.hidden = true;
}

// [SF-WEB-93] Реальные недавние запросы показываем сразу при загрузке —
// скрытие-до-фокуса ниже остаётся для дефолтных примеров первого визита.
export function showChipsIfHistory() {
  if (State.history.length > 0) showChips();
}

export function setupChipsVisibility() {
  if (!els.heroInput) return;
  els.heroInput.addEventListener("focus", showChips);
  // [SF-WEB-89] A non-empty query hides chips — the floating results dropdown would cover them otherwise.
  els.heroInput.addEventListener("input", () => {
    if (els.heroInput.value.trim()) hideChips();
    else showChips();
  });
  els.heroInput.addEventListener("blur", () => {
    _chipsHideTimer = setTimeout(hideChips, 150);
  });
  if (els.chips) {
    els.chips.addEventListener("click", () => {
      clearTimeout(_chipsHideTimer);
      hideChips();
    });
  }
}

function encodeIds(ids) {
  return [...ids]
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .join(",");
}
function decodeIds(raw) {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter(Number.isFinite),
  );
}

export function serializeGraphState({ artist, seedId, roles, expandedIds, limit } = {}) {
  const params = new URLSearchParams();
  if (artist) params.set("artist", artist);
  if (roles && roles.size) params.set("roles", [...roles].sort().join(","));
  if (seedId != null) params.set("seed", String(seedId));
  if (expandedIds && expandedIds.size) params.set("exp", encodeIds(expandedIds));
  if (limit && limit > 0 && limit !== GRAPH_DEFAULT_LIMIT) params.set("limit", String(limit));
  return params;
}

export function parseGraphState(search) {
  const params = new URLSearchParams(search || "");
  const artist = params.get("artist") || null;

  const rolesRaw = params.get("roles");
  const roles = rolesRaw
    ? new Set(
        rolesRaw
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean),
      )
    : new Set();

  const seedRaw = params.get("seed");
  const seedId = seedRaw != null && /^\d+$/.test(seedRaw) ? Number(seedRaw) : null;

  const expandedIds = decodeIds(params.get("exp"));

  const limitRaw = params.get("limit");
  const limit = limitRaw != null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : null;

  return { artist, roles, seedId, expandedIds, limit };
}

export function updateShareableUrl(artistName) {
  const name = artistName || State.graphNodes.find((n) => n.id === State.currentSeedId)?.name;
  if (!name) return;
  const url = new URL(window.location.href);
  url.search = serializeGraphState({
    artist: name,
    seedId: State.currentSeedId,
    roles: State.activeFilters,
    expandedIds: State.expandedNodes,
    limit: State.collabLimit || State.songLimit,
  }).toString();
  history.replaceState(null, "", url.toString());
}

export function loadArtistFromUrl() {
  const { artist, roles, expandedIds, limit } = parseGraphState(window.location.search);

  if (roles.size) {
    State.activeFilters = roles;
    [
      els.canvasFilterFeatured,
      els.canvasFilterProducer,
      els.canvasFilterWriter,
      els.heroFilterFeatured,
      els.heroFilterProducer,
      els.heroFilterWriter,
    ].forEach((btn) => {
      if (!btn?.dataset.role) return;
      btn.classList.toggle("active", State.activeFilters.has(btn.dataset.role));
    });
  }

  if (!artist) return;
  els.heroInput.value = artist;
  searchArtist(artist, false, true, limit);

  if (expandedIds.size) _restoreExpandedNodes([...expandedIds]);
}

function _restoreExpandedNodes(ids, attempt = 0) {
  if (!ids.length) return;
  if (attempt > 200) return;
  if (State.inFlight || State.pendingExpand) {
    setTimeout(() => _restoreExpandedNodes(ids, attempt + 1), 50);
    return;
  }
  const [id, ...rest] = ids;
  const node = State.graphNodes.find((n) => n.id === id);
  if (node && !State.expandedNodes.has(id)) {
    searchArtist(node.name, true, true);
  }
  if (rest.length) setTimeout(() => _restoreExpandedNodes(rest, 0), 50);
}

export function copyShareableLink() {
  const url = window.location.href;
  navigator.clipboard
    .writeText(url)
    .then(() => showToast(t("game.toast.linkCopied"), 2000, true))
    .catch(() => showToast(t("toast.copyFallback", { link: url }), 5000));
}
