// ════════════════════════════════════════════════════════════════════════════
// game/game-layout.js — [SF-GAME-40] Детерминированная раскладка игрового
// графа. Чистая функция: (партия, PAR, фронтир) → координаты. Ни vis, ни DOM,
// ни State — поэтому её можно и нужно тестировать целиком.
//
// ── Почему отдельно от vis-adapter/layout.js ─────────────────────────────────
// Раскладка Explorer'а решает другую задачу: «разложи окрестность сида так,
// чтобы ничего не налезало» — центр один, направления равноправны, порядок
// узлов не несёт смысла. У игры смысл ровно в порядке: есть НАЧАЛО, есть ЦЕЛЬ,
// и есть путь между ними, который игрок достраивает. Поэтому здесь не силовая
// раскладка и не одуванчик вокруг центра, а «коридор».
//
// ── Модель: коридор с полосами ───────────────────────────────────────────────
//   X — прогресс.  x = startX + depth * COL_STEP, depth = число хопов от старта.
//                  Цель стоит на x = startX + max(PAR, maxDepth+1) * COL_STEP,
//                  то есть коридор сразу нужной длины (PAR известен из
//                  челленджа) и удлиняется ТОЛЬКО когда игрок превысил идеал —
//                  осмысленное движение «ты сделал крюк», а не случайный сдвиг.
//   Y — ветка.     y = lane * LANE_STEP. Полосу ветка получает при рождении и
//                  больше не меняет.
//
// ── Шесть инвариантов (это и есть «правила игрового графа») ──────────────────
//   1. Позиция ЗАКОММИЧЕННОГО узла назначается один раз и не меняется никогда.
//      Отсюда следует, что граф не может «дёрнуться» при ходе: добавление узла
//      физически не способно сдвинуть существующие.
//   2. Полюса (старт/цель) закреплены и лежат на центральной полосе (y=0), так
//      что коридор читается прямым.
//   3. goalX зависит только от max(PAR, maxDepth+1) — монотонно растёт, никогда
//      не «дышит» туда-сюда.
//   4. Первый ребёнок наследует полосу родителя; каждая следующая ветка
//      получает новую, чередуясь наружу: +1, −1, +2, −2 … Активная линия
//      остаётся по центру, ветки расходятся симметрично.
//   5. Полосы выдаются по порядку появления в game.nodes (массив только
//      дописывается), поэтому НОВАЯ ВЕТКА НЕ СДВИГАЕТ НИ ОДНОГО существующего
//      узла. Пересчёт с нуля даёт тот же результат — раскладка чистая функция
//      от партии, а не накопленное состояние.
//   6. Одуванчик (кандидаты вокруг фокуса) НЕ закоммичен: он живёт в колонке
//      depth(focus)+1 и перерисовывается свободно, не влияя на правила 1–5.
//
// Смена фокуса раскладку не трогает вовсе — только подсветку и одуванчик.
// ════════════════════════════════════════════════════════════════════════════

// Шаг колонки/полосы считаем от той же MIN_SEP, которой меряется «две ноды не
// налезают» в Explorer'е (vis-adapter/layout.js) — чтобы игровой коридор жил в
// той же метрике, что и остальной граф, а не в своих произвольных пикселях.
import { MIN_SEP, resolveCollisions } from "../vis-adapter/layout.js";

// Колонка шире полосы: по X узлы соединены рёбрами (нужно место под линию и
// подпись), по Y они просто соседи.
export const COL_STEP  = Math.round(MIN_SEP * 2.4);   // ≈187px между глубинами
export const LANE_STEP = Math.round(MIN_SEP * 1.5);   // ≈117px между ветками
export const START_X   = 0;

// Минимальная длина коридора, когда PAR ещё не приехал с бэка. 2 — потому что
// челлендж из одного хопа вырожден (старт и цель соседи), а коридор в одну
// колонку не читается как коридор.
const MIN_CORRIDOR = 2;

// ── Дерево партии ────────────────────────────────────────────────────────────

// depth каждого узла (число хопов от старта) + порядок обхода.
// game.nodes — плоский список { name, parent }, корень с parent === null.
function depthsOf(game) {
  const byName = new Map((game.nodes || []).map(n => [n.name, n]));
  const depth = new Map();
  const resolve = (name, guard = 0) => {
    if (depth.has(name)) return depth.get(name);
    const node = byName.get(name);
    // Сирота или цикл (не должно случаться, но раскладка не имеет права
    // падать из-за испорченной партии) — считаем корнем.
    if (!node || node.parent == null || guard > 512) { depth.set(name, 0); return 0; }
    const d = resolve(node.parent, guard + 1) + 1;
    depth.set(name, d);
    return d;
  };
  (game.nodes || []).forEach(n => resolve(n.name));
  return depth;
}

