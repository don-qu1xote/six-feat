// ════════════════════════════════════════════════════════════════════════════
// game/game-windows.js — [design: routed game windows] The game's non-play
// surfaces: Leaderboard (#/game/leaderboard), Profile (#/game/profile),
// Challenges (#/game/challenges) and Season (#/game/season). connect.js owns
// the Play surface (#/game) itself; this module owns the four sibling screens
// and the active state of the shared game nav across ALL of them.
//
// Each screen's markup already lives in index.html (its els are registered in
// dom/dom.js); this module only shows/hides the right one on a surface change
// and loads its data from the real game service (game-api.js) when it becomes
// active. Every network call degrades honestly — a null response renders the
// screen's own empty/signed-out state, never a fake row.
//
// Same show/hide mechanism connect.js uses for its own surface: toggle a
// `.show` class (game-screens.css keys `display` off it) and the `hidden`
// attribute together, so the screen is both visually and accessibly gone when
// it isn't the active surface.
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { escapeHtml, initialOf } from "../state/helpers.js";
import { attachGeniusAutocomplete } from "../ui/autocomplete.js";
import { showToast } from "../ui/toast.js";
import {
  onSurfaceChange, getCurrentSurface,
  SURFACE_GAME_LEADERBOARD, SURFACE_GAME_PROFILE,
  SURFACE_GAME_CHALLENGES, SURFACE_GAME_SEASON,
} from "../ui/router.js";
import {
  fetchProfile, fetchPublicProfile, fetchChallenges, fetchSeason,
  fetchLeaderboard, fetchSeasonLeaderboard,
  fetchAdminStatus, publishDaily, updateDisplayName,
} from "./game-api.js";
import { startChallengeByRefs } from "./connect.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function avatarHtml(name, image, cls = "") {
  return image
    ? `<img class="gw-av ${cls}" src="${escapeHtml(image)}" alt="" />`
    : `<span class="gw-av gw-av--fallback ${cls}">${escapeHtml(initialOf(name || "?"))}</span>`;
}

// epoch seconds → a short, locale-formatted date ("relative" is overkill here).
function formatDate(ts) {
  if (!ts) return "";
  try { return new Date(Number(ts) * 1000).toLocaleDateString(); }
  catch { return ""; }
}

function daysLeft(endTs) {
  if (!endTs) return null;
  const ms = Number(endTs) * 1000 - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}

// ── Leaderboard (#/game/leaderboard) ──────────────────────────────────────────

let _lbScope = "season"; // "season" | "challenge"
let _lbToken = 0;

function renderLbList(entries) {
  if (!els.lbList) return;
  if (!entries || !entries.length) {
    els.lbList.innerHTML = "";
    if (els.lbEmpty) els.lbEmpty.hidden = false;
    return;
  }
  if (els.lbEmpty) els.lbEmpty.hidden = true;
  els.lbList.innerHTML = entries.map((e, i) =>
    `<li class="lb-row"><span class="lb-rank">${i + 1}</span>` +
    `<a class="lb-name" href="#/game/profile?user=${encodeURIComponent(e.user_id)}">${escapeHtml(e.display_name || "—")}</a>` +
    `<span class="lb-hops">${e.hops} hop${e.hops === 1 ? "" : "s"}</span>` +
    `<span class="lb-score">${e.score}</span></li>`).join("");
}

async function loadLeaderboard() {
  const token = ++_lbToken;
  if (els.lbList) els.lbList.innerHTML = "";
  if (els.lbEmpty) els.lbEmpty.hidden = true;

  if (_lbScope === "challenge") {
    const challengeId = State.connect?.game?.challengeId || null;
    if (els.lbScopeLabel) {
      els.lbScopeLabel.textContent = challengeId
        ? "This challenge — best line per player."
        : "Start a challenge on the Play screen to see its board.";
    }
    if (!challengeId) { renderLbList([]); return; }
    const page = await fetchLeaderboard(challengeId, { limit: 50 });
    if (token !== _lbToken) return;
    renderLbList(page?.entries || []);
    return;
  }

  // Season scope — resolve the current season's id, then its board.
  if (els.lbScopeLabel) els.lbScopeLabel.textContent = "This season — best line per player, all challenges.";
  const season = State.connect?.seasonId
    ? { id: State.connect.seasonId }
    : (await fetchSeason())?.season;
  if (token !== _lbToken) return;
  if (!season?.id) { renderLbList([]); return; }
  const page = await fetchSeasonLeaderboard(season.id, { limit: 50 });
  if (token !== _lbToken) return;
  renderLbList(page?.entries || []);
}

function setLbScope(scope) {
  _lbScope = scope === "challenge" ? "challenge" : "season";
  els.lbTabSeason?.classList.toggle("is-active", _lbScope === "season");
  els.lbTabChallenge?.classList.toggle("is-active", _lbScope === "challenge");
  loadLeaderboard();
}

