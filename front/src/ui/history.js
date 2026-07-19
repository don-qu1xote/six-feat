// ════════════════════════════════════════════════════════════════════════════
// ui/history.js — Search history (localStorage), recent-search chips,
//                 shareable URL query-string sync
// ════════════════════════════════════════════════════════════════════════════
import { State, MAX_HISTORY, GRAPH_DEFAULT_LIMIT } from "../state/state.js";
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


// ════════════════════════════════════════════════════════════════════════════
// SF-WEB-02: shareable URL — encodes the FULL explored state (seed artist,
// role filters, expanded nodes, collab limit), not just the seed name, so a
// shared link reproduces the exact graph the sharer was looking at, not just
// its starting point.
// ════════════════════════════════════════════════════════════════════════════

// Compact id serialization: ids are already the smallest stable identifier
// we have, so a sorted (numeric, not lexicographic) comma-join is enough —
// no need for base36/delta-encoding at the node counts this app deals with.
function encodeIds(ids) {
  return [...ids].map(Number).filter(Number.isFinite).sort((a, b) => a - b).join(",");
}
function decodeIds(raw) {
  if (!raw) return new Set();
  return new Set(raw.split(",").map(s => parseInt(s.trim(), 10)).filter(Number.isFinite));
}

// Pure state → URLSearchParams. Exported so the round-trip can be unit
// tested without touching window.location/history.
export function serializeGraphState({ artist, seedId, roles, expandedIds, limit } = {}) {
  const params = new URLSearchParams();
  if (artist) params.set("artist", artist);
  if (roles && roles.size) params.set("roles", [...roles].sort().join(","));
  if (seedId != null) params.set("seed", String(seedId));
  if (expandedIds && expandedIds.size) params.set("exp", encodeIds(expandedIds));
  if (limit && limit > 0 && limit !== GRAPH_DEFAULT_LIMIT) params.set("limit", String(limit));
  return params;
}

// Pure URLSearchParams-like input → plain state object. Never throws —
// anything missing/unparsable quietly falls back to the "no state" default
// (null artist/seed/limit, empty roles/expandedIds), same as a fresh visit.
export function parseGraphState(search) {
  const params = new URLSearchParams(search || "");
  const artist = params.get("artist") || null;

  const rolesRaw = params.get("roles");
  const roles = rolesRaw ? new Set(rolesRaw.split(",").map(r => r.trim()).filter(Boolean)) : new Set();

  const seedRaw = params.get("seed");
  const seedId  = seedRaw != null && /^\d+$/.test(seedRaw) ? Number(seedRaw) : null;

  const expandedIds = decodeIds(params.get("exp"));

  const limitRaw = params.get("limit");
  const limit = limitRaw != null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : null;

  return { artist, roles, seedId, expandedIds, limit };
}

export function updateShareableUrl(artistName) {
  const name = artistName || State.graphNodes.find(n => n.id === State.currentSeedId)?.name;
  if (!name) return;
  const url = new URL(window.location.href);
  url.search = serializeGraphState({
    artist:      name,
    seedId:      State.currentSeedId,
    roles:       State.activeFilters,
    expandedIds: State.expandedNodes,
    limit:       State.collabLimit || State.songLimit,
  }).toString();
  history.replaceState(null, "", url.toString());
}

export function loadArtistFromUrl() {
  const { artist, roles, expandedIds, limit } = parseGraphState(window.location.search);

  if (roles.size) {
    State.activeFilters = roles;
    // [SF-WEB-61] Was still referencing els.filterFeatured/-Producer/-Writer
    // — the rail's OLD role-filter buttons, removed back in SF-WEB-14 (see
    // canvas-controls.js's own comment on this). Those keys don't exist in
    // dom.js at all anymore, so this loop silently synced nothing for the
    // buttons that are actually visible post-load — the always-visible
    // .role-filter-segment (canvasFilter*) — leaving them stuck on their
    // hardcoded-in-HTML "active" default regardless of the roles a shared
    // URL actually restored.
    [els.canvasFilterFeatured, els.canvasFilterProducer, els.canvasFilterWriter,
     els.heroFilterFeatured, els.heroFilterProducer, els.heroFilterWriter].forEach(btn => {
      if (!btn?.dataset.role) return;
      btn.classList.toggle("active", State.activeFilters.has(btn.dataset.role));
    });
  }

  if (!artist) return;
  els.heroInput.value = artist;
  searchArtist(artist, false, true, limit);

  if (expandedIds.size) _restoreExpandedNodes([...expandedIds]);
}

// Re-expands previously-expanded nodes, reusing the exact same expand path a
// user dbl-click drives (searchArtist(name, true, true) → mergeGraph, see
// vis-adapter/events.js). searchArtist()/mergeGraph() aren't awaitable, so we
// poll State.inFlight as the "safe to fire the next one" signal — same
// pattern State.pendingExpand already relies on elsewhere in api.js.
function _restoreExpandedNodes(ids, attempt = 0) {
  if (!ids.length) return;
  if (attempt > 200) return; // ~10s ceiling — give up quietly, not an error.
  if (State.inFlight || State.pendingExpand) {
    setTimeout(() => _restoreExpandedNodes(ids, attempt + 1), 50);
    return;
  }
  const [id, ...rest] = ids;
  const node = State.graphNodes.find(n => n.id === id);
  if (node && !State.expandedNodes.has(id)) {
    searchArtist(node.name, true, true);
  }
  if (rest.length) setTimeout(() => _restoreExpandedNodes(rest, 0), 50);
}

export function copyShareableLink() {
  const url = window.location.href;
  navigator.clipboard.writeText(url)
    .then(() => showToast("🔗 Link copied!", 2000, true))
    .catch(() => showToast(`Copy: ${url}`, 5000));
}
