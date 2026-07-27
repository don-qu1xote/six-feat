// ════════════════════════════════════════════════════════════════════════════
// game/game-board.js — [design: настоящий граф эксплорера с ограничениями]
//
// The Connect game renders on the REAL graph engine — the SAME State.network on
// #network the Explorer drives, through the SAME replaceGraph() pipeline
// (graph.js → vis-adapter render/physics/visuals/highlight). This is not a
// copy of the graph; it IS the graph, put into a restricted "game mode":
//
//   • RESTRICTED node set — only the player's line + the FOCUSED artist's real
//     collaborators (the dandelion) are ever in the DataSet. No free browsing.
//   • RESTRICTED interaction — пока режим включён (isGameModeActive()),
//     клик-хендлер Explorer'а (events.js) отдаёт каждый клик по узлу игровому
//     роутеру вместо своего expand/select, так что клик — это игровой ход
//     (добавить хоп / сменить фокус / дойти до цели), а не Explorer-expand.
//   • Explorer-only chrome (search rail, compare, bubble-sets, sidebar) is not
//     shown on the game surface.
//
// [SF-GAME-31 / ADR-0008] Сам переход в режим (переезд #network в игровую
// колонку и обратно, ограничение клика) этот модуль больше НЕ делает руками:
// им владеет vis-adapter/game-mode.js — enterGameMode/exitGameMode. Здесь
// осталась только игровая часть: построить граф партии, раскрасить роли и
// нарисовать кольца. Раньше эти две вещи были перемешаны в одном файле, а
// режим включался дописыванием свойств на глобальный State.
//
// Exports: renderBoard (≈drawChain), zoom/fit, mount/unmount — сигнатуры
// прежние, чтобы call sites игры не менялись.
// ════════════════════════════════════════════════════════════════════════════
import { State, MOTION, visAnimation } from "../state/state.js";
import { replaceGraph } from "../graph.js";
import { enterGameMode, exitGameMode, isGameModeActive, applyGameEngineOptions } from "../vis-adapter/game-mode.js";
import { webEdges } from "./connect-model.js";
// [SF-GAME-40] Детерминированный коридор — единственный источник координат
// игрового графа. См. шапку game-layout.js: шесть инвариантов, из которых
// первый («позиция закоммиченного узла назначается один раз») и есть причина,
// по которой граф больше не может дёрнуться при ходе.
import { computeGameLayout, layoutBounds } from "./game-layout.js";
// [SF-GAME-58] Тот же радиус, которым Explorer рисует обычный лист, и та же
// константа, от которой считается MIN_SEP в солвере — то есть коридор и
// узлы меряются одним числом, а не двумя похожими.
import { FIXED_NODE_RADIUS } from "../vis-adapter/visuals.js";

let _cbs = {};
let _byId = new Map();           // numeric id -> { name, kind, neighbour? }
let _ringNet = null;             // network instance our ring hook is attached to
let _lastGame = null;            // for the ring hook to know focus/goal names

// [SF-GAME-54] getComputedStyle — это принудительный пересчёт стилей, а tok()
// зовётся по 5-6 раз на каждую отрисовку оверлея и тинт ролей. Держим ОДИН
// живой объект стилей на модуль: он живой, значения читаются актуальные (в том
// числе после смены темы), но вызова getComputedStyle на каждый токен больше
// нет.
let _rootStyle = null;
function tok(name, fallback) {
  if (!_rootStyle) _rootStyle = getComputedStyle(document.documentElement);
  const v = _rootStyle.getPropertyValue(name).trim();
  return v || fallback;
}
function rgba(hex, a) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return `rgba(94,230,197,${a})`;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// [SF-GAME-34 / ADR-0009] synthId() удалён. Раньше имя без разрешённого id
// получало детерминированный ОТРИЦАТЕЛЬНЫЙ хэш-id, чтобы «хоть как-то»
// нарисоваться до резолва — и в игровом состоянии сосуществовали настоящие и
// выдуманные id, которые нельзя было ни сравнивать, ни отправлять на бэк.
// Теперь каноничный ключ один: реальный Genius id. Имя без него просто не
// попадает в граф (см. idOf ниже), а вью показывает честное состояние вместо
// фейкового узла.

