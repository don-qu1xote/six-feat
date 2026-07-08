// ════════════════════════════════════════════════════════════════════════════
// ui/history.js — Search history (localStorage), recent-search chips,
//                 shareable URL query-string sync
// ════════════════════════════════════════════════════════════════════════════
import { State, MAX_HISTORY } from "../state/state.js";
import { escapeHtml } from "../state/helpers.js";
import { els } from "../dom/dom.js";
import { searchArtist } from "../api/api.js";
import { showToast } from "./toast.js";

export function loadHistory() {
  try {
    const raw = localStorage.getItem("feat-atlas-history");
    State.history = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(State.history)) State.history = [];
  } catch { State.history = []; }
}

export function saveHistory() {
  try { localStorage.setItem("feat-atlas-history", JSON.stringify(State.history)); } catch {}
}

export function pushHistory(name) {
  State.history = [name, ...State.history.filter(h => h !== name)].slice(0, MAX_HISTORY);
  saveHistory();
  renderChips();
}

// Баг: статичные примеры (Kendrick Lamar / Gorillaz / Rosalía / Calvin
// Harris / Tyler, the Creator) были захардкожены в разметке и никогда не
// менялись — как только у пользователя появляется история поиска, чипы под
// полем ввода должны показывать её вместо вечно одних и тех же примеров.
// Примеры остаются только как fallback до первого успешного поиска.
const DEFAULT_CHIPS = ["Kendrick Lamar", "Gorillaz", "Rosalía", "Calvin Harris", "Tyler, the Creator"];

export function renderChips() {
  if (!els.chips) return;
  const hasHistory = State.history.length > 0;
  const names = hasHistory ? State.history.slice(0, 5) : DEFAULT_CHIPS;

  if (els.chipsLabel) els.chipsLabel.textContent = hasHistory ? "Recent searches" : "Try one of these";

  els.chips.innerHTML = names.map(name =>
    `<button class="chip" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</button>`
  ).join("");
}


export function updateShareableUrl(artistName) {
  if (!artistName) return;
  const url = new URL(window.location.href);
  url.searchParams.set("artist", artistName);
  url.searchParams.set("roles", [...State.activeFilters].sort().join(","));
  history.replaceState(null, "", url.toString());
}

export function loadArtistFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const artist = params.get("artist");
  const roles  = params.get("roles");
  if (roles) {
    const set = new Set(roles.split(",").map(r => r.trim()).filter(Boolean));
    State.activeFilters = set;
    [els.filterFeatured, els.filterProducer, els.filterWriter,
     els.heroFilterFeatured, els.heroFilterProducer, els.heroFilterWriter].forEach(btn => {
      if (!btn?.dataset.role) return;
      btn.classList.toggle("active", State.activeFilters.has(btn.dataset.role));
    });
  }
  if (artist) {
    els.heroInput.value = artist;
    searchArtist(artist, false, true);
  }
}

export function copyShareableLink() {
  const url = window.location.href;
  navigator.clipboard.writeText(url)
    .then(() => showToast("🔗 Link copied!", 2000, true))
    .catch(() => showToast(`Copy: ${url}`, 5000));
}
