// ════════════════════════════════════════════════════════════════════════════
// game/connect.js — [SF-GAME-01] Поверхность игры «Connect»: ПРОВОДКА.
//
// [SF-GAME-32] Этот модуль был god-модулем на 840 строк и ~45 функций —
// модель, контроллер, вью и свой императивный рендер-конвейер в одном файле.
// Разрезан на три по ответственности, с односторонними зависимостями:
//
//   connect-store.js   — слайс раунда, кэши фото/id, резолв имени в Genius id
//   connect-view.js    — все render*: пишут в DOM, ничего не меняют
//   connect-actions.js — жизненный цикл партии + взаимодействия + сеть
//   connect.js (здесь) — навешивание слушателей на DOM, лендинговая панель,
//                        и ре-экспорт публичной поверхности игры
//
// Публичный набор экспортов сохранён дословно, поэтому существующие
// импортёры (main.js, game-windows.js, connect.test.js) не меняются.
//
// [design: настоящий граф эксплорера] Игра рисуется на ТОМ ЖЕ движке, что и
// Explorer, в ограниченном режиме — вход/выход через vis-adapter/game-mode.js
// (ADR-0008), см. game-board.js.
// ════════════════════════════════════════════════════════════════════════════
import { els } from "../dom/dom.js";
import { escapeHtml, initialOf } from "../state/helpers.js";
import { navigateToSurface, onSurfaceChange, getCurrentSurface, SURFACE_GAME } from "../ui/router.js";
import { attachGeniusAutocomplete } from "../ui/autocomplete.js";
import { showToast } from "../ui/toast.js";
import { zoomBoard, fitBoard, mountBoard, unmountBoard } from "./game-board.js";
import { fetchDailyChallengeState, fetchLeaderboard } from "./game-api.js";
import { slice, setPhoto, setId, parseGameShareState } from "./connect-store.js";
import { render, draw } from "./connect-view.js";
import {
  setStartArtist, setGoalArtist, commitTypedHop, undoLast, resetGame,
  giveUpGame, lockIn, expandEndpoints, focusNodeByName, selectBrowseNode,
  shareCurrentChallenge, startChallengeByRefs, startFromSetup,
} from "./connect-actions.js";

// ── Публичная поверхность игры ───────────────────────────────────────────────
// Ре-экспорт из новых модулей: набор имён ровно тот же, что был до разреза.
export {
  setStartArtist, setGoalArtist, commitHop, commitTypedHop, undoLast, resetGame,
  giveUpGame, lockIn, expandEndpoints, shareCurrentChallenge,
  startChallengeByRefs, startFromSetup, _currentChain,
} from "./connect-actions.js";
export { serializeGameShareState, parseGameShareState } from "./connect-store.js";

// ── Проводка игровой поверхности ─────────────────────────────────────────────

// [SF-GAME-48] Эти два поля живут в двух ролях (см. renderEndpoints): экран
// старта до партии и поповер «сменить пару» по ходу партии. Роли отличаются
// моментом коммита, и это единственное место, где разница вообще есть.
//
// В поповере коммит немедленный — игрок уже в партии и меняет её сознательно.
// На экране старта коммита быть НЕ должно: setStartArtist/setGoalArtist сами
// стартуют партию, как только заданы оба конца, поэтому выбор второго артиста
// начинал игру мимо кнопки Start. SF-GAME-47 закрыл это для ручного ввода, но
// автокомплит остался лазейкой — здесь закрыт и он.
function inSetup() { return !slice().game; }

function commitField(inputEl, apply) {
  const v = (inputEl?.value || "").trim();
  if (!v) return;
  if (inSetup()) { startFromSetup(); return; }  // Enter на форме = «старт»
  apply(v);
}

// Пик из автокомплита: запоминаем фото/id (чтобы партия не пере-резолвила имя)
// и заполняем поле; коммит — только если мы в поповере.
function pickEndpoint(inputEl, apply) {
  return (name, image, id) => {
    inputEl.value = name;
    setPhoto(name, image);
    setId(name, id);
    if (inSetup()) syncSetupCta(); else apply(name);
  };
}