// ── Вход/выход: тонкие обёртки над контрактом режима ─────────────────────────
// Переезд #network, запоминание homeParent, установка роутера клика и очистка
// графа на выходе — всё это теперь делает game-mode.js. Здесь остаётся только
// то, что принадлежит доске: чем роутить клик и сброс локальных кэшей.
export function mountBoard(container) {
  enterGameMode({ container, onNodeClick: handleClick });
}

export function unmountBoard() {
  _wasOver = false;
  exitGameMode();
  _byId = new Map();
  _lastGame = null;
  _lastSig = "";
}

// ── Click routing (called by events.js while in game mode) ────────────────────
function handleClick(params) {
  const id = params?.nodes?.[0];
  if (id == null) return;
  const info = _byId.get(id);
  if (!info) return;
  if (info.kind === "goalTarget") { _cbs.onReachGoal && _cbs.onReachGoal(); return; }
  if (info.kind === "neighbour")  { info.neighbour && _cbs.onPick && _cbs.onPick(info.neighbour); return; }
  // start / goal / hop — a node already on the web: re-focus there.
  _cbs.onFocus && _cbs.onFocus(info.name);
}

// ── Build a graph-response-shaped object from the game state ──────────────────
// nodes/edges are id-based (real ids where resolved, synthetic otherwise), so
// the real replaceGraph() pipeline renders them exactly like an Explorer graph.
function buildGraph(game, photos, ids, frontier) {
  // [ADR-0009] Только реальный id. null = имя ещё не разрешено (или не
  // разрешается вовсе) — такой узел не рисуется, вместо него вью показывает
  // честное состояние. Никаких выдуманных id.
  const idOf = name => (ids ? ids[name] : null) ?? null;
  _byId = new Map();
  const nodes = [];
  const seen = new Set();
  const push = (name, kind, extra) => {
    const id = idOf(name);
    if (id == null) return null;          // нерешённое имя в граф не попадает
    if (seen.has(id)) return id;
    seen.add(id);
    nodes.push({ id, name, image: (photos && photos[name]) || undefined });
    _byId.set(id, { name, kind, ...(extra || {}) });
    return id;
  };

  (game.nodes || []).forEach(n => {
    const kind = n.name === game.start ? "start" : n.name === game.goal ? "goal" : "hop";
    push(n.name, kind);
  });

  // Ребро рисуется только когда ОБА его конца разрешены — иначе оно вело бы
  // в никуда.
  const edges = webEdges(game)
    .map(e => ({ from: idOf(e.from), to: idOf(e.to) }))
    .filter(e => e.from != null && e.to != null);

  // [SF-GAME-42] Цель как ПОЛЮС, без ребра-прицела.
  //
  // Раньше здесь в DataSet добавлялось ребро focus→goal («прицел»). Оно было
  // настоящим ребром, то есть пружиной для barnesHut — и именно оно стягивало
  // старт и цель вместе, из-за чего два полюса квеста всегда оказывались рядом
  // и коридор не читался. Прицел — это ПОДСКАЗКА, а не связь: он рисуется
  // пунктиром на оверлее (см. aimHook ниже, тот же beforeDrawing-шов, где уже
  // живут кольца), поэтому ни на что не влияет физически.
  const goalInWeb = (game.nodes || []).some(n => n.name === game.goal);
  if (!goalInWeb) push(game.goal, "goalTarget");

  // Dandelion: the focus's real collaborators (already filtered by the caller).
  //
  // [SF-GAME-52] Партия окончена — одуванчика нет. Раньше после победы (и
  // после «сдаюсь») на доске оставались висеть восемь кандидатов следующего
  // хода, которого уже не будет: они забирали себе весь кадр, тогда как
  // смотреть в этот момент нужно на ПРОЙДЕННУЮ линию и на два полюса. На
  // скриншоте с PAR 1 это выглядело особенно нелепо — цель уже достигнута и
  // стоит в соседней колонке, а вокруг неё веер из восьми чужих узлов.
  const over = game.completed === true || game.gaveUp === true;
  if (!over && frontier && !frontier.loading && !frontier.unavailable && Array.isArray(frontier.neighbours)) {
    const inWeb = new Set((game.nodes || []).map(n => n.name.toLowerCase()));
    frontier.neighbours
      .filter(n => !inWeb.has(n.name.toLowerCase()) && n.name.toLowerCase() !== (game.goal || "").toLowerCase())
      // [SF-GAME-48] 8, а не 12. Одуванчик — это МЕНЮ следующего шага, и оно
      // должно помещаться в одну колонку коридора: 12 кандидатов требуют трёх
      // колец, третье уезжает почти на две колонки вперёд и узел глубины 1
      // начинает выглядеть узлом глубины 2 (ось X в этой раскладке означает
      // прогресс — см. game-layout.js). 8 укладываются в два кольца и живут в
      // своей колонке. Полный список никуда не делся: он рядом, в панели
      // «Or browse … real collaborators», и в автокомплите «Add next».
      .slice(0, 8)
      .forEach(n => {
        if (seen.has(n.id)) return;
        seen.add(n.id);
        nodes.push({ id: n.id, name: n.name, image: n.image || undefined });
        _byId.set(n.id, { name: n.name, kind: "neighbour", neighbour: n });
        if (game.focus) edges.push({ from: idOf(game.focus), to: n.id });
      });
  }

  return { seed: game.start, seed_id: idOf(game.start), nodes, edges, truncated: false };
}

