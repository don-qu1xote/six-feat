// ════════════════════════════════════════════════════════════════════════════
// game/connect-actions.js — [SF-GAME-32] Контроллер раунда Connect: всё, что
// МЕНЯЕТ партию или ходит на бэк. Мутирует состояние через connect-store.js и
// модель, затем просит connect-view.js перерисоваться.
//
// Выделено из connect.js. Направление зависимостей строго одностороннее:
// actions → view → store. View не импортирует actions — колбэки кликов по
// графу регистрируются здесь, через view.setBoardHandlers(), одним вызовом на
// уровне модуля (см. ниже).
//
// [design: real backend] Никаких заглушек: POST /api/v1/game/challenge, как
// только известны оба эндпоинта, POST /api/v1/game/submit по Lock in, GET
// /api/v1/game/leaderboard сразу после засчитанного сабмита.
// ════════════════════════════════════════════════════════════════════════════
import { els } from "../dom/dom.js";
import { navigateToSurface, SURFACE_GAME } from "../ui/router.js";
import { showToast } from "../ui/toast.js";
import {
  createConnectChain, chainNodes, isComplete, addHop, undoHop, resetChain,
  giveUp as modelGiveUp, pathRevealed, elapsedMs, setChallengeId, applyResult,
  applyLeaderboard, winningPath, focusName, setFocus,
} from "./connect-model.js";
import {
  slice, setPhoto, setId, idFor, eqName, endpointsReady, resolveId,
  clearUnresolved, serializeGameShareState,
} from "./connect-store.js";
import { render, draw, setEndpointsExpanded, setBoardHandlers } from "./connect-view.js";
import { fetchNeighbours } from "./game-graph.js";
import { createChallenge, submitChain, fetchLeaderboard, checkLink } from "./game-api.js";

// ── Жизненный цикл партии ────────────────────────────────────────────────────

function syncGame() {
  const s = slice();
  s.game = endpointsReady() ? createConnectChain(s.startName, s.goalName) : null;
  // Свернуть редактор эндпоинтов, как только оба известны; пока неполно —
  // оставить открытым.
  setEndpointsExpanded(false);
  s.frontier = null;
  s.par = null;         // PAR (optimal_len челленджа) заполняет ensureChallenge
  s.submitted = false;  // свежая линия ещё ни разу не сдана
  // Свежая цепочка всегда без баннера соперника — pickRival (лендинг) ставит
  // его ОБРАТНО уже после обоих setStartArtist/setGoalArtist, которые дёргают
  // этот же syncGame, так что баннер переживает сброс.
  s.rivalBanner = null;
  // [SF-GAME-34] Новая пара — новые шансы у имён: прошлые неудачи резолва не
  // должны висеть честной ошибкой над свежим раундом.
  clearUnresolved();
  if (s.game) ensureChallenge();
}

// [design: real backend] Создаёт (или получает) челлендж для пары (start, goal),
// как только оба известны — нужны числовые id для обоих. Тихо сдаётся
// (challengeId остаётся null) на любой ошибке; submitRound это проверяет и
// честно говорит игроку, вместо того чтобы делать вид, что счёт посчитан.
async function ensureChallenge() {
  const s = slice();
  const game = s.game;
  if (!game) return;
  const [fromId, toId] = await Promise.all([resolveId(game.start), resolveId(game.goal)]);
  if (s.game !== game) return; // вытеснено более новой цепочкой/сбросом
  if (fromId == null || toId == null) { render(); return; }
  const challenge = await createChallenge(fromId, toId, 0);
  if (s.game !== game) return;
  if (challenge && challenge.id) setChallengeId(game, challenge.id);
  // [design: PAR pill] Идеальная длина челленджа — «пар» этого квеста.
  // Показывается в оверлее графа; сам идеальный ПУТЬ никогда не раскрывается,
  // только его длина (ту же информацию уже показывает финишная карточка).
  if (challenge && challenge.optimal_len != null) s.par = challenge.optimal_len;
  // [design: routed game windows] Запоминаем сезон челленджа, чтобы вкладке
  // «Season» на экране лидерборда было что запрашивать, даже если игрок
  // открыл её прямо из партии.
  if (challenge && challenge.season_id != null) s.seasonId = challenge.season_id;
  render();
}

// [design: ветвящийся веб] Фронтир (одуванчик реальных коллабораторов) цветёт
// вокруг СФОКУСИРОВАННОГО узла — точки ветвления, которую игрок расширяет и
// которая двигается по мере ввода/кликов, — а не вокруг линейного хвоста.
let _frontierToken = 0;

async function refreshFrontier() {
  const s = slice();
  if (!s.game || pathRevealed(s.game)) { s.frontier = null; render(); return; }
  const tail = focusName(s.game);
  const token = ++_frontierToken;
  let id = idFor(tail);
  if (id == null) id = await resolveId(tail);
  if (token !== _frontierToken) return;
  if (id == null) {
    s.frontier = { centerName: tail, loading: false, neighbours: [], unavailable: true };
    render();
    return;
  }
  s.frontier = { centerName: tail, loading: true, neighbours: [] };
  render();
  const result = await fetchNeighbours(id);
  if (token !== _frontierToken) return;
  const s2 = slice();
  if (!s2.game) return;
  s2.frontier = result
    ? { centerName: tail, loading: false, neighbours: result.neighbours }
    : { centerName: tail, loading: false, neighbours: [], failed: true };
  render();
}

