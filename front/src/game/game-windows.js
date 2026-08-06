import { State, MOTION } from "../state/state.js";
import { els } from "../dom/dom.js";
import { escapeHtml, initialOf } from "../state/helpers.js";
import { attachGeniusAutocomplete } from "../ui/autocomplete.js";
import { showToast } from "../ui/toast.js";
import { t, tPlural } from "../i18n/i18n.js";
import {
  onSurfaceChange,
  getCurrentSurface,
  SURFACE_GAME_LEADERBOARD,
  SURFACE_GAME_PROFILE,
  SURFACE_GAME_CHALLENGES,
  SURFACE_GAME_SEASON,
} from "../ui/router.js";
import {
  fetchProfile,
  fetchPublicProfile,
  fetchChallenges,
  fetchSeason,
  fetchLeaderboard,
  fetchSeasonLeaderboard,
  fetchAdminStatus,
  publishDaily,
  updateDisplayName,
} from "./game-api.js";
import { startChallengeByRefs } from "./connect.js";
import { resolveArtistId } from "./connect-store.js";

function avatarHtml(name, image, cls = "") {
  return image
    ? `<img class="gw-av ${cls}" src="${escapeHtml(image)}" alt="" />`
    : `<span class="gw-av gw-av--fallback ${cls}">${escapeHtml(initialOf(name || "?"))}</span>`;
}

function formatDate(ts) {
  if (!ts) return "";
  try {
    return new Date(Number(ts) * 1000).toLocaleDateString();
  } catch {
    return "";
  }
}

