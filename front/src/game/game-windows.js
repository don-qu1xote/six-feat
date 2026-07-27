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
import { State, MOTION } from "../state/state.js";
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
// [SF-GAME-34 / ADR-0009] Админская публикация тоже обязана работать на
// реальных id — тот же резолвер, что и партия, но без её кэшей.
import { resolveArtistId } from "./connect-store.js";

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

// ── [SF-GAME-37] Пусто ≠ недоступно ──────────────────────────────────────────
// Клиенты game-api.js по соглашению отдают null на любой сбой (не-ok статус или
// транспорт) — а рендеры ниже разворачивали это в `|| []` и показывали «пока
// пусто». То есть при лежащем сервисе экран уверенно врал, что играть ещё никто
// не начинал. Теперь у пустоты две причины, и текст у них разный: «ещё нет» —
// это правда о данных, «не смогли загрузить» — правда о связи.
function setEmpty(el, { unavailable, emptyText }) {
  if (!el) return;
  el.hidden = false;
  el.textContent = unavailable
    ? "Couldn't reach the game service — this list isn't loaded, not empty. Try again in a moment."
    : emptyText;
}

// ── Leaderboard (#/game/leaderboard) ──────────────────────────────────────────

let _lbScope = "season"; // "season" | "challenge"
let _lbToken = 0;

// [SF-GAME-53] Две доски отвечают на разные вопросы, поэтому и колонки у них
// разные. Челлендж: «чья линия на этой паре лучше» → hops + score. Сезон: «кто
// сильнее по рейтингу» → games + Elo, потому что сезонная доска теперь
// сортируется бэкендом ИМЕННО по elo (game_store.cpp::SeasonEloBoard). Раньше
// обе рисовались как score, и на экране Season подиум по score стоял рядом со
// строкой «You: Elo … · Rank #N», посчитанной по elo — два числа про одно и то
// же место, способные разойтись сколь угодно далеко.
function renderLbList(entries, { unavailable = false, scope = "season" } = {}) {
  if (!els.lbList) return;
  if (!entries || !entries.length) {
    els.lbList.innerHTML = "";
    setEmpty(els.lbEmpty, { unavailable,
      emptyText: scope === "challenge"
        ? "No scored lines here yet — be the first to lock one in."
        : "No ranked players this season yet — be the first to lock in a line." });
    return;
  }
  if (els.lbEmpty) els.lbEmpty.hidden = true;
  const byElo = scope === "season";
  els.lbList.innerHTML = entries.map((e, i) => {
    const meta = byElo
      ? `${e.games ?? 0} game${e.games === 1 ? "" : "s"}`
      : `${e.hops} hop${e.hops === 1 ? "" : "s"}`;
    const value = byElo ? (e.elo ?? "—") : e.score;
    return `<li class="ui-tile lb-row"><span class="lb-rank">${i + 1}</span>` +
      `<a class="lb-name" href="#/game/profile?user=${encodeURIComponent(e.user_id)}">${escapeHtml(e.display_name || "—")}</a>` +
      `<span class="lb-hops">${meta}</span>` +
      `<span class="lb-score">${value}</span></li>`;
  }).join("");
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
    if (!challengeId) { renderLbList([], { scope: "challenge" }); return; }
    const page = await fetchLeaderboard(challengeId, { limit: 50 });
    if (token !== _lbToken) return;
    renderLbList(page?.entries || [], { unavailable: page == null, scope: "challenge" });
    return;
  }

  // Season scope — resolve the current season's id, then its board.
  if (els.lbScopeLabel) els.lbScopeLabel.textContent = "This season — players by Elo rating.";
  let seasonUnavailable = false;
  let season = State.connect?.seasonId ? { id: State.connect.seasonId } : null;
  if (!season) {
    const view = await fetchSeason();
    seasonUnavailable = view == null;
    season = view?.season || null;
  }
  if (token !== _lbToken) return;
  // Нет сезона — это либо «сервис не ответил», либо «сезон ещё не заведён».
  if (!season?.id) { renderLbList([], { unavailable: seasonUnavailable, scope: "season" }); return; }
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
    `<span class="ui-tile pf-badge" title="${escapeHtml(a.descr || "")}">` +
    `<span class="pf-badge-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${achIcon(a.code)}"></use></svg></span>` +
    `<span class="pf-badge-body"><b class="pf-badge-title">${escapeHtml(a.title || a.code)}</b>` +
    `<span class="pf-badge-descr">${escapeHtml(a.descr || "")}</span></span></span>`).join("");
}