// ── [SF-GAME-40] Применение коридора к живому графу ──────────────────────────
// vis-adapter/graph.js::buildNodeState не пропускает x/y (он собирает узел по
// своей форме), поэтому координаты ставим ЯВНО после replaceGraph, а не
// смуглируем через объект графа. Заодно fixed/physics:false — узел стоит там,
// куда его поставила раскладка, и ничем не притягивается: движок остаётся тем
// же самым, но в игре он больше не решает, где чему быть.
let _lastLayout = null;

// [SF-GAME-48] Раскладка обязана веерить РОВНО ТЕ узлы, что попали на доску.
// Раньше buildGraph фильтровал и резал одуванчик до N, а computeGameLayout
// получал СЫРОЙ frontier — и раскладывал все 13 соседей по четырём кольцам,
// тогда как рисовались 8 из них. Кандидаты оказывались в кольцах 0..3 вразброс,
// и на экране это выглядело сыпью вокруг фокуса вместо аккуратной колонки.
// Теперь источник один: _byId, который buildGraph только что и наполнил
// (порядок вставки = порядок после фильтра и среза).
function boardFan() {
  const neighbours = [];
  _byId.forEach((info, id) => { if (info.kind === "neighbour") neighbours.push({ id, name: info.name }); });
  return { loading: false, neighbours };
}

function applyLayout(game, par) {
  const layout = computeGameLayout(game, { par, frontier: boardFan() });
  _lastLayout = layout;
  if (!State.nodesDS) return layout;

  const idByName = new Map();
  _byId.forEach((info, id) => idByName.set(info.name, id));

  // [SF-GAME-58] У ВСЕХ игровых узлов один размер.
  //
  // Конвейер Explorer'а делит узлы на хабы (сид/развёрнутые — HUB_RADIUS 36) и
  // листья (FIXED_NODE_RADIUS 22), потому что там размер несёт смысл: хаб —
  // это точка, из которой растёт окрестность. В игре такого смысла нет: старт
  // — не «главный» артист, а просто один конец пары, и раздутый вдвое узел
  // читался как «этот важнее», хотя важна только цель. Роли в игре кодируются
  // ЦВЕТОМ кольца (--signal старт, --amber хоп, --pulse цель, --paper фокус),
  // и этого достаточно.
  const updates = [];
  const place = (name, pos) => {
    const id = idByName.get(name);
    if (id == null || !pos) return;
    updates.push({
      id, x: Math.round(pos.x), y: Math.round(pos.y), fixed: true, physics: false,
      size: FIXED_NODE_RADIUS,
    });
  };

  layout.positions.forEach((pos, name) => place(name, pos));
  layout.frontier.forEach((pos, name) => place(name, pos));
  // Цель, ещё не достигнутая, — полюс: её нет в дереве, координата своя.
  if (!layout.positions.has(game.goal)) place(game.goal, layout.goal);

  try {
    if (updates.length) State.nodesDS.update(updates);
    // moveNode ставит узел мгновенно, без физического «доезда» — иначе первый
    // кадр после replaceGraph показал бы узлы в стартовых нулях и они бы
    // поехали на места, что и читается как дёрганье.
    if (State.network && typeof State.network.moveNode === "function") {
      updates.forEach(u => { try { State.network.moveNode(u.id, u.x, u.y); } catch { /* ещё не в сети */ } });
    }
  } catch { /* DataSet not ready */ }
  return layout;
}

