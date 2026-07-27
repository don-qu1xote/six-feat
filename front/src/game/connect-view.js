// ════════════════════════════════════════════════════════════════════════════
// game/connect-view.js — [SF-GAME-32] Вью раунда Connect: всё, что пишет в
// DOM, и больше ничего. Читает состояние через connect-store.js + модель,
// не вызывает сеть, не меняет игру.
//
// Выделено из connect.js: раньше одиннадцать render*-функций жили вперемешку
// с сетевыми вызовами и мутациями партии в одном 840-строчном модуле, и
// «отрисовать» было неотличимо от «сходить на бэк». Теперь направление
// зависимостей одностороннее: actions → view → store. View НЕ импортирует
// actions — колбэки доски (клик по узлу графа) приходят снаружи через
// setBoardHandlers(), иначе получился бы цикл.
//
// [SF-GAME-33] Разметка, которую генерируют эти функции, использует классы
// кита (ui-chip/ui-btn) там, где это контрол, плюс свой модификатор для
// игровой специфики — вместо полностью самодельных .cb-chip/.cl-row.
// ════════════════════════════════════════════════════════════════════════════
import { els } from "../dom/dom.js";
import { escapeHtml, initialOf } from "../state/helpers.js";
import {
  chainNodes, hopCount, isComplete, webSize, pathRevealed,
  elapsedMs, resultView, leaderboardView, focusName,
} from "./connect-model.js";
import { slice, idFor, endpointsReady, unresolvedNames } from "./connect-store.js";
import { renderBoard } from "./game-board.js";

// Колбэки кликов по узлам графа — ставятся один раз из connect-actions.js
// (см. модульный комментарий выше про направление зависимостей).
let _boardHandlers = {};
export function setBoardHandlers(handlers) {
  _boardHandlers = handlers || {};
}

// Раскрыт ли редактор эндпоинтов. Чисто состояние отображения, поэтому живёт
// здесь, а не в слайсе партии.
let _endpointsExpanded = false;
export function setEndpointsExpanded(on) { _endpointsExpanded = !!on; }

function renderHead() {
  const s = slice();
  if (els.connectTitleStart) els.connectTitleStart.textContent = s.game ? s.game.start : (s.startName || "Start");
  if (els.connectTitleGoal)  els.connectTitleGoal.textContent  = s.game ? s.game.goal  : (s.goalName || "Goal");
  if (els.connectHopsValue)  els.connectHopsValue.textContent  = s.game ? String(hopCount(s.game)) : "0";

  // [SF-GAME-55] Два полюса в шапке панели — те же, что рисует коридор на
  // графе. Аватар берём из того же кэша фото, что и строки линии; пока фото
  // нет, показываем инициал — как везде в этом приложении.
  const poleName = (el, name) => { if (el) el.textContent = name || "—"; };
  const poleAv = (el, name) => {
    if (!el) return;
    const photo = name ? s.photos[name] : null;
    el.innerHTML = photo
      ? `<img src="${escapeHtml(photo)}" alt="" />`
      : escapeHtml(name ? initialOf(name) : "?");
  };
  const fromName = s.game ? s.game.start : s.startName;
  const toName   = s.game ? s.game.goal  : s.goalName;
  poleName(els.connectPoleFromName, fromName);
  poleName(els.connectPoleToName, toName);
  poleAv(els.connectPoleFrom, fromName);
  poleAv(els.connectPoleTo, toName);

  // PAR pill — идеальная длина челленджа, как только она известна.
  if (els.connectParPill) {
    const showPar = s.game && s.par != null;
    els.connectParPill.hidden = !showPar;
    if (showPar && els.connectParValue) els.connectParValue.textContent = String(s.par);
  }

  // [SF-GAME-54] Прогресс против идеала — в панели, а не только в HUD над
  // графом. Пипсов ровно PAR: закрашенные — сделанные хопы, пустые — сколько
  // ещё укладывается в идеал. Перебор идеала не прячем, а показываем отдельным
  // цветом и явным «+N over par»: это и есть цена, которую игрок платит.
  if (els.connectProgress) {
    const par = s.game ? s.par : null;
    const show = !!s.game && par != null && par > 0;
    els.connectProgress.hidden = !show;
    if (show) {
      const hops = hopCount(s.game);
      const over = Math.max(0, hops - par);
      if (els.connectPips) {
        els.connectPips.innerHTML = Array.from({ length: par + over }, (_, i) => {
          const cls = i >= par ? "is-over" : i < hops ? "is-done" : "";
          return `<span class="clp-pip ${cls}"></span>`;
        }).join("");
      }
      if (els.connectProgressLabel) {
        els.connectProgressLabel.textContent = over > 0
          ? `${hops} / ${par} · +${over} over par`
          : `${hops} / ${par} to par`;
        els.connectProgressLabel.classList.toggle("is-over", over > 0);
      }
    }
  }

  if (els.connectRivalPill) {
    const rival = s.game ? s.rivalBanner : null;
    els.connectRivalPill.hidden = !rival;
    if (rival && els.connectRivalText) {
      els.connectRivalText.textContent = `Chasing ${rival.name} · ${rival.score}`;
    }
  }
}