// [design: иконки ачивок] Pick an icon for an achievement by a keyword in its
// code — falls back to a medal. Every id exists in index.html's sprite.
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
  els.pfHistory.innerHTML = history.map(h =>
    `<li class="ui-tile pf-attempt pf-attempt--${h.valid ? "ok" : "bad"}">` +
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

// [ИСПРАВЛЕНО: «кнопка share profile не работает»] Здесь было две поломки
// сразу. Первая: `navigator.clipboard?.writeText(...)` — опциональная цепочка
// защищает только ЧТЕНИЕ свойства; если clipboard недоступен (не-secure
// контекст, отказ в разрешении), выражение даёт undefined, и следующий же
// `.then()` роняет обработчик TypeError'ом — кнопка не делала вообще ничего и
// молча. Вторая: без загруженного профиля был тихий `return`, то есть у
// нажатия не было никакого исхода. Теперь у каждой ветки есть видимый ответ.
function onShareProfile() {
  if (!_profile) {
    showToast("Sign in to share your profile.", 3000);
    return;
  }
  const url = new URL(window.location.href);
  url.hash = "#/game/profile";
  url.search = `?user=${encodeURIComponent(_profile.user_id)}`;
  const link = url.toString();

  const write = navigator.clipboard?.writeText?.(link);
  if (!write || typeof write.then !== "function") {
    // Буфера нет — показываем ссылку, чтобы её можно было скопировать руками.
    showToast(`Copy: ${link}`, 6000);
    return;
  }
  write.then(() => showToast("🔗 Profile link copied!", 2000, true))
       .catch(() => showToast(`Copy: ${link}`, 6000));
}

function setupProfileActions() {
  els.pfEditName?.addEventListener("click", onEditName);
  els.pfShare?.addEventListener("click", onShareProfile);
}

// ── Admin panel (owner-only, embedded in the Profile window) ──────────────────

let _adminFromId = 0;
let _adminToId = 0;

// [SF-GAME-34 / ADR-0009] Разрешить то, что реально стоит в поле, в РЕАЛЬНЫЙ
// Genius id. Раньше id брался только из колбэка автокомплита, и имя, которое
// набрали, но не выбрали из списка, оставляло id=0 — сервер получал пару
// (0, 0) и публиковал СЛУЧАЙНУЮ пару, а UI показывал «Couldn't publish». Это
// и есть корень бага P1. Ноль больше не считается идентификатором: если поле
// пустое — это «на ваш выбор» (сервер подберёт пару сам), если непустое —
// оно ОБЯЗАНО разрешиться, иначе публикации не будет.
async function resolveAdminField(inputEl, pickedId) {
  const typed = (inputEl?.value || "").trim();
  if (!typed) return { ok: true, id: 0 };            // пусто = пусть выберет сервер
  if (pickedId) return { ok: true, id: pickedId };   // выбрано из автокомплита
  const id = await resolveArtistId(typed);
  return id != null ? { ok: true, id } : { ok: false, name: typed };
}

async function onPublishDaily() {
  if (els.adminPublishDaily) els.adminPublishDaily.disabled = true;
  if (els.adminStatus) els.adminStatus.textContent = "Publishing…";

  const [from, to] = await Promise.all([
    resolveAdminField(els.adminFromInput, _adminFromId),
    resolveAdminField(els.adminToInput, _adminToId),
  ]);
  const bad = [from, to].filter(r => !r.ok).map(r => `“${r.name}”`);
  if (bad.length) {
    if (els.adminPublishDaily) els.adminPublishDaily.disabled = false;
    if (els.adminStatus) {
      els.adminStatus.textContent =
        `Couldn't find ${bad.join(" or ")} on Genius. Pick the artist from the suggestions, or clear the field to let the server choose.`;
    }
    return;
  }

  const res = await publishDaily({ from: from.id, to: to.id });
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
  // [SF-GAME-34] Пик из автокомплита даёт id; НАБОР руками его сбрасывает —
  // иначе id от прошлого выбора «залипал» бы на новом, другом тексте, и
  // публиковалась бы пара, которой админ не выбирал (тот же класс бага, что
  // id=0 → случайная пара, только тише).
  if (els.adminFromInput) {
    attachGeniusAutocomplete(els.adminFromInput, els.adminFromAc,
      (name, image, id) => { els.adminFromInput.value = name; _adminFromId = id || 0; });
    els.adminFromInput.addEventListener("input", () => { _adminFromId = 0; });
  }
  if (els.adminToInput) {
    attachGeniusAutocomplete(els.adminToInput, els.adminToAc,
      (name, image, id) => { els.adminToInput.value = name; _adminToId = id || 0; });
    els.adminToInput.addEventListener("input", () => { _adminToId = 0; });
  }
  els.adminPublishDaily?.addEventListener("click", onPublishDaily);
}

// ── Challenges (#/game/challenges) ────────────────────────────────────────────

let _chKind = "";
let _chQuery = "";        // [SF-GAME-46] поиск по артисту (оба конца пары)
let _chCursor = "";
let _chToken = 0;
let _chItems = [];
let _chDebounce = null;

function challengeCardHtml(c, i) {
  const from = c.from || {}, to = c.to || {};
  const par = c.optimal_len != null ? `PAR ${c.optimal_len}` : "";
  return `<button type="button" class="ui-panel ch-card" data-idx="${i}">` +
    `<span class="ch-card-kind ch-card-kind--${escapeHtml(c.kind || "custom")}">${escapeHtml(c.kind || "custom")}</span>` +
    `<span class="ch-card-pair">` +
      avatarHtml(from.name, from.image, "ch-av") +
      `<span class="ch-card-arrow" aria-hidden="true">→</span>` +
      avatarHtml(to.name, to.image, "ch-av") +
    `</span>` +
    `<span class="ch-card-names"><b>${escapeHtml(from.name || "?")}</b> → <b>${escapeHtml(to.name || "?")}</b></span>` +
    `<span class="ch-card-meta">${par}</span></button>`;
}

function renderChallenges(reset, { unavailable = false } = {}) {
  if (!els.chGrid) return;
  if (reset) els.chGrid.innerHTML = "";
  if (!_chItems.length) {
    setEmpty(els.chEmpty, { unavailable,
      // Пустой результат поиска и пустой каталог — разные вещи, и советы у них
      // разные: в первом случае надо менять запрос, во втором — сыграть.
      emptyText: _chQuery
        ? `Nothing matches “${_chQuery}”. Try another artist, or clear the search.`
        : "No challenges published yet — start one from the Play screen and it shows up here." });
    if (els.chMore) els.chMore.hidden = true;
    return;
  }
  if (els.chEmpty) els.chEmpty.hidden = true;
  els.chGrid.innerHTML = _chItems.map(challengeCardHtml).join("");
  if (els.chMore) els.chMore.hidden = !_chCursor;
}

async function loadChallenges({ append = false } = {}) {
  const token = ++_chToken;
  const page = await fetchChallenges({ kind: _chKind, query: _chQuery, cursor: append ? _chCursor : "", limit: 24 });
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

// [SF-GAME-46] Ввод дебаунсится: игрок печатает имя посимвольно, и запрос на
// каждый символ был бы N лишних round-trip'ов. --duration-slow как порог «уже
// не печатает» — та же шкала, что у всей остальной анимации, вместо
// очередного магического числа.
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
  const from = c.from || {}, to = c.to || {};
  if (!from.name || !to.name) return;
  startChallengeByRefs(
    { name: from.name, id: from.id, image: from.image },
    { name: to.name, id: to.id, image: to.image },
  );
}

// ── Season & Achievements (#/game/season) ─────────────────────────────────────

let _snToken = 0;

function renderPodium(entries, { unavailable = false } = {}) {
  if (!els.snPodium) return;
  if (!entries || !entries.length) {
    els.snPodium.innerHTML = "";
    setEmpty(els.snPodiumEmpty, { unavailable,
      emptyText: "Nobody on the podium yet — this season is still wide open." });
    return;
  }
  if (els.snPodiumEmpty) els.snPodiumEmpty.hidden = true;
  // [SF-GAME-53] Подиум сезона — та же сезонная доска, значит тот же ключ:
  // Elo. Именно здесь расхождение и было заметнее всего — подиум по score
  // стоял в двух сантиметрах от строки «You: Elo … · Rank #N» по elo.
  els.snPodium.innerHTML = entries.slice(0, 5).map((e, i) =>
    `<li class="ui-tile lb-row"><span class="lb-rank">${i + 1}</span>` +
    `<span class="lb-name">${escapeHtml(e.display_name || "—")}</span>` +
    `<span class="lb-hops">${e.games ?? 0} game${e.games === 1 ? "" : "s"}</span>` +
    `<span class="lb-score">${e.elo ?? "—"}</span></li>`).join("");
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
    return `<div class="ui-tile sn-ach${got ? " is-earned" : ""}" title="${escapeHtml(a.descr || "")}">` +
      `<span class="sn-ach-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${achIcon(a.code)}"></use></svg></span>` +
      `<span class="sn-ach-body"><b class="sn-ach-title">${escapeHtml(a.title || a.code)}</b>` +
      `<span class="sn-ach-descr">${escapeHtml(a.descr || "")}</span></span></div>`;
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

  renderPodium(view?.podium || [], { unavailable: view == null });
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
  // [SF-GAME-46] Поиск по артисту. Enter ищет немедленно (не ждём дебаунс —
  // игрок уже сказал, что закончил), Esc сбрасывает.
  els.chSearchInput?.addEventListener("input", e => onChSearchInput(e.target.value));
  els.chSearchInput?.addEventListener("keydown", e => {
    if (e.key === "Enter")  { e.preventDefault(); setChQuery(e.target.value); }
    if (e.key === "Escape") { e.preventDefault(); e.target.value = ""; setChQuery(""); }
  });
  els.chSearchClear?.addEventListener("click", () => {
    if (els.chSearchInput) els.chSearchInput.value = "";
    setChQuery("");
    els.chSearchInput?.focus();
  });
  els.chGrid?.addEventListener("click", e => {
    const card = e.target.closest(".ch-card");
    if (card) startChallengeFromCard(Number(card.dataset.idx));
  });

  setupAdminPanel();
  setupProfileActions();

  onSurfaceChange(applySurface);
  applySurface(getCurrentSurface());
}