// Start недоступен, пока не выбраны оба конца — иначе единственный отклик на
// клик был бы тост «Pick both artists first».
function syncSetupCta() {
  if (!els.connectStartBtn) return;
  const from = (els.connectStartInput?.value || "").trim();
  const to   = (els.connectGoalInput?.value  || "").trim();
  els.connectStartBtn.disabled = !(from && to);
}

// Module-scope, не per-call: setupConnectMode может отработать больше одного
// раза в тестовом харнессе, а слушатель resize всё равно должен
// зарегистрироваться только в первый.
let _wired = false;

export function setupConnectMode() {
  if (!els.connectSurface) return;

  if (els.connectStartInput) {
    attachGeniusAutocomplete(els.connectStartInput, els.connectStartAc,
      pickEndpoint(els.connectStartInput, setStartArtist));
    els.connectStartInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitField(els.connectStartInput, setStartArtist); }
    });
    els.connectStartInput.addEventListener("input", syncSetupCta);
  }
  if (els.connectGoalInput) {
    attachGeniusAutocomplete(els.connectGoalInput, els.connectGoalAc,
      pickEndpoint(els.connectGoalInput, setGoalArtist));
    els.connectGoalInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitField(els.connectGoalInput, setGoalArtist); }
    });
    els.connectGoalInput.addEventListener("input", syncSetupCta);
  }
  syncSetupCta();
  if (els.connectAddInput) {
    // [game #2] Ввод/выбор проходят живую проверку связи (commitTypedHop);
    // клик по коллаборатору одуванчика — нет (он уже известный коллаборатор
    // фокуса, см. selectBrowseNode).
    attachGeniusAutocomplete(els.connectAddInput, els.connectAddAc,
      (name, image, id) => { setPhoto(name, image); setId(name, id); commitTypedHop(name); });
    els.connectAddInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commitTypedHop(els.connectAddInput.value); }
    });
  }
  els.connectAddBtn?.addEventListener("click", () => commitTypedHop(els.connectAddInput?.value));

  els.connectUndo?.addEventListener("click", undoLast);
  els.connectReset?.addEventListener("click", resetGame);
  els.connectGiveUp?.addEventListener("click", giveUpGame);
  els.connectShare?.addEventListener("click", shareCurrentChallenge);
  els.connectLockin?.addEventListener("click", lockIn);
  els.connectEndpointsSummary?.addEventListener("click", expandEndpoints);
  // [SF-GAME-47] Экран старта: явная CTA вместо «партия сама началась, как
  // только оба поля непусты».
  els.connectStartBtn?.addEventListener("click", startFromSetup);

  // [design: граф-эксплорер с рейлом] Zoom/fit рейл над живым графом.
  els.connectZoomIn?.addEventListener("click", () => zoomBoard(1.25));
  els.connectZoomOut?.addEventListener("click", () => zoomBoard(0.8));
  els.connectFit?.addEventListener("click", fitBoard);

  // [design: ветвящийся веб] Клик по строке линии пере-фокусирует узел — то
  // же действие ветвления, что и клик по узлу на графе.
  els.connectLineList?.addEventListener("click", e => {
    const row = e.target.closest(".clp-row");
    if (row && row.dataset.name) focusNodeByName(row.dataset.name);
  });

  els.connectBrowseChips?.addEventListener("click", e => {
    const btn = e.target.closest(".cb-chip");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const node = slice().frontier?.neighbours.find(n => n.id === id);
    if (node) selectBrowseNode(node);
  });

  if (!_wired) {
    _wired = true;
    window.addEventListener("resize", () => { if (getCurrentSurface() === SURFACE_GAME) draw(); });
  }

  const applySurface = surface => {
    const on = surface === SURFACE_GAME;
    els.connectSurface.classList.toggle("show", on);
    els.connectSurface.hidden = !on;
    if (on) {
      // [ADR-0008] Вход в ограниченный режим движка: game-mode.js переносит
      // #network в игровую колонку и забирает роутинг клика.
      mountBoard(els.connectCanvas);
      // Возврат на пустую поверхность (например, после Reset) — поля могли
      // остаться заполненными, CTA должна отражать ИХ, а не прошлый рендер.
      syncSetupCta();
      requestAnimationFrame(draw);
    } else {
      // Выход с поверхности: вернуть #network Explorer-канве и снять
      // ограничение интеракции.
      unmountBoard();
    }
  };
  onSurfaceChange(applySurface);
  applySurface(getCurrentSurface());

  // [SF-GAME-05] Заход прямо по расшаренной ссылке (#/game?from=..&to=..) —
  // та же «один раз на setup» посылка, что у main.js's loadArtistFromUrl для
  // графовой поверхности. Предзаполнение обоих полей гоняет ровно тот же
  // create-or-get поток челленджа, что и ручной ввод — ничего
  // deep-link-специфичного дальше по течению нет.
  if (getCurrentSurface() === SURFACE_GAME && !slice().game) {
    const { from, to } = parseGameShareState(window.location.search);
    if (from && to) {
      if (els.connectStartInput) els.connectStartInput.value = from;
      if (els.connectGoalInput) els.connectGoalInput.value = to;
      setStartArtist(from);
      setGoalArtist(to);
    }
  }

  render();
}