// [design: real backend] Линия дошла до цели — собрать полную цепочку id
// (дорезолвив всё нерешённое) и сдать по-настоящему.
async function submitRound() {
  const s = slice();
  const game = s.game;
  if (!game || !game.completed) return;
  if (!game.challengeId) {
    showToast("Couldn't verify this challenge — try again from a fresh start/goal pick.", 4800, true);
    render();
    return;
  }
  // [design: ветвящийся веб] Сдаём ПОБЕДНУЮ ЛИНИЮ — путь start→goal сквозь
  // веб, — а не всё дерево. Проигравшие ветки это просто разведка игрока;
  // засчитывается только маршрут, дошедший до цели.
  const names = winningPath(game) || chainNodes(game);
  const ids = await Promise.all(names.map(resolveId));
  if (s.game !== game) return;
  if (ids.some(id => id == null)) {
    showToast("Couldn't identify one of the names in your chain, so this attempt can't be scored — the win still counts.", 5200, true);
    render();
    return;
  }
  render(); // показывает «Scoring…»
  const response = await submitChain(game.challengeId, ids, elapsedMs(game));
  if (s.game !== game) return;
  if (!response) {
    showToast("Couldn't reach the game service to score this attempt.", 4800, true);
    render();
    return;
  }
  applyResult(game, response);
  render();
  if (response.valid === true) {
    const board = await fetchLeaderboard(game.challengeId);
    if (s.game === game && board) { applyLeaderboard(game, board); render(); }
  }
}

// ── Взаимодействия ───────────────────────────────────────────────────────────

export function setStartArtist(name) { slice().startName = String(name || ""); syncGame(); render(); refreshFrontier(); }
export function setGoalArtist(name)  { slice().goalName  = String(name || ""); syncGame(); render(); refreshFrontier(); }

export function commitHop(name) {
  const s = slice();
  if (!s.game) return null;
  const res = addHop(s.game, name);
  if (res.ok && els.connectAddInput) els.connectAddInput.value = "";
  // [design: Lock in] Достижение цели больше не сабмитит автоматически — оно
  // просто достраивает линию и включает кнопку Lock in. Свежее завершение
  // никогда не является уже-сданным.
  if (res.ok && res.completed) s.submitted = false;
  render();
  if (res.ok && !res.completed) { resolveId(name); refreshFrontier(); }
  return res;
}

// [design: живая проверка хода / game #2] Является ли `name` реальным
// коллаборатором текущего фокуса? Быстрый путь: если он среди уже загруженных
// коллабораторов одуванчика — связан по построению, без круга по сети. Иначе
// спрашиваем сервер (GET /api/v1/game/link). Возвращает true (связан), false
// (точно НЕ связан) или null (проверить не вышло → вызывающий пропускает).
async function isLinkedToFocus(name, toId) {
  const s = slice();
  const game = s.game;
  if (!game) return null;
  const focus = focusName(game);
  const fr = s.frontier;
  if (fr && !fr.loading && Array.isArray(fr.neighbours) &&
      fr.neighbours.some(n => (toId != null && n.id === toId) || eqName(n.name, name))) {
    return true;
  }
  const fromId = idFor(focus) ?? await resolveId(focus);
  const resolvedTo = toId ?? idFor(name) ?? await resolveId(name);
  if (s.game !== game) return null;
  if (fromId == null || resolvedTo == null) return null; // не проверить → пропускаем
  const verdict = await checkLink(fromId, resolvedTo);
  return verdict.linked;
}

// [design: живая проверка хода / game #2] Добавление ВВОДОМ / выбором из
// поиска / кликом по цели — с живой проверкой связи, чтобы нельзя было
// уронить на веб артиста, который никогда не работал с текущим фокусом. Клики
// по одуванчику это минуют (selectBrowseNode → commitHop напрямую): там
// коллабораторы известны заранее. Пропускает ход, когда проверку сделать не
// удалось — всю победную линию всё равно валидирует сервер на сабмите.
export async function commitTypedHop(name) {
  const s = slice();
  const game = s.game;
  if (!game) return null;
  const clean = String(name || "").trim();
  if (!clean) return null;
  if (eqName(clean, focusName(game))) return null;

  const linked = await isLinkedToFocus(clean, idFor(clean));
  if (s.game !== game) return null;
  if (linked === false) {
    showToast(`${clean} isn't a known collaborator of ${focusName(game)} — pick from the graph or try another.`, 4600);
    return { ok: false, reason: "unlinked" };
  }
  return commitHop(clean);
}