// [design: ветвящийся веб] Текущая ЛИНИЯ игрока — ветка от старта до
// сфокусированного узла (chainNodes возвращает start→focus). Строки кликабельны
// (пере-фокус), фокус помечен, а футер считает артистов на других ветках, чтобы
// веб за кадром не был невидимым. Роли — по идентичности (start/goal), не по
// позиции: последний узел ветки — это фокус, и он совпадает с целью только
// после победы.
// [SF-GAME-50] Сколько строк было в прошлом кадре — чтобы пометить .is-new
// РОВНО на добавившейся. renderLine перерисовывает весь список одним
// innerHTML, поэтому анимация без этой отметки играла бы у всех строк разом
// на каждый рендер (в том числе на смене фокуса, где ничего не добавлялось).
let _lastLineLen = 0;

function renderLine() {
  const s = slice();
  if (!els.connectLineList) return;
  if (!s.game) { els.connectLineList.innerHTML = ""; _lastLineLen = 0; return; }
  const game = s.game;
  const names = chainNodes(game);
  const focus = focusName(game);
  const grew = names.length > _lastLineLen;
  _lastLineLen = names.length;
  const rows = names.map((name, i) => {
    const isNew = grew && i === names.length - 1;
    const isStart = name === game.start, isGoal = name === game.goal;
    const role = isStart ? "start" : isGoal ? "goal" : "hop";
    const isFocus = name === focus;
    const photo = s.photos[name];
    const avatar = photo
      ? `<img class="clp-av" src="${escapeHtml(photo)}" alt="" />`
      : `<span class="clp-av clp-av--${role}">${escapeHtml(initialOf(name))}</span>`;
    const sub = isStart ? "the origin"
      : isGoal ? (game.completed ? "reached" : "the target")
      : isFocus ? "branching from here" : "collaborator";
    return `<li class="clp-row clp-row--${role}${isFocus ? " is-focus" : ""}${isNew ? " is-new" : ""}" data-name="${escapeHtml(name)}">${avatar}` +
      `<span class="clp-row-main"><span class="clp-row-name">${escapeHtml(name)}</span>` +
      `<span class="clp-row-sub">${sub}</span></span></li>`;
  }).join("");
  // [SF-GAME-54] Цель всегда последней строкой — даже пока не достигнута.
  // Панель показывала только ПРОЙДЕННОЕ, поэтому вся её середина была пустой,
  // а куда игрок вообще идёт — читалось лишь из пилюли над графом. Призрачная
  // строка достраивает те же два полюса, что рисует коридор на графе: сверху
  // старт, снизу цель, между ними линия. Кликабельна не она, а её узел на
  // графе, поэтому data-name у неё нет.
  const goalGhost = names.includes(game.goal) ? "" :
    `<li class="clp-row clp-row--goal is-ghost">` +
    `<span class="clp-av clp-av--goal">${escapeHtml(initialOf(game.goal))}</span>` +
    `<span class="clp-row-main"><span class="clp-row-name">${escapeHtml(game.goal)}</span>` +
    `<span class="clp-row-sub">the target</span></span></li>`;

  const offBranch = webSize(game) - Math.max(0, names.length - 1);
  const note = offBranch > 0
    ? `<li class="clp-web-note">+${offBranch} on other branch${offBranch === 1 ? "" : "es"} — click any node to jump there</li>`
    : "";
  els.connectLineList.innerHTML = rows + goalGhost + note;
  // [SF-GAME-58] Дорожка горизонтальная и скроллится, поэтому активный шаг
  // обязан быть в кадре сам. Без этого после третьего хода фокус уезжал за
  // правый край панели, и трек показывал начало пути вместо места, где игрок
  // сейчас стоит.
  const focusCard = els.connectLineList.querySelector(".clp-row.is-focus");
  if (focusCard && typeof focusCard.scrollIntoView === "function") {
    focusCard.scrollIntoView({ block: "nearest", inline: "center" });
  }
}