function daysLeft(endTs) {
  if (!endTs) return null;
  const ms = Number(endTs) * 1000 - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function setEmpty(el, { unavailable, emptyText }) {
  if (!el) return;
  el.hidden = false;
  el.textContent = unavailable ? t("game.list.unavailable") : emptyText;
}

let _lbScope = "season";
let _lbToken = 0;

function renderLbList(entries, { unavailable = false, scope = "season" } = {}) {
  if (!els.lbList) return;
  if (!entries || !entries.length) {
    els.lbList.innerHTML = "";
    setEmpty(els.lbEmpty, {
      unavailable,
      emptyText:
        scope === "challenge"
          ? t("game.leaderboard.emptyChallenge")
          : t("game.leaderboard.emptySeason"),
    });
    return;
  }
  if (els.lbEmpty) els.lbEmpty.hidden = true;
  const byElo = scope === "season";
  els.lbList.innerHTML = entries
    .map((e, i) => {
      const meta = byElo
        ? tPlural("game.leaderboard.gamesCount", e.games ?? 0)
        : tPlural("game.leaderboard.hopsCount", e.hops);
      const value = byElo ? (e.elo ?? "—") : e.score;
      return (
        `<li class="ui-tile lb-row"><span class="lb-rank">${i + 1}</span>` +
        `<a class="lb-name" href="#/game/profile?user=${encodeURIComponent(e.user_id)}">${escapeHtml(e.display_name || "—")}</a>` +
        `<span class="lb-hops">${meta}</span>` +
        `<span class="lb-score">${value}</span></li>`
      );
    })
    .join("");
}

async function loadLeaderboard() {
  const token = ++_lbToken;
  if (els.lbList) els.lbList.innerHTML = "";
  if (els.lbEmpty) els.lbEmpty.hidden = true;

  if (_lbScope === "challenge") {
    const challengeId = State.connect?.game?.challengeId || null;
    if (els.lbScopeLabel) {
      els.lbScopeLabel.textContent = challengeId
        ? t("game.leaderboard.challengeHint")
        : t("game.board.emptyHint");
    }
    if (!challengeId) {
      renderLbList([], { scope: "challenge" });
      return;
    }
    const page = await fetchLeaderboard(challengeId, { limit: 50 });
    if (token !== _lbToken) return;
    renderLbList(page?.entries || [], { unavailable: page == null, scope: "challenge" });
    return;
  }

  if (els.lbScopeLabel) els.lbScopeLabel.textContent = t("game.leaderboard.seasonHint");
  let seasonUnavailable = false;
  let season = State.connect?.seasonId ? { id: State.connect.seasonId } : null;
  if (!season) {
    const view = await fetchSeason();
    seasonUnavailable = view == null;
    season = view?.season || null;
  }
  if (token !== _lbToken) return;
  if (!season?.id) {
    renderLbList([], { unavailable: seasonUnavailable, scope: "season" });
    return;
  }
  const page = await fetchSeasonLeaderboard(season.id, { limit: 50 });
  if (token !== _lbToken) return;
  renderLbList(page?.entries || [], { unavailable: page == null, scope: "season" });
}

function setLbScope(scope) {
  _lbScope = scope === "challenge" ? "challenge" : "season";
  els.lbTabSeason?.classList.toggle("is-active", _lbScope === "season");
  els.lbTabChallenge?.classList.toggle("is-active", _lbScope === "challenge");
  loadLeaderboard();
}

let _pfToken = 0;
let _profile = null;
function renderBadges(list) {
  if (!els.pfBadgeList) return;
  if (!list || !list.length) {
    els.pfBadgeList.innerHTML = "";
    if (els.pfBadgesEmpty) els.pfBadgesEmpty.hidden = false;
    return;
  }
  if (els.pfBadgesEmpty) els.pfBadgesEmpty.hidden = true;
  els.pfBadgeList.innerHTML = list
    .map(
      (a) =>
        `<span class="ui-tile pf-badge" title="${escapeHtml(a.descr || "")}">` +
        `<span class="pf-badge-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${achIcon(a.code)}"></use></svg></span>` +
        `<span class="pf-badge-body"><b class="pf-badge-title">${escapeHtml(a.title || a.code)}</b>` +
        `<span class="pf-badge-descr">${escapeHtml(a.descr || "")}</span></span></span>`,
    )
    .join("");
}

function achIcon(code) {
  const c = String(code || "").toLowerCase();
  if (/first|blood|debut/.test(c)) return "icon-star";
  if (/win|champ|podium|beat|rival/.test(c)) return "icon-trophy";
  if (/streak|flame|fire|daily/.test(c)) return "icon-flame";
  if (/elo|rising|rank|master/.test(c)) return "icon-bolt";
  if (/speed|blitz|fast/.test(c)) return "icon-target";
  return "icon-medal";
}

function renderHistory(history) {
  if (!els.pfHistory) return;
  if (!history || !history.length) {
    els.pfHistory.innerHTML = "";
    if (els.pfHistoryEmpty) els.pfHistoryEmpty.hidden = false;
    return;
  }
  if (els.pfHistoryEmpty) els.pfHistoryEmpty.hidden = true;
  els.pfHistory.innerHTML = history
    .map(
      (h) =>
        `<li class="ui-tile pf-attempt pf-attempt--${h.valid ? "ok" : "bad"}">` +
        `<span class="pf-attempt-score">${h.valid ? h.score : "—"}</span>` +
        `<span class="pf-attempt-meta">${h.valid ? escapeHtml(tPlural("game.leaderboard.hopsCount", h.hops)) : escapeHtml(t("game.profile.invalidLine"))}</span>` +
        `<span class="pf-attempt-date">${formatDate(h.ts)}</span></li>`,
    )
    .join("");
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
  if (els.pfRank)
    els.pfRank.textContent = profile.rank
      ? t("game.leaderboard.rank", { rank: profile.rank })
      : t("game.leaderboard.unranked");
  if (els.pfElo) els.pfElo.textContent = profile.elo ?? "—";
  if (els.pfGames) els.pfGames.textContent = profile.games ?? "—";
  const badges = Array.isArray(profile.achievements) ? profile.achievements : [];
  if (els.pfBadges) els.pfBadges.textContent = String(badges.length);
  renderBadges(badges);

  const full = await fetchPublicProfile(profile.user_id);
  if (token !== _pfToken) return;
  renderHistory(full?.history || []);

  if (els.adminPanel) {
    const admin = await fetchAdminStatus();
    if (token !== _pfToken) return;
    els.adminPanel.hidden = !admin;
  }
}

async function onEditName() {
  const current = _profile?.display_name || "";
  const next = (window.prompt(t("game.profile.displayNameLabel"), current) || "").trim();
  if (!next || next === current) return;
  const updated = await updateDisplayName(next);
  if (!updated) {
    showToast(t("game.toast.nameChangeError"), 4200);
    return;
  }
  _profile = updated;
  if (els.pfName) els.pfName.textContent = updated.display_name || "—";
  showToast(t("game.toast.nameUpdated"), 2200, true);
}

function onShareProfile() {
  if (!_profile) {
    showToast(t("game.toast.signInToShare"), 3000);
    return;
  }
  const url = new URL(window.location.href);
  url.hash = "#/game/profile";
  url.search = `?user=${encodeURIComponent(_profile.user_id)}`;
  const link = url.toString();

  const write = navigator.clipboard?.writeText?.(link);
  if (!write || typeof write.then !== "function") {
    showToast(t("toast.copyFallback", { link }), 6000);
    return;
  }
  write
    .then(() => showToast(t("game.toast.profileLinkCopied"), 2000, true))
    .catch(() => showToast(t("toast.copyFallback", { link }), 6000));
}

function setupProfileActions() {
  els.pfEditName?.addEventListener("click", onEditName);
  els.pfShare?.addEventListener("click", onShareProfile);
}

let _adminFromId = 0;
let _adminToId = 0;

async function resolveAdminField(inputEl, pickedId) {
  const typed = (inputEl?.value || "").trim();
  if (!typed) return { ok: true, id: 0 };
  if (pickedId) return { ok: true, id: pickedId };
  const id = await resolveArtistId(typed);
  return id != null ? { ok: true, id } : { ok: false, name: typed };
}

async function onPublishDaily() {
  if (els.adminPublishDaily) els.adminPublishDaily.disabled = true;
  if (els.adminStatus) els.adminStatus.textContent = t("game.profile.publishing");

  const [from, to] = await Promise.all([
    resolveAdminField(els.adminFromInput, _adminFromId),
    resolveAdminField(els.adminToInput, _adminToId),
  ]);
  const bad = [from, to].filter((r) => !r.ok).map((r) => `“${r.name}”`);
  if (bad.length) {
    if (els.adminPublishDaily) els.adminPublishDaily.disabled = false;
    if (els.adminStatus) {
      els.adminStatus.textContent = t("game.admin.notFoundOnGenius", {
        names: bad.join(" or "),
      });
    }
    return;
  }

  const res = await publishDaily({ from: from.id, to: to.id });
  if (els.adminPublishDaily) els.adminPublishDaily.disabled = false;
  if (!res || !res.id) {
    if (els.adminStatus) {
      els.adminStatus.textContent = t("game.admin.publishFailed");
    }
    return;
  }
  if (els.adminStatus) {
    els.adminStatus.textContent = t("game.admin.published", {
      id: res.id,
      par: res.optimal_len ?? "?",
    });
  }
  showToast(t("game.toast.dailyPublished"), 2600, true);
}

function setupAdminPanel() {
  if (!els.adminPanel) return;
  if (els.adminFromInput) {
    attachGeniusAutocomplete(els.adminFromInput, els.adminFromAc, (name, image, id) => {
      els.adminFromInput.value = name;
      _adminFromId = id || 0;
    });
    els.adminFromInput.addEventListener("input", () => {
      _adminFromId = 0;
    });
  }
  if (els.adminToInput) {
    attachGeniusAutocomplete(els.adminToInput, els.adminToAc, (name, image, id) => {
      els.adminToInput.value = name;
      _adminToId = id || 0;
    });
    els.adminToInput.addEventListener("input", () => {
      _adminToId = 0;
    });
  }
  els.adminPublishDaily?.addEventListener("click", onPublishDaily);
}

let _chKind = "";
let _chQuery = "";
let _chCursor = "";
let _chToken = 0;
let _chItems = [];
let _chDebounce = null;

function challengeCardHtml(c, i) {
  const from = c.from || {},
    to = c.to || {};
  const par = c.optimal_len != null ? `PAR ${c.optimal_len}` : "";
  return (
    `<button type="button" class="ui-panel ch-card" data-idx="${i}">` +
    `<span class="ch-card-kind ch-card-kind--${escapeHtml(c.kind || "custom")}">${escapeHtml(c.kind || "custom")}</span>` +
    `<span class="ch-card-pair">` +
    avatarHtml(from.name, from.image, "ch-av") +
    `<span class="ch-card-arrow" aria-hidden="true">→</span>` +
    avatarHtml(to.name, to.image, "ch-av") +
    `</span>` +
    `<span class="ch-card-names"><b>${escapeHtml(from.name || "?")}</b> → <b>${escapeHtml(to.name || "?")}</b></span>` +
    `<span class="ch-card-meta">${par}</span></button>`
  );
}

function renderChallenges(reset, { unavailable = false } = {}) {
  if (!els.chGrid) return;
  if (reset) els.chGrid.innerHTML = "";
  if (!_chItems.length) {
    setEmpty(els.chEmpty, {
      unavailable,
      emptyText: _chQuery
        ? t("game.challenges.emptyQuery", { query: _chQuery })
        : t("game.challenges.emptyDefault"),
    });
    if (els.chMore) els.chMore.hidden = true;
    return;
  }
  if (els.chEmpty) els.chEmpty.hidden = true;
  els.chGrid.innerHTML = _chItems.map(challengeCardHtml).join("");
  if (els.chMore) els.chMore.hidden = !_chCursor;
}

async function loadChallenges({ append = false } = {}) {
  const token = ++_chToken;
  const page = await fetchChallenges({
    kind: _chKind,
    query: _chQuery,
    cursor: append ? _chCursor : "",
    limit: 24,
  });
  if (token !== _chToken) return;
  const items = page?.challenges || [];
  _chItems = append ? _chItems.concat(items) : items;
  _chCursor = page?.next_cursor || "";
  renderChallenges(!append, { unavailable: page == null });
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

function setChQuery(raw) {
  const q = String(raw || "").trim();
  if (els.chSearchClear) els.chSearchClear.hidden = !q;
  if (q === _chQuery) return;
  _chQuery = q;
  _chItems = [];
  _chCursor = "";
  loadChallenges({ append: false });
}

function onChSearchInput(raw) {
  if (_chDebounce) clearTimeout(_chDebounce);
  _chDebounce = setTimeout(() => setChQuery(raw), MOTION.slow);
}

function startChallengeFromCard(idx) {
  const c = _chItems[idx];
  if (!c) return;
  const from = c.from || {},
    to = c.to || {};
  if (!from.name || !to.name) return;
  startChallengeByRefs(
    { name: from.name, id: from.id, image: from.image },
    { name: to.name, id: to.id, image: to.image },
  );
}

let _snToken = 0;

function renderPodium(entries, { unavailable = false } = {}) {
  if (!els.snPodium) return;
  if (!entries || !entries.length) {
    els.snPodium.innerHTML = "";
    setEmpty(els.snPodiumEmpty, {
      unavailable,
      emptyText: t("game.season.podiumEmpty"),
    });
    return;
  }
  if (els.snPodiumEmpty) els.snPodiumEmpty.hidden = true;
  els.snPodium.innerHTML = entries
    .slice(0, 5)
    .map(
      (e, i) =>
        `<li class="ui-tile lb-row"><span class="lb-rank">${i + 1}</span>` +
        `<span class="lb-name">${escapeHtml(e.display_name || "—")}</span>` +
        `<span class="lb-hops">${escapeHtml(tPlural("game.leaderboard.gamesCount", e.games ?? 0))}</span>` +
        `<span class="lb-score">${e.elo ?? "—"}</span></li>`,
    )
    .join("");
}

function renderAchievements(catalog, earnedCodes) {
  if (!els.snAchGrid) return;
  const list = Array.isArray(catalog) ? catalog : [];
  if (els.snAchCount) els.snAchCount.textContent = `${earnedCodes.size} / ${list.length}`;
  if (els.snAchHint) {
    els.snAchHint.textContent = earnedCodes.size
      ? t("game.achievements.earnedHint")
      : t("game.achievements.emptyHint");
  }
  els.snAchGrid.innerHTML = list
    .map((a) => {
      const got = earnedCodes.has(a.code);
      return (
        `<div class="ui-tile sn-ach${got ? " is-earned" : ""}" title="${escapeHtml(a.descr || "")}">` +
        `<span class="sn-ach-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${achIcon(a.code)}"></use></svg></span>` +
        `<span class="sn-ach-body"><b class="sn-ach-title">${escapeHtml(a.title || a.code)}</b>` +
        `<span class="sn-ach-descr">${escapeHtml(a.descr || "")}</span></span></div>`
      );
    })
    .join("");
}

async function loadSeason() {
  const token = ++_snToken;
  const [view, profile] = await Promise.all([fetchSeason(), fetchProfile()]);
  if (token !== _snToken) return;

  const season = view?.season;
  if (els.snName) els.snName.textContent = season?.name || t("game.season.label");
  if (els.snDates && season) {
    els.snDates.textContent = `${formatDate(season.starts_ts)} — ${formatDate(season.ends_ts)}`;
  }
  if (els.snCountdown && season) {
    const d = daysLeft(season.ends_ts);
    els.snCountdown.textContent =
      d == null ? "" : d === 0 ? t("game.season.endsToday") : tPlural("game.season.daysLeft", d);
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

  renderPodium(view?.podium || [], { unavailable: view == null });
  const earned = new Set((profile?.achievements || []).map((a) => a.code));
  renderAchievements(view?.achievements || [], earned);
}

function screenFor(surface) {
  switch (surface) {
    case SURFACE_GAME_LEADERBOARD:
      return { el: els.gameLeaderboardSurface, load: loadLeaderboard };
    case SURFACE_GAME_PROFILE:
      return { el: els.gameProfileSurface, load: loadProfile };
    case SURFACE_GAME_CHALLENGES:
      return { el: els.gameChallengesSurface, load: () => loadChallenges({ append: false }) };
    case SURFACE_GAME_SEASON:
      return { el: els.gameSeasonSurface, load: loadSeason };
    default:
      return null;
  }
}

function allScreens() {
  return [
    els.gameLeaderboardSurface,
    els.gameProfileSurface,
    els.gameChallengesSurface,
    els.gameSeasonSurface,
  ];
}

function markActiveNav(surface) {
  document.querySelectorAll(".game-nav-link[data-surface]").forEach((a) => {
    a.classList.toggle("is-active", a.getAttribute("data-surface") === surface);
  });
}

function applySurface(surface) {
  markActiveNav(surface);
  const active = screenFor(surface);
  allScreens().forEach((el) => {
    if (!el) return;
    const on = active && el === active.el;
    el.classList.toggle("show", !!on);
    el.hidden = !on;
  });
  if (active) active.load();
}

export function setupGameWindows() {
  if (
    !els.gameLeaderboardSurface &&
    !els.gameProfileSurface &&
    !els.gameChallengesSurface &&
    !els.gameSeasonSurface
  )
    return;

  els.lbTabSeason?.addEventListener("click", () => setLbScope("season"));
  els.lbTabChallenge?.addEventListener("click", () => setLbScope("challenge"));

  els.chTabAll?.addEventListener("click", () => setChKind(""));
  els.chTabDaily?.addEventListener("click", () => setChKind("daily"));
  els.chTabCustom?.addEventListener("click", () => setChKind("custom"));
  els.chMore?.addEventListener("click", () => loadChallenges({ append: true }));
  els.chSearchInput?.addEventListener("input", (e) => onChSearchInput(e.target.value));
  els.chSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setChQuery(e.target.value);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.target.value = "";
      setChQuery("");
    }
  });
  els.chSearchClear?.addEventListener("click", () => {
    if (els.chSearchInput) els.chSearchInput.value = "";
    setChQuery("");
    els.chSearchInput?.focus();
  });
  els.chGrid?.addEventListener("click", (e) => {
    const card = e.target.closest(".ch-card");
    if (card) startChallengeFromCard(Number(card.dataset.idx));
  });

  setupAdminPanel();
  setupProfileActions();

  onSurfaceChange(applySurface);
  applySurface(getCurrentSurface());
}