// Полоса каждого узла. Инвариант 4/5: первый ребёнок наследует полосу
// родителя, каждый следующий открывает новую ветку и получает свободную
// полосу, чередуясь наружу от центра.
function lanesOf(game) {
  const lane = new Map();
  const childCount = new Map();   // сколько детей уже роздано у родителя
  const used = new Set([0]);      // занятые полосы (0 — центральная, за стартом)

  // Следующая свободная полоса, чередуясь: +1, −1, +2, −2, …
  const nextLane = () => {
    for (let k = 1; k < 4096; k++) {
      if (!used.has(k))  { used.add(k);  return k; }
      if (!used.has(-k)) { used.add(-k); return -k; }
    }
    return 0;
  };

  (game.nodes || []).forEach(n => {
    if (n.parent == null) { lane.set(n.name, 0); return; }
    const seen = childCount.get(n.parent) || 0;
    childCount.set(n.parent, seen + 1);
    // Первый ребёнок продолжает ветку родителя, остальные ветвятся.
    lane.set(n.name, seen === 0 ? (lane.get(n.parent) ?? 0) : nextLane());
  });

  return lane;
}

// ── Публичная раскладка ──────────────────────────────────────────────────────

/**
 * @param {object} game     партия (connect-model.js)
 * @param {object} opts
 * @param {number|null} opts.par        optimal_len челленджа, если известен
 * @param {object|null} opts.frontier   { neighbours: [{id,name}] } вокруг фокуса
 * @returns {{
 *   positions: Map<string,{x:number,y:number}>,  закоммиченные узлы (по имени)
 *   frontier:  Map<string,{x:number,y:number}>,  кандидаты (по имени)
 *   poles:     { startX:number, goalX:number },
 *   goal:      {x:number,y:number},
 *   depth:     Map<string,number>,
 *   lane:      Map<string,number>,
 * }}
 */
export function computeGameLayout(game, { par = null, frontier = null } = {}) {
  const empty = {
    positions: new Map(), frontier: new Map(),
    poles: { startX: START_X, goalX: START_X + MIN_CORRIDOR * COL_STEP },
    goal: { x: START_X + MIN_CORRIDOR * COL_STEP, y: 0 },
    depth: new Map(), lane: new Map(),
  };
  if (!game || !Array.isArray(game.nodes) || !game.nodes.length) return empty;

  const depth = depthsOf(game);
  const lane  = lanesOf(game);

  const positions = new Map();
  game.nodes.forEach(n => {
    positions.set(n.name, {
      x: START_X + (depth.get(n.name) ?? 0) * COL_STEP,
      y: (lane.get(n.name) ?? 0) * LANE_STEP,
    });
  });

  // Инвариант 3: коридор длиной max(PAR, самая глубокая ветка + 2). Растёт
  // монотонно, никогда не сжимается по ходу партии.
  //
  // [SF-GAME-48] Было maxDepth + 1 — то есть цель могла встать ровно в ту
  // колонку, куда веером ложится фронтир. На живой странице так и вышло:
  // после двух ходов (PAR 3) полюс цели оказывался ВНУТРИ облака кандидатов,
  // и «два полюса» — главная читаемая идея экрана — рассыпались в кашу.
  // Запас в две колонки держит цель отдельным полюсом при любом фронтире.
  // Считаем именно от maxDepth (он только растёт), а не от глубины фокуса:
  // фокус игрок может увести назад, и цель бы поехала обратно, сломав
  // монотонность.
  let maxDepth = 0;
  depth.forEach(d => { if (d > maxDepth) maxDepth = d; });
  const goalReached = positions.has(game.goal);
  const span = Math.max(MIN_CORRIDOR, par || 0, goalReached ? maxDepth : maxDepth + 2);
  const goalX = START_X + span * COL_STEP;

  // Цель — полюс на центральной полосе. Если игрок её уже достиг, она узел
  // дерева как все остальные, и её позиция уже посчитана выше: сдвигать её
  // «на полюс» значило бы нарушить инвариант 1.
  const goal = goalReached
    ? positions.get(game.goal)
    : { x: goalX, y: 0 };

  const fan = placeFrontier(game, frontier, positions);

  // [ГАРАНТИЯ, а не «по построению»] Committed-узлы стоят по инвариантам 1–5 и
  // не пересекаются между собой. Но веер кандидатов строится ОТНОСИТЕЛЬНО
  // фокуса и ничего не знает про соседние ветки — он может налезть на чужой
  // узел. Прогоняем его через тот же солвер, которым Explorer разводит свои
  // одуванчики (vis-adapter/layout.js): committed-узлы и полюса приколоты
  // (инвариант 1 неприкосновенен), двигается только фронтир — он и так не
  // обязан быть стабильным между кадрами (инвариант 6).
  if (fan.size) {
    const pinned = new Map(positions);
    if (!positions.has(game.goal)) pinned.set(game.goal, goal);
    resolveCollisions(fan, new Set(), pinned);
  }

  return {
    positions,
    frontier: fan,
    poles: { startX: START_X, goalX },
    goal,
    depth, lane,
  };
}