// ── Profile (#/game/profile) ──────────────────────────────────────────────────

let _pfToken = 0;
let _profile = null; // the signed-in player's last-loaded profile (ЛК actions)

function renderBadges(list) {
  if (!els.pfBadgeList) return;
  if (!list || !list.length) {
    els.pfBadgeList.innerHTML = "";
    if (els.pfBadgesEmpty) els.pfBadgesEmpty.hidden = false;
    return;
  }
  if (els.pfBadgesEmpty) els.pfBadgesEmpty.hidden = true;
  els.pfBadgeList.innerHTML = list.map(a =>
    `<span class="pf-badge" title="${escapeHtml(a.descr || "")}">` +
    `<b class="pf-badge-title">${escapeHtml(a.title || a.code)}</b>` +
    `<span class="pf-badge-descr">${escapeHtml(a.descr || "")}</span></span>`).join("");
}

function renderHistory(history) {
  if (!els.pfHistory) return;
  if (!history || !history.length) {
    els.pfHistory.innerHTML = "";
    if (els.pfHistoryEmpty) els.pfHistoryEmpty.hidden = false;
    return;
  }
  if (els.pfHistoryEmpty) els.pfHistoryEmpty.hidden = true;
  els.pfHistory.innerHTML = history.map(h =>
    `<li class="pf-attempt pf-attempt--${h.valid ? "ok" : "bad"}">` +
    `<span class="pf-attempt-score">${h.valid ? h.score : "—"}</span>` +
    `<span class="pf-attempt-meta">${h.valid ? `${h.hops} hop${h.hops === 1 ? "" : "s"}` : "invalid line"}</span>` +
    `<span class="pf-attempt-date">${formatDate(h.ts)}</span></li>`).join("");
}

async function loadProfile() {
  const token = ++_pfToken;
  const profile = await fetchProfile();
  if (token !== _pfToken) return;

  _profile = profile;
  const signedIn = !!profile;
  if (els.profileSignedOut) els.profileSignedOut.hidden = signedIn;
  if (els.profileCard) els.profileCard.hidden = !signedIn;
  if (!signedIn) return;

  if (els.pfAvatar) {
    els.pfAvatar.innerHTML = profile.avatar_url
      ? `<img src="${escapeHtml(profile.avatar_url)}" alt="" />`
      : escapeHtml(initialOf(profile.display_name || "?"));
  }
  if (els.pfName) els.pfName.textContent = profile.display_name || "—";
  if (els.pfRank) els.pfRank.textContent = profile.rank ? `Rank #${profile.rank}` : "Unranked";
  if (els.pfElo) els.pfElo.textContent = profile.elo ?? "—";
  if (els.pfGames) els.pfGames.textContent = profile.games ?? "—";
  const badges = Array.isArray(profile.achievements) ? profile.achievements : [];
  if (els.pfBadges) els.pfBadges.textContent = String(badges.length);
  renderBadges(badges);

  // Self-profile GET carries no history — the public ?user= lookup does.
  const full = await fetchPublicProfile(profile.user_id);
  if (token !== _pfToken) return;
  renderHistory(full?.history || []);

  // [admin] Reveal the owner panel only if the server confirms it — a
  // signed-out / non-owner caller is simply {admin:false}.
  if (els.adminPanel) {
    const admin = await fetchAdminStatus();
    if (token !== _pfToken) return;
    els.adminPanel.hidden = !admin;
  }
}

// [design: ЛК] Rename (PATCH /api/v1/game/profile) + share the personal page.
async function onEditName() {
  const current = _profile?.display_name || "";
  const next = (window.prompt("Display name", current) || "").trim();
  if (!next || next === current) return;
  const updated = await updateDisplayName(next);
  if (!updated) { showToast("Couldn't change your name — it may be too long or not allowed.", 4200); return; }
  _profile = updated;
  if (els.pfName) els.pfName.textContent = updated.display_name || "—";
  showToast("✅ Name updated.", 2200, true);
}

function onShareProfile() {
  if (!_profile) return;
  const url = new URL(window.location.href);
  url.hash = "#/game/profile";
  url.search = `?user=${encodeURIComponent(_profile.user_id)}`;
  navigator.clipboard?.writeText(url.toString())
    .then(() => showToast("🔗 Profile link copied!", 2000, true))
    .catch(() => showToast(`Copy: ${url.toString()}`, 5000));
}

function setupProfileActions() {
  els.pfEditName?.addEventListener("click", onEditName);
  els.pfShare?.addEventListener("click", onShareProfile);
}

// ── Admin panel (owner-only, embedded in the Profile window) ──────────────────

let _adminFromId = 0;
let _adminToId = 0;