// ════════════════════════════════════════════════════════════════════════════
// [design: challenge setup on the landing page] Собственная hero-панель игры
// на лендинге — дуэль «vs», сознательно НЕ трек-маршрут Connect'а рядом
// (фидбек: две панели читались как один и тот же приём, использованный
// дважды). Проводка такая же, как у hero-панели Connect: настоящий
// автокомплит на обоих полях, одна CTA, передающая управление ровно тому же
// setStartArtist/setGoalArtist + navigateToSurface, которым уже пользуется
// deep-link из SF-GAME-05 — заход на #/game с обоими уже заданными
// эндпоинтами, переделывать там нечего.
// ════════════════════════════════════════════════════════════════════════════

function renderDuelAvatar(el, name, image) {
  if (!el) return;
  el.innerHTML = image ? `<img src="${escapeHtml(image)}" alt="" />` : "";
  if (!image) el.textContent = name ? initialOf(name) : "?";
}

function startChallengeFromLanding() {
  const from = (els.heroGameFromInput?.value || "").trim();
  const to = (els.heroGameToInput?.value || "").trim();
  if (!from || !to) { showToast("Enter both artist names."); return; }
  setStartArtist(from);
  setGoalArtist(to);
  navigateToSurface(SURFACE_GAME);
}

export function setupGameLandingPanel() {
  if (els.heroGameFromInput) {
    attachGeniusAutocomplete(els.heroGameFromInput, els.heroGameFromAc,
      (name, image, id) => {
        els.heroGameFromInput.value = name;
        setPhoto(name, image); setId(name, id);
        renderDuelAvatar(els.heroGameFromAvatar, name, image);
      });
    els.heroGameFromInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); els.heroGameToInput?.focus(); }
    });
  }
  if (els.heroGameToInput) {
    attachGeniusAutocomplete(els.heroGameToInput, els.heroGameToAc,
      (name, image, id) => {
        els.heroGameToInput.value = name;
        setPhoto(name, image); setId(name, id);
        renderDuelAvatar(els.heroGameToAvatar, name, image);
      });
    els.heroGameToInput.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); startChallengeFromLanding(); }
    });
  }
  els.btnHeroStartChallenge?.addEventListener("click", startChallengeFromLanding);
  // Слушатели вешаются ОДИН раз при проводке, а не внутри loadTodaysChallenge:
  // тот теперь может отработать повторно (Retry), и подписка на каждый вызов
  // копила бы обработчики.
  els.btnHeroPlayDaily?.addEventListener("click", () => startDailyChallenge(null));
  els.btnHeroDailyRetry?.addEventListener("click", () => loadTodaysChallenge());
  // [SF-GAME-59] Swap — тот же вторичный контрол, что у соседней вкладки
  // Connect (btn-hero-swap-path). Пара «откуда/куда» здесь ровно такая же, и
  // «а если наоборот?» — такой же частый вопрос; отсутствовал он только
  // потому, что игровая панель собиралась отдельным набором деталей.
  els.btnHeroGameSwap?.addEventListener("click", () => {
    const a = els.heroGameFromInput, b = els.heroGameToInput;
    if (!a || !b) return;
    [a.value, b.value] = [b.value, a.value];
    // Аватары в точках маршрута обязаны поехать вместе со значениями, иначе
    // рельса покажет старую пару.
    const fa = els.heroGameFromAvatar, fb = els.heroGameToAvatar;
    if (fa && fb) { const t = fa.innerHTML; fa.innerHTML = fb.innerHTML; fb.innerHTML = t; }
    a.focus();
  });

  loadTodaysChallenge();
}