function renderEndpoints() {
  const s = slice();
  // [SF-GAME-47] Одна разметка в двух ролях. Пока партии нет, редактор — это
  // экран старта по центру сцены (класс на поверхности переключает CSS);
  // как только партия есть, он снова компактный поповер за пилюлей.
  // [SF-GAME-48] Пока партии нет, карточка обязана быть открыта ВСЕГДА. Без
  // `!s.game` она пряталась ровно в тот момент, когда оба имени введены
  // (endpointsReady()) — то есть уносила с экрана кнопку Start за миг до того,
  // как на неё собирались нажать, и стартовый экран оставался пустым.
  const editing = !s.game || _endpointsExpanded || !endpointsReady();
  if (els.connectEndpoints) els.connectEndpoints.hidden = !editing;
  els.connectSurface?.classList.toggle("has-game", !!s.game);
}

// [design: настоящий граф эксплорера] Рисует состояние партии на РЕАЛЬНОМ
// движке #network (game-board.js), ограниченном линией + одуванчиком фокуса.
export function draw() {
  const s = slice();
  // [SF-GAME-40] par (optimal_len челленджа) задаёт длину коридора: цель стоит
  // на PAR-й колонке, поэтому «сколько мне ещё идти» видно сразу, а не только
  // в пилюле. Пока par не приехал — коридор минимальный и удлинится сам.
  renderBoard(s.game, s.photos, s.frontier, s.ids, _boardHandlers, { par: s.par });
}

// [SF-GAME-34 / ADR-0009] Честное состояние вместо фейкового узла. Имя, не
// разрешённое в реальный Genius id, больше не рисуется на графе (game-board
// .js) — раньше оно молча получало синтетический id и выглядело как обычный
// артист. Пустая сцена без объяснения читалась бы как поломка, поэтому здесь
// прямо говорим, что именно не опознано и что с этим делать.
function renderStage() {
  const s = slice();
  const stuck = s.game ? unresolvedNames().filter(n => n === s.game.start || n === s.game.goal) : [];
  if (els.connectStageEmpty) {
    // Без партии подсказку не показываем вовсе: её место занял экран старта
    // (SF-GAME-47), и две «пустые» надписи разом читались бы как поломка.
    els.connectStageEmpty.hidden = !s.game || stuck.length === 0;
    if (s.game && stuck.length) {
      els.connectStageEmpty.textContent = stuck.length === 1
        ? `Couldn't find “${stuck[0]}” on Genius — pick the artist from the suggestions instead of typing the name.`
        : `Couldn't find ${stuck.map(n => `“${n}”`).join(" or ")} on Genius — pick both artists from the suggestions.`;
    }
  }
  draw();
}