// Инвариант 6: кандидаты — компактный ВЕЕР вокруг фокуса, развёрнутый в
// сторону цели.
//
// [ИСПРАВЛЕНО] Первая версия ставила их в одну КОЛОНКУ (x = колонка фокуса+1,
// y = фокус + i·LANE_STEP). Замер показал, во что это выливается: 12
// кандидатов давали бокс 374×1287, соотношение сторон 0.29 — вертикальное
// веретено. Геометрического наложения не было (соседи ровно на LANE_STEP), но
// fit-камера ужимала такой бокс по высоте, и на экране всё схлопывалось в
// нитку из слипшихся точек. Это и был «кошмарный лэйаут»: провал не в
// ветвлении committed-узлов (там инварианты держатся), а именно в том, как
// раскладывался фронтир.
//
// Теперь дуга: радиус растёт от числа кандидатов ровно настолько, чтобы
// расстояние по дуге между соседями было ≥ MIN_SEP, а при большом числе
// кандидатов веер разбивается на кольца — тот же приём, которым
// vis-adapter/layout.js разводит одуванчики Explorer'а, вместо изобретения
// третьего способа.
//
// [ИСПРАВЛЕНО ДВАЖДЫ] Первая дуга была слишком широкой: полуугол ±66° при
// семи кандидатах в кольце означал, что крайние узлы уезжают почти строго
// вверх и вниз от фокуса (cos 1.15 ≈ 0.41 — вперёд они не двигались почти
// никак). На экране это читалось не как «следующий шаг коридора», а как
// паучий одуванчик поперёк него: замер на живой странице дал веер высотой
// 465px при продвижении вперёд всего на 276px, и вся композиция висла слева,
// пока цель одиноко стояла справа.
//
// Отсюда два правила, и оба про то, что веер обязан ЧИТАТЬСЯ КАК КОЛОНКА:
//   • полуугол ограничен ±34°: кандидат всегда заметно ближе к цели, чем
//     фокус, а не «сбоку» от него (cos 0.6 ≈ 0.83);
//   • в кольце не больше четырёх — дальше открывается следующее кольцо, а не
//     распахивается угол. Кольца дешевле: они растут по X (в сторону цели),
//     а раскрытие угла растёт по Y (поперёк коридора).
// Кольца балансируются по размеру, чтобы в последнем не оставался одинокий
// узел.
const FAN_SPREAD = 0.6;             // рад (±34°) — полуугол веера от направления на цель
const FAN_RING_CAPACITY = 4;        // больше — открывается следующее кольцо

function placeFrontier(game, frontier, positions) {
  const out = new Map();
  const list = frontier && !frontier.loading && !frontier.unavailable && Array.isArray(frontier.neighbours)
    ? frontier.neighbours : [];
  if (!list.length) return out;

  const focus = game.focus;
  const focusPos = positions.get(focus);
  if (!focusPos) return out;

  // Веер разворачивается «вперёд», к следующей колонке — то есть к цели.
  // Базовый угол 0 (вправо по оси X) совпадает с направлением коридора.
  const ringCount = Math.max(1, Math.ceil(list.length / FAN_RING_CAPACITY));
  const perRing   = Math.ceil(list.length / ringCount);
  const rings = [];
  for (let i = 0; i < list.length; i += perRing) rings.push(list.slice(i, i + perRing));

  let prevR = 0;
  rings.forEach((ring, ringIndex) => {
    const n = ring.length;
    // Нечётные кольца делят сектор на n частей вместо n−1: их узлы садятся в
    // «промежутки» предыдущего кольца, а не строго за ним. Важно, что это
    // делается СУЖЕНИЕМ шага, а не поворотом всего кольца: поворот выносил
    // крайний узел за потолок ±FAN_SPREAD, то есть ровно туда, откуда мы
    // веер и убирали.
    const denom = (ringIndex % 2) ? n : n - 1;
    const step = n > 1 ? (2 * FAN_SPREAD) / denom : 0;
    // Радиус: не меньше колонки (иначе кандидаты налезут на сам фокус) и
    // достаточный, чтобы ХОРДА между соседями была ≥ MIN_SEP — точная
    // формула хорды, а не приближение длиной дуги. Плюс монотонность: каждое
    // следующее кольцо минимум на MIN_SEP дальше предыдущего.
    const needed = step > 0 ? MIN_SEP / (2 * Math.sin(step / 2)) : 0;
    const r = Math.max(COL_STEP * 0.9, needed, prevR + MIN_SEP);
    prevR = r;
    const mid = (n - 1) / 2;
    ring.forEach((cand, i) => {
      const angle = (i - mid) * step;
      out.set(cand.name, {
        x: focusPos.x + r * Math.cos(angle),
        y: focusPos.y + r * Math.sin(angle),
      });
    });
  });
  return out;
}

// Ширина/высота занятой коридором области — для fit-камеры, чтобы она не
// считала bbox по «сырым» позициям vis и не дёргалась вместе с одуванчиком.
export function layoutBounds(layout) {
  let minX = layout.poles.startX, maxX = layout.poles.goalX;
  let minY = 0, maxY = 0;
  const eat = pos => {
    if (pos.x < minX) minX = pos.x;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.y > maxY) maxY = pos.y;
  };
  layout.positions.forEach(eat);
  layout.frontier.forEach(eat);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}