// ── [design: Today's Challenge + or pick a rival] ────────────────────────────
// Настоящие GET /api/v1/game/challenge?daily=1 + GET /api/v1/game/leaderboard
// ?challenge_id=<daily.id> (SF-GAME-17, без изменений) — никаких моков, никакой
// карточки-заглушки во время загрузки. Обе остаются скрытыми (их разметка в
// index.html начинается с hidden), пока не приедут реальные данные; 404 (в
// этом окружении ещё не опубликован ежедневный челлендж) или сетевая ошибка
// просто оставляют композер единственным вариантом — ровно как было до
// появления этой фичи, и никогда не сломанной пустой карточкой.
let _daily = null;

function startDailyChallenge(rival) {
  if (!_daily) return;
  startChallengeByRefs(
    { name: _daily.from_name, id: _daily.from, image: _daily.from_image },
    { name: _daily.to_name,   id: _daily.to,   image: _daily.to_image },
    rival);
}

// [SF-GAME-60] Одно место, где решается, ЧТО показывает слот дейли. Четыре
// состояния, и ни одно из них не «исчезнуть молча»:
//   loading     — запрос в полёте (первый кадр главной);
//   ok          — пара + Play;
//   none        — сегодня челлендж ещё не опубликован (честный 404);
//   unavailable — сервис не ответил, и это НЕ то же самое, что «нет дейли».
// Разделение приехало из fetchDailyChallengeState: раньше getJson схлопывал
// 404 и 500 в один null, и блок прятался в обоих случаях.
function renderDailyState(state, daily) {
  const pair = els.heroGameDailyPair, line = els.heroGameDailyState;
  const play = els.btnHeroPlayDaily, retry = els.btnHeroDailyRetry;
  const showPair = state === "ok";
  if (pair)  pair.hidden  = !showPair;
  if (play)  play.hidden  = !showPair;
  if (retry) retry.hidden = state !== "unavailable";
  if (line) {
    line.hidden = showPair;
    line.textContent =
      state === "loading"     ? "Loading today's challenge…" :
      state === "none"        ? "No challenge published for today yet — set your own pair below." :
                                "Couldn't reach the game service — today's challenge isn't loaded, not missing.";
    line.classList.toggle("is-error", state === "unavailable");
  }
  if (els.heroGameDivider) els.heroGameDivider.hidden = false;
  if (!showPair || !daily) return;
  renderDuelAvatar(els.heroGameDailyFromAvatar, daily.from_name, daily.from_image);
  renderDuelAvatar(els.heroGameDailyToAvatar, daily.to_name, daily.to_image);
  if (els.heroGameDailyFromName) els.heroGameDailyFromName.textContent = daily.from_name;
  if (els.heroGameDailyToName) els.heroGameDailyToName.textContent = daily.to_name;
}

function renderRivals(entries) {
  if (!els.heroGameRivals || !els.heroGameRivalsList || !entries.length) return;
  els.heroGameRivals.hidden = false;
  // [SF-GAME-33] ui-chip — база кита; rival-chip остаётся модификатором
  // игровой специфики (ранг + счёт внутри чипа).
  els.heroGameRivalsList.innerHTML = entries.map((e, i) =>
    `<button type="button" class="ui-chip rival-chip" data-idx="${i}">` +
    `<span class="rc-rank">#${i + 1}</span>` +
    `<span class="rc-name">${escapeHtml(e.display_name)}</span>` +
    `<span class="rc-score">${e.score}</span></button>`
  ).join("");
  els.heroGameRivalsList.querySelectorAll(".rival-chip").forEach(btn => {
    btn.addEventListener("click", () => startDailyChallenge(entries[Number(btn.dataset.idx)]));
  });
}

async function loadTodaysChallenge() {
  renderDailyState("loading");
  const { status, daily } = await fetchDailyChallengeState();
  renderDailyState(status, daily);
  if (status !== "ok" || !daily) return;
  _daily = daily;

  const page = await fetchLeaderboard(daily.id);
  if (page?.entries?.length) renderRivals(page.entries);
}