function renderComposer() {
  const s = slice();
  const active = !!s.game;
  const completed = active && isComplete(s.game);
  const usable = active && !completed && !s.game.gaveUp;
  if (els.connectAddInput) els.connectAddInput.disabled = !usable;
  if (els.connectAddBtn) els.connectAddBtn.disabled = !usable;
}

// [design: reuse the graph mockup] ВТОРИЧНЫЙ список-раскрывашка, свёрнут по
// умолчанию (см. <details> в index.html), наполняется настоящим /api/v1/graph.
function renderBrowse() {
  const s = slice();
  if (!els.connectBrowse) return;
  if (!s.game || pathRevealed(s.game) || !s.frontier) {
    els.connectBrowse.hidden = true;
    if (els.connectBrowseChips) els.connectBrowseChips.innerHTML = "";
    return;
  }
  els.connectBrowse.hidden = false;
  if (els.connectBrowseLabel) els.connectBrowseLabel.textContent = `Or browse ${s.frontier.centerName}'s real collaborators`;
  const f = s.frontier;
  if (!els.connectBrowseChips) return;
  if (f.unavailable) {
    els.connectBrowseChips.innerHTML = `<p class="connect-browse-empty">No graph data for ${escapeHtml(f.centerName)} yet — type a name above instead.</p>`;
    return;
  }
  if (f.loading) {
    els.connectBrowseChips.innerHTML = `<p class="connect-browse-loading">Loading ${escapeHtml(f.centerName)}'s collaborators…</p>`;
    return;
  }
  if (f.failed || !f.neighbours.length) {
    els.connectBrowseChips.innerHTML = `<p class="connect-browse-empty">No collaborators found for ${escapeHtml(f.centerName)}.</p>`;
    return;
  }
  const goalId = idFor(s.game.goal);
  els.connectBrowseChips.innerHTML = f.neighbours.map(n => {
    const isGoal = goalId != null && n.id === goalId;
    const ini = n.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
    const avatar = n.image
      ? `<img class="cb-avatar" src="${escapeHtml(n.image)}" alt="" />`
      : `<span class="cb-avatar cb-avatar--fallback">${escapeHtml(ini)}</span>`;
    // [SF-GAME-33] ui-chip — база кита; cb-chip остаётся только модификатором
    // игровой специфики (аватар внутри чипа, метка цели).
    return `<button type="button" class="ui-chip cb-chip${isGoal ? " cb-chip--goal" : ""}" data-id="${n.id}">` +
      avatar + `<span class="cb-name">${escapeHtml(n.name)}</span></button>`;
  }).join("");
}

function renderMiniActions() {
  const s = slice();
  const active = !!s.game;
  const completed = active && isComplete(s.game);
  if (els.connectUndo) els.connectUndo.disabled = !active || (hopCount(s.game) === 0 && !completed);
  if (els.connectReset) els.connectReset.disabled = !active || (hopCount(s.game) === 0 && !completed);
  if (els.connectGiveUp) els.connectGiveUp.disabled = !active || completed || s.game.gaveUp || hopCount(s.game) === 0;
  // [SF-GAME-05] Share имеет смысл, как только известны оба эндпоинта — он
  // ссылается на пару (from, to), а не на прогресс по хопам.
  if (els.connectShare) els.connectShare.disabled = !active;
}

// [design: Lock in] Явный сабмит: линия, дошедшая до цели, больше не
// засчитывается автоматически — игрок собирает всю линию, ВКЛЮЧАЯ цель, и
// жмёт Lock in. Доступно только когда линия полна и ещё не сдана / не сдался.
function renderLockin() {
  const s = slice();
  if (!els.connectLockin) return;
  const complete = s.game && isComplete(s.game) && !s.game.gaveUp;
  els.connectLockin.disabled = !complete || s.submitted;
  els.connectLockin.textContent = s.submitted ? "Locked in" : "Lock in";
}