// Post-render tint so the game roles read on the real engine: goal = pulse,
// focus = white ring, dandelion = dim. Start is already the seed (signal-hero).
function tintRoles(game) {
  if (!State.nodesDS) return;
  const RING  = 3;                       // одна толщина кольца на все роли
  const signal = tok("--signal", "#5EE6C5");
  const pulse = tok("--pulse", "#B98AFF");
  const amber = tok("--amber", "#FFD27A");
  const paper = tok("--paper", "#EDEFF4");
  const mist  = tok("--mist",  "#8A94A6");
  const panel = tok("--panel", "#141A28");
  const updates = [];
  _byId.forEach((info, id) => {
    // [SF-GAME-58] Толщина кольца тоже одна на всех (кроме приглушённых
    // кандидатов): раньше фокус получал borderWidth 5 против 3 у остальных и
    // визуально «толстел» — та же подмена размера смыслом, что и с сидом.
    if (info.kind === "goal" || info.kind === "goalTarget") {
      updates.push({ id, color: { border: pulse, background: panel }, borderWidth: RING });
    } else if (info.kind === "hop") {
      updates.push({ id, color: { border: amber, background: panel }, borderWidth: RING });
    } else if (info.kind === "neighbour") {
      updates.push({ id, color: { border: mist, background: panel }, borderWidth: RING, opacity: 0.75 });
    } else {
      updates.push({ id, color: { border: signal, background: panel }, borderWidth: RING });
    }
    if (game.focus && info.name === game.focus && info.kind !== "goalTarget") {
      updates.push({ id, color: { border: paper, background: panel }, borderWidth: RING, opacity: 1 });
    }
  });
  try { if (updates.length) State.nodesDS.update(updates); } catch { /* DataSet not ready */ }
}

// Animated focus + goal rings, drawn on the real network's own canvas overlay
// (the same beforeDrawing seam the Explorer uses for its ring-guides).
function ringHook(ctx) {
  if (!State.network || !_lastGame) return;
  const draw = (name, color) => {
    let id = null;
    _byId.forEach((info, nid) => { if (info.name === name) id = nid; });
    if (id == null) return;
    let pos; try { pos = State.network.getPositions([id])[id]; } catch { return; }
    if (!pos) return;
    ctx.save();
    for (let k = 0; k < 2; k++) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 30 + k * 11, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(color, 0.4 - k * 0.16);
      ctx.lineWidth = 2; ctx.setLineDash([4, 6]); ctx.stroke();
    }
    ctx.restore();
  };
  if (!(_lastGame.nodes || []).some(n => n.name === _lastGame.goal)) draw(_lastGame.goal, tok("--pulse", "#B98AFF"));
  drawAim(ctx);
}

// [SF-GAME-55] Ховера на канве НЕТ ВООБЩЕ — ни подсветки, ни кольца.
//
// Третий заход на «граф дёргается от мышки», и на этот раз замерено то, что
// нужно было мерить с самого начала: сколько раз перерисовывается КАНВА за
// один проход курсора. Было 19 полных перерисовок на один проход сквозь веер
// — по одной на каждый переход hover/blur, и каждая заново рисует ВСЕ узлы,
// включая circularImage с реальными фотографиями. Частота кадров при этом
// честные 60fps (мерил), поэтому предыдущие два захода мимо и стреляли:
// дёргается не пейсинг, дёргаются сами узлы, которых пере-рисовывают под
// курсором.
//
// Кольцо ховера рисовалось на той же канве, поэтому и требовало redraw() на
// каждый переход — то есть лекарство и было болезнью. Убрано целиком.
// Наведение обозначает курсор (events.js ставит pointer), а что узел
// кликабелен, видно и так: в игре кликабельно всё, что нарисовано.
// Теперь движение мыши над доской не вызывает НИ ОДНОЙ перерисовки.