async function onPublishDaily() {
  if (els.adminPublishDaily) els.adminPublishDaily.disabled = true;
  if (els.adminStatus) els.adminStatus.textContent = "Publishing…";
  const res = await publishDaily({ from: _adminFromId, to: _adminToId });
  if (els.adminPublishDaily) els.adminPublishDaily.disabled = false;
  if (!res || !res.id) {
    if (els.adminStatus) {
      els.adminStatus.textContent =
        "Couldn't publish — that pair isn't connected in the graph yet, or you're not signed in as an admin.";
    }
    return;
  }
  if (els.adminStatus) {
    els.adminStatus.textContent = `Published daily challenge #${res.id} · PAR ${res.optimal_len ?? "?"}.`;
  }
  showToast("✅ Daily challenge published.", 2600, true);
}

function setupAdminPanel() {
  if (!els.adminPanel) return;
  if (els.adminFromInput) {
    attachGeniusAutocomplete(els.adminFromInput, els.adminFromAc,
      (name, image, id) => { els.adminFromInput.value = name; _adminFromId = id || 0; });
  }
  if (els.adminToInput) {
    attachGeniusAutocomplete(els.adminToInput, els.adminToAc,
      (name, image, id) => { els.adminToInput.value = name; _adminToId = id || 0; });
  }
  els.adminPublishDaily?.addEventListener("click", onPublishDaily);
}

// ── Challenges (#/game/challenges) ────────────────────────────────────────────

let _chKind = "";
let _chCursor = "";
let _chToken = 0;
let _chItems = [];

function challengeCardHtml(c, i) {
  const from = c.from || {}, to = c.to || {};
  const par = c.optimal_len != null ? `PAR ${c.optimal_len}` : "";
  return `<button type="button" class="ch-card" data-idx="${i}">` +
    `<span class="ch-card-kind ch-card-kind--${escapeHtml(c.kind || "custom")}">${escapeHtml(c.kind || "custom")}</span>` +
    `<span class="ch-card-pair">` +
      avatarHtml(from.name, from.image, "ch-av") +
      `<span class="ch-card-arrow" aria-hidden="true">→</span>` +
      avatarHtml(to.name, to.image, "ch-av") +
    `</span>` +
    `<span class="ch-card-names"><b>${escapeHtml(from.name || "?")}</b> → <b>${escapeHtml(to.name || "?")}</b></span>` +
    `<span class="ch-card-meta">${par}</span></button>`;
}

function renderChallenges(reset) {
  if (!els.chGrid) return;
  if (reset) els.chGrid.innerHTML = "";
  if (!_chItems.length) {
    if (els.chEmpty) els.chEmpty.hidden = false;
    if (els.chMore) els.chMore.hidden = true;
    return;
  }
  if (els.chEmpty) els.chEmpty.hidden = true;
  els.chGrid.innerHTML = _chItems.map(challengeCardHtml).join("");
  if (els.chMore) els.chMore.hidden = !_chCursor;
}

async function loadChallenges({ append = false } = {}) {
  const token = ++_chToken;
  const page = await fetchChallenges({ kind: _chKind, cursor: append ? _chCursor : "", limit: 24 });
  if (token !== _chToken) return;
  const items = page?.challenges || [];
  _chItems = append ? _chItems.concat(items) : items;
  _chCursor = page?.next_cursor || "";
  renderChallenges(!append);
}

function setChKind(kind) {
  _chKind = kind || "";
  els.chTabAll?.classList.toggle("is-active", _chKind === "");
  els.chTabDaily?.classList.toggle("is-active", _chKind === "daily");
  els.chTabCustom?.classList.toggle("is-active", _chKind === "custom");
  _chItems = [];
  _chCursor = "";
  loadChallenges({ append: false });
}

function startChallengeFromCard(idx) {
  const c = _chItems[idx];
  if (!c) return;
  const from = c.from || {}, to = c.to || {};
  if (!from.name || !to.name) return;
  startChallengeByRefs(
    { name: from.name, id: from.id, image: from.image },
    { name: to.name, id: to.id, image: to.image },
  );
}

// ── Season & Achievements (#/game/season) ─────────────────────────────────────

let _snToken = 0;

function renderPodium(entries) {
  if (!els.snPodium) return;
  if (!entries || !entries.length) {
    els.snPodium.innerHTML = "";
    if (els.snPodiumEmpty) els.snPodiumEmpty.hidden = false;
    return;
  }
  if (els.snPodiumEmpty) els.snPodiumEmpty.hidden = true;
  els.snPodium.innerHTML = entries.slice(0, 5).map((e, i) =>
    `<li class="lb-row"><span class="lb-rank">${i + 1}</span>` +
    `<span class="lb-name">${escapeHtml(e.display_name || "—")}</span>` +
    `<span class="lb-score">${e.score}</span></li>`).join("");
}