// Счёт в футере + строки статуса/деталей. Ничего не показывается, пока игрок
// реально не сдал (s.submitted) или не сдался — никакого «Scoring…» в момент,
// когда он всего лишь дошёл до цели: сабмит теперь отдельный клик.
function renderFinish() {
  const s = slice();
  const scoreEl = els.connectFinishScore, labelEl = els.connectFinishLabel, detailEl = els.connectFinishDetail;
  const setLabel = t => { if (labelEl) labelEl.textContent = t || ""; };
  // [SF-GAME-50] Счёт — ради него партия и игралась; подмена текста без
  // единого кадра перехода читалась как «ничего не произошло». Класс снимаем
  // по animationend, иначе следующая смена значения не переиграет анимацию.
  const setScore = t => {
    if (!scoreEl || scoreEl.textContent === String(t)) return;
    scoreEl.textContent = t;
    scoreEl.classList.remove("is-bumped");
    void scoreEl.offsetWidth;                 // рефлоу — иначе класс вернётся в том же кадре
    scoreEl.classList.add("is-bumped");
  };
  const hideDetail = () => { if (detailEl) detailEl.hidden = true; };

  if (!s.game) { setScore("—"); setLabel(""); hideDetail(); return; }

  const view = resultView(s.game);

  if (s.game.gaveUp && !view) { setScore("—"); setLabel("You gave up — no score for this attempt."); hideDetail(); return; }

  if (!s.submitted && !view) { setScore("—"); setLabel(""); hideDetail(); return; }

  if (!view) { setScore("…"); setLabel("Scoring…"); hideDetail(); return; }

  if (!view.revealed) {
    setScore("0");
    const at = view.invalidHopIndex != null ? `hop ${view.invalidHopIndex + 1}` : "a hop";
    setLabel(`Not a real chain — the check failed at ${at}.`);
    hideDetail();
    return;
  }

  setScore(`${view.score}`);
  setLabel("");
  if (detailEl) {
    detailEl.hidden = false;
    const sign = view.eloDelta > 0 ? "+" : "";
    detailEl.textContent =
      `${view.score} / ${view.maxScore} · You: ${view.playerLen} hop${view.playerLen === 1 ? "" : "s"} · ` +
      `Ideal: ${view.optimalLen} · Elo ${view.eloBefore} → ${view.eloAfter} (${sign}${view.eloDelta})`;
  }
}

function renderLeaderboard() {
  const s = slice();
  if (!els.connectLeaderboard) return;
  const view = s.game ? leaderboardView(s.game) : null;
  if (!view || !view.entries.length) {
    els.connectLeaderboard.hidden = true;
    els.connectLeaderboard.innerHTML = "";
    return;
  }
  els.connectLeaderboard.hidden = false;
  const rows = view.entries.map((e, i) =>
    `<div class="cl-row"><span class="cl-rank">${i + 1}</span>` +
    `<span class="cl-name">${escapeHtml(e.displayName)}</span>` +
    `<span class="cl-score">${e.score}</span></div>`).join("");
  els.connectLeaderboard.innerHTML = `<h4 class="connect-leaderboard-title">Leaderboard</h4>${rows}`;
}

let _tickHandle = null;
function renderTimer() {
  const s = slice();
  if (!els.connectTimerValue) return;
  els.connectTimerValue.textContent = s.game ? formatElapsed(elapsedMs(s.game)) : "0:00";
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function ensureTicking() {
  const s = slice();
  const shouldTick = !!(s.game && !s.game.finishedAt);
  if (shouldTick && !_tickHandle) _tickHandle = setInterval(renderTimer, 500);
  else if (!shouldTick && _tickHandle) { clearInterval(_tickHandle); _tickHandle = null; }
}

// Один проход отрисовки. Единственная точка, которую дёргают actions после
// любой мутации партии.
export function render() {
  renderHead();
  renderEndpoints();
  renderLine();
  renderStage();
  renderComposer();
  renderBrowse();
  renderMiniActions();
  renderLockin();
  renderFinish();
  renderLeaderboard();
  renderTimer();
  ensureTicking();
}