// [SF-GAME-42] Прицел: пунктир от фокуса к ещё не достигнутой цели. Рисуется
// НА ОВЕРЛЕЕ, а не ребром в DataSet — см. buildGraph выше. Показывает
// направление и остаток пути, но не участвует в физике и не стягивает полюса.
function drawAim(ctx) {
  if (!_lastLayout || !_lastGame) return;
  const goalName = _lastGame.goal, focus = _lastGame.focus;
  if (!goalName || !focus) return;
  if (_lastLayout.positions.has(goalName)) return;    // цель достигнута — прицел не нужен
  const from = _lastLayout.positions.get(focus);
  const to = _lastLayout.goal;
  if (!from || !to) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.strokeStyle = rgba(tok("--pulse", "#B98AFF"), 0.22);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([2, 10]);
  ctx.stroke();
  ctx.restore();
}

// [SF-GAME-54] Кольца СТАТИЧНЫЕ, и цикла кадров у доски нет.
//
// История в два шага, и оба замерены.
// (1) Кольца пульсировали от performance.now(), но beforeDrawing зовётся
//     только когда vis перерисовывает канву, а физика в игре выключена — то
//     есть перерисовка шла исключительно по вводу. Анимацию перематывал
//     курсор: два кадра при неподвижной мыши были байт в байт одинаковы, а
//     любое движение швыряло кольцо в новую фазу.
// (2) Починка «дать доске свой rAF-цикл» оказалась хуже болезни: цикл дёргает
//     network.redraw() на КАЖДЫЙ кадр, а это полная перерисовка графа с
//     circularImage-нодами. Замер на живой странице: медиана кадра 33мс
//     (30fps), p95 50мс, макс 117мс — то есть вместо ровного движения
//     получилась рваная картинка, и дёрганье стало заметнее прежнего.
//
// Правильный вывод из обоих замеров: канва — неподходящее место для ambient-
// анимации. Кольца рисуются статикой (ноль кадров на покое), а «живость»
// экрана делает CSS на DOM-слое — HUD, панель, строки линии (connect.css,
// блок движения), где она стоит ровно ничего.

function ensureRingHook() {
  if (State.network && _ringNet !== State.network) {
    try {
      State.network.on("beforeDrawing", ringHook);
      // [SF-GAME-55] Тот же шов: сеть только что пересоздана replaceGraph'ом
      // с дефолтными опциями, значит игровые ограничения надо наложить заново.
      applyGameEngineOptions();
      _ringNet = State.network;
    } catch { /* not up */ }
  }
}