// [design: Lock in] Сдать готовую линию на подсчёт. No-op, пока линия не
// дошла до цели или уже сдана.
export function lockIn() {
  const s = slice();
  if (!s.game || !isComplete(s.game) || s.game.gaveUp || s.submitted) return;
  s.submitted = true;
  render();
  submitRound();
}

export function undoLast() { const s = slice(); if (s.game) { undoHop(s.game); s.submitted = false; render(); refreshFrontier(); } }
export function resetGame() { const s = slice(); if (s.game) { resetChain(s.game); s.submitted = false; render(); refreshFrontier(); } }

export function giveUpGame() {
  const s = slice();
  if (!s.game) return;
  modelGiveUp(s.game);
  s.frontier = null;
  render();
}

// [design: ветвящийся веб] Перенести фокус на уже построенный узел, чтобы
// следующее добавление ветвилось от него. Пере-запрашивает коллабораторов
// этого узла (одуванчик следует за фокусом). No-op, если раунд окончен или
// имени нет в вебе.
export function focusNodeByName(name) {
  const s = slice();
  if (!s.game) return;
  if (setFocus(s.game, name).ok) { render(); refreshFrontier(); }
}

export function selectBrowseNode(node) {
  setPhoto(node.name, node.image);
  setId(node.name, node.id);
  commitHop(node.name);
}

// [fix] Change раньше раскрывал два ПУСТЫХ поля даже при уже известных
// эндпоинтах — реально всегда, когда игра начиналась не прямым вводом в эти
// два инпута (лендинговые duel/daily/rival ставят State напрямую через
// setStartArtist/setGoalArtist, не трогая .value). Синхронизируем ЗДЕСЬ, один
// раз, в момент фактического раскрытия — а не внутри общего прохода
// renderEndpoints(), который бежит и в середине потока (например, сразу после
// setStartArtist, но до setGoalArtist) и тогда затирал бы поле, которое
// вызывающий (пик автокомплита, восстановление deep-link) только что задал.
// [SF-GAME-47] Явный старт с экрана настройки. Раньше партия начиналась
// «сама», как только оба поля непусты — то есть на полпути ввода, ещё до того,
// как игрок закончил выбирать. Теперь это его решение и один клик.
export function startFromSetup() {
  const from = (els.connectStartInput?.value || "").trim();
  const to   = (els.connectGoalInput?.value  || "").trim();
  if (!from || !to) { showToast("Pick both artists first."); return; }
  setStartArtist(from);
  setGoalArtist(to);
}

export function expandEndpoints() {
  setEndpointsExpanded(true);
  const s = slice();
  if (els.connectStartInput) els.connectStartInput.value = s.startName;
  if (els.connectGoalInput) els.connectGoalInput.value = s.goalName;
  render();
}

// Копирует ссылку на ТЕКУЩИЙ челлендж (оба эндпоинта уже заданы) — тот же
// «записать в буфер и показать тост», что у history.js's copyShareableLink,
// только на состоянии игровой поверхности.
export function shareCurrentChallenge() {
  const s = slice();
  if (!s.game) return;
  const url = new URL(window.location.href);
  url.hash = "#/game";
  url.search = serializeGameShareState({ from: s.game.start, to: s.game.goal }).toString();
  // Тот же класс поломки, что чинился в game-windows.js::onShareProfile:
  // без буфера обмена это падало TypeError'ом ещё до .then().
  const link = url.toString();
  const write = navigator.clipboard?.writeText?.(link);
  if (!write || typeof write.then !== "function") { showToast(`Copy: ${link}`, 6000); return; }
  write.then(() => showToast("🔗 Link copied!", 2000, true))
       .catch(() => showToast(`Copy: ${link}`, 6000));
}

// [game #3] Стартовать любой челлендж с уже разрешённых эндпоинтов — общий
// путь за лендинговыми daily/rival карточками И за окном браузера челленджей
// (game-windows.js). from/to — { name, id?, image? }; наполнение кэшей id/фото
// означает, что партия ни разу не пере-резолвит имя через /api/v1/search.
// `rival` опционально несёт запись лидерборда, за которой гонимся.
export function startChallengeByRefs(from, to, rival) {
  if (!from || !from.name || !to || !to.name) return;
  if (from.id != null) setId(from.name, from.id);
  if (from.image) setPhoto(from.name, from.image);
  if (to.id != null) setId(to.name, to.id);
  if (to.image) setPhoto(to.name, to.image);
  setStartArtist(from.name);
  setGoalArtist(to.name);
  if (rival) slice().rivalBanner = { name: rival.display_name, score: rival.score };
  navigateToSurface(SURFACE_GAME);
}

export function _currentChain() { return slice().game; }

// Колбэки кликов по узлам графа. Регистрируются здесь, а не во view, потому
// что это ДЕЙСТВИЯ: клик по одуванчику добавляет хоп, клик по узлу веба
// переносит фокус, клик по цели пытается её достичь.
setBoardHandlers({
  onPick: selectBrowseNode,
  onFocus: focusNodeByName,
  onReachGoal: () => { const g = slice().game; if (g) commitTypedHop(g.goal); },
});

export { draw, refreshFrontier };