function renderAchievements(catalog, earnedCodes) {
  if (!els.snAchGrid) return;
  const list = Array.isArray(catalog) ? catalog : [];
  if (els.snAchCount) els.snAchCount.textContent = `${earnedCodes.size} / ${list.length}`;
  if (els.snAchHint) {
    els.snAchHint.textContent = earnedCodes.size
      ? "Lit tiles are yours; the rest are still up for grabs."
      : "Play a round to start lighting these up.";
  }
  els.snAchGrid.innerHTML = list.map(a => {
    const got = earnedCodes.has(a.code);
    return `<div class="sn-ach${got ? " is-earned" : ""}" title="${escapeHtml(a.descr || "")}">` +
      `<b class="sn-ach-title">${escapeHtml(a.title || a.code)}</b>` +
      `<span class="sn-ach-descr">${escapeHtml(a.descr || "")}</span></div>`;
  }).join("");
}

async function loadSeason() {
  const token = ++_snToken;
  const [view, profile] = await Promise.all([fetchSeason(), fetchProfile()]);
  if (token !== _snToken) return;

  const season = view?.season;
  if (els.snName) els.snName.textContent = season?.name || "Season";
  if (els.snDates && season) {
    els.snDates.textContent = `${formatDate(season.starts_ts)} — ${formatDate(season.ends_ts)}`;
  }
  if (els.snCountdown && season) {
    const d = daysLeft(season.ends_ts);
    els.snCountdown.textContent = d == null ? "" : d === 0 ? "Ends today" : `${d} day${d === 1 ? "" : "s"} left`;
  }
  if (els.snProgressFill && season) {
    const total = Number(season.ends_ts) - Number(season.starts_ts);
    const done = Date.now() / 1000 - Number(season.starts_ts);
    const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
    els.snProgressFill.style.width = `${pct}%`;
  }
  if (els.snYou) {
    const rank = profile?.rank;
    els.snYou.hidden = !rank;
    if (rank) els.snYou.textContent = `You: Elo ${profile.elo} · Rank #${rank}`;
  }

  renderPodium(view?.podium || []);
  const earned = new Set((profile?.achievements || []).map(a => a.code));
  renderAchievements(view?.achievements || [], earned);
}

// ── Surface routing ───────────────────────────────────────────────────────────

// Maps each routed surface to its screen element + its loader.
function screenFor(surface) {
  switch (surface) {
    case SURFACE_GAME_LEADERBOARD: return { el: els.gameLeaderboardSurface, load: loadLeaderboard };
    case SURFACE_GAME_PROFILE:     return { el: els.gameProfileSurface,     load: loadProfile };
    case SURFACE_GAME_CHALLENGES:  return { el: els.gameChallengesSurface,  load: () => loadChallenges({ append: false }) };
    case SURFACE_GAME_SEASON:      return { el: els.gameSeasonSurface,      load: loadSeason };
    default:                       return null;
  }
}

// Resolved fresh at call time (not captured at module load) so it never
// depends on whether dom/dom.js evaluated before or after these elements
// existed — the four routed screens, minus the Play surface connect.js owns.
function allScreens() {
  return [
    els.gameLeaderboardSurface, els.gameProfileSurface,
    els.gameChallengesSurface, els.gameSeasonSurface,
  ];
}

// Marks the active nav link across every game nav on the page (each screen —
// including the Play surface — repeats the same nav markup).
function markActiveNav(surface) {
  document.querySelectorAll(".game-nav-link[data-surface]").forEach(a => {
    a.classList.toggle("is-active", a.getAttribute("data-surface") === surface);
  });
}

function applySurface(surface) {
  markActiveNav(surface);
  const active = screenFor(surface);
  allScreens().forEach(el => {
    if (!el) return;
    const on = active && el === active.el;
    el.classList.toggle("show", !!on);
    el.hidden = !on;
  });
  if (active) active.load();
}

export function setupGameWindows() {
  // No-op if the window markup isn't present (e.g. a trimmed test fixture).
  if (!els.gameLeaderboardSurface && !els.gameProfileSurface &&
      !els.gameChallengesSurface && !els.gameSeasonSurface) return;

  els.lbTabSeason?.addEventListener("click", () => setLbScope("season"));
  els.lbTabChallenge?.addEventListener("click", () => setLbScope("challenge"));

  els.chTabAll?.addEventListener("click", () => setChKind(""));
  els.chTabDaily?.addEventListener("click", () => setChKind("daily"));
  els.chTabCustom?.addEventListener("click", () => setChKind("custom"));
  els.chMore?.addEventListener("click", () => loadChallenges({ append: true }));
  els.chGrid?.addEventListener("click", e => {
    const card = e.target.closest(".ch-card");
    if (card) startChallengeFromCard(Number(card.dataset.idx));
  });

  setupAdminPanel();
  setupProfileActions();

  onSurfaceChange(applySurface);
  applySurface(getCurrentSurface());
}