// ── Public render (≈ drawChain) ───────────────────────────────────────────────
let _lastSig = "";
let _wasOver = false;   // [SF-GAME-52] чтобы поймать МОМЕНТ окончания партии, а не факт
export function renderBoard(game, photos, frontier, ids, callbacks, opts = {}) {
  _cbs = callbacks || {};
  if (!isGameModeActive()) return;   // only draws while mounted in game mode
  if (!game) { _lastGame = null; _lastSig = ""; _lastLayout = null; return; }
  _lastGame = game;
  const graph = buildGraph(game, photos, ids, frontier);  // also refreshes _byId
  // [SF-GAME-34] Ни одного разрешённого узла — рисовать нечего. Раньше сюда
  // никогда не попадали: любое имя получало синтетический id. Теперь это
  // нормальное промежуточное состояние (резолв ещё летит) либо честный отказ
  // (имя не разрешается) — в обоих случаях отдаём кадр вью, а не рисуем
  // пустой/сломанный граф.
  if (!graph.nodes.length) { _lastSig = ""; return; }
  // [fix: дёрганье/релэйаут] Only re-run the real engine's full layout when the
  // NODE SET actually changed (a hop added, the dandelion refreshed). A purely
  // cosmetic change (re-focus, tint) keeps the exact same nodes + positions, so
  // just re-tint — the graph never jumps or re-lays-out on every render.
  const sig = graph.nodes.map(n => n.id).sort((a, b) => a - b).join(",");
  if (sig === _lastSig && State.nodesDS && State.nodesDS.length > 0) {
    // Набор узлов тот же — сменился только фокус/раскраска. Раскладку всё
    // равно применяем: она чистая функция от партии и на неизменном наборе
    // даст ровно те же координаты (инвариант 1), то есть это no-op по
    // движению, но гарантия, что позиции не «уплыли» от чужого касания.
    applyLayout(game, opts.par ?? null);
    tintRoles(game);
    return;
  }
  // [SF-GAME-52] Партия только что закончилась — пересобираем кадр под то, что
  // осталось. Одуванчик из восьми узлов ушёл (см. buildGraph), и без ре-фита
  // камера продолжала бы держать масштаб под него: финальная линия оставалась
  // бы двумя точками в углу пустой сцены вместо того, чтобы занять экран.
  const over = game.completed === true || game.gaveUp === true;
  const justFinished = over && !_wasOver;
  _wasOver = over;
  // [SF-GAME-56] Камеру двигаем ОСОЗНАННО и редко: первый кадр партии и
  // финал. Раньше её на каждый ход таскал fit из конвейера Explorer'а (см.
  // render.js) — 22 положения камеры за один ход. Промежуточные ходы камеру
  // не трогают: коридор растёт вправо предсказуемо, а если игрок уехал —
  // рядом кнопка fit в рейле графа.
  const firstFrame = !_lastSig;

  _lastSig = sig;
  try {
    replaceGraph(graph);
  } catch { return; }
  // [SF-GAME-40] Координаты — ПОСЛЕ replaceGraph и ДО первого тинта: движок
  // уже собрал узлы, но мы ставим их на места коридора прежде, чем кадр уйдёт
  // на экран.
  applyLayout(game, opts.par ?? null);
  tintRoles(game);
  ensureRingHook();
  if (justFinished || firstFrame || outOfView()) fitBoard();
}

// [SF-GAME-43] Камера ходит по общим motion-токенам (visAnimation читает
// --duration-* и сам уважает prefers-reduced-motion + масштаб), а не по
// литералам 200/220мс, которые здесь стояли мимо всей шкалы.
// [SF-GAME-57] Камера стоит на месте, ПОКА доска помещается в кадр.
//
// Убрав fit с каждого хода (см. render.js), мы убрали и дёрганье, и слежение:
// коридор растёт вправо и рано или поздно уезжает за край — на скриншоте цель
// уже срезало правым бортом. Возвращать fit на каждый ход нельзя, это и была
// болезнь. Поэтому проверяем факт: видно ли ВСЮ раскладку. Пока видно —
// камеру не трогаем вообще; как только край вышел за кадр — один осознанный
// fit. На типичной партии это одно-два движения камеры вместо одного на ход.
const VIEW_MARGIN = 40;   // мир-единицы: не ждём, пока узел прилипнет к борту

function outOfView() {
  if (!State.network || !_lastLayout) return false;
  try {
    // Публичное DOMtoCanvas вместо ручной арифметики по canvas.width/scale:
    // у vis это внутреннее поле в device-пикселях, и ручной пересчёт молча
    // давал NaN (сравнения с NaN — всегда false, то есть проверка «всё
    // видно» отвечала «да» вообще всегда, и цель продолжала уезжать за борт).
    const c = State.network.canvas?.frame?.canvas;
    if (!c) return false;
    const tl = State.network.DOMtoCanvas({ x: 0, y: 0 });
    const br = State.network.DOMtoCanvas({ x: c.clientWidth, y: c.clientHeight });
    const b  = layoutBounds(_lastLayout);
    return b.minX < tl.x + VIEW_MARGIN || b.maxX > br.x - VIEW_MARGIN
        || b.minY < tl.y + VIEW_MARGIN || b.maxY > br.y - VIEW_MARGIN;
  } catch { return false; }
}

export function zoomBoard(factor) {
  if (!State.network) return;
  try {
    State.network.moveTo({ scale: State.network.getScale() * factor, animation: visAnimation(MOTION.camera) });
  } catch { /* */ }
}
export function fitBoard() {
  if (State.network) { try { State.network.fit({ animation: visAnimation(MOTION.camera) }); } catch { /* */ } }
}
