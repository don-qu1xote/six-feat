// ═══════════════════════════════════════════════════════════════════════════
// vis-adapter/layout.js — collision-aware deterministic placement engine for
//                         the graph («одуванчики» + «круги Эйлера» for expand,
//                         linear placement for six-degrees paths). Pure
//                         position calculators: given current graph/expand
//                         state, produce target and starting {x,y} positions
//                         — no vis.js network mutation here (see
//                         physics.js::mergeNetwork / render.js for how
//                         targets/fromPos get applied + animated).
//
//  Настраивается несколькими числами (все расстояния выводятся из MIN_SEP):
//    MIN_SEP    — минимальная дистанция центр-в-центр любой пары нод (px)
//    LEAF_R     — радиус первого кольца листьев (px)
//    LEAF_GAP   — шаг между кольцами листьев (px)
//    clusterGap(dR, sharedCount) — зазор между одуванчиками/линзами соседних
//      полюсов (px); растёт и с dR, и с числом общих участников (SF-WEB-56)
//
//  Публичные функции:
//    placeExpandedNodes(savedPositions) → {targets, fromPos, edgeClass}
//      (инициал + expand; edgeClass — [SF-WEB-55] intra/cross-классификация
//      рёбер + хаб пары секторов, потребитель — vis-adapter/edge-render.js)
//    placePathNodes(path, savedPositions) → {targets, fromPos}
//    resolveCollisions(targets, pinnedIds, extraPinned)       (общий солвер)
//    mergeNetwork/refreshNetwork/initNetwork используют targets как финальные
//    (не пересекающиеся) позиции — физика больше НЕ основной решатель раскладки.
//
// [SF-WEB-51] (поглощает SF-WEB-29) Наложения нод — корневой дефект
// раскладки. Гибрид: (1) ЕДИНАЯ метрика MIN_SEP для ёмкости колец, зазоров
// полюсов/линз И солвера; (2) детерминированное размещение (тот же движок
// для инициала и expand — refreshNetwork больше не physics-only); (3)
// глобальный collision-solver на равномерной сетке даёт ГАРАНТИЮ отсутствия
// наложений, которой физика не давала; (4) физика демотирована до
// опционального органик-доводчика (см. visuals.js networkOptions / render.js).
// ═══════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { FIXED_NODE_RADIUS } from "./visuals.js";

// [SF-WEB-51] ЕДИНАЯ метрика размера. Все ноды фиксированного радиуса R
// (FIXED_NODE_RADIUS, visuals.js). NODE_GAP — запас поверх диаметра под
// hover-обводку + антиалиасинг circularImage по краю. MIN_SEP —
// минимальная дистанция центр-в-центр, при которой две ноды визуально не
// касаются. ОДНО значение используется всюду: ёмкость кольца (_ringCap),
// зазор полюсов, зазор линзы, целевая дистанция глобального солвера И
// (через nodeVisual size) физический avoidOverlap — конец рассинхрону
// «NODE_W=78 для колец vs vis default size для физики». 2*22+34 = 78, т.е.
// численно то же, что прежний магический NODE_W — изменился только источник.
export const NODE_GAP = 34;
export const MIN_SEP  = 2 * FIXED_NODE_RADIUS + NODE_GAP; // 78
// [SF-WEB-29] Historical name — a lot of golden tests import NODE_W as "the
// min-separation threshold". It is now literally MIN_SEP (kept as an alias
// so those tests keep reading the single source of truth, not a duplicate).
export const NODE_W = MIN_SEP;

// [SF-WEB-29 follow-up] LEAF_R вернули к исходному 150 — с уменьшенным до 90
// смещение первого кольца от полюса/сида читалось слишком «оторванным»,
// одуванчик не воспринимался единым целым со своим центром. LEAF_GAP,
// наоборот, дополнительно уменьшен (было 120, затем 85) — межкольцевой шаг
// теперь ЗАЖИМАЕТСЯ снизу прямо в _adaptiveRingGap (см. ниже) на уровне
// MIN_SEP, а не просто "заметно больше" — так кольца становятся плотнее,
// читаются как единый элемент, но гарантия неперекрытия соседних колец не
// зависит от значения этой константы вообще: пол задаётся математически, а
// не подбором числа.
export const LEAF_R = 150;   // px: радиус первого кольца листьев
const LEAF_GAP      = 58;    // px: базовый шаг между кольцами (см. floor в _adaptiveRingGap)
// [SF-WEB-53/54/56] Зазор МЕЖДУ КЛАСТЕРАМИ (одуванчик-одуванчик, одуванчик-
// линза) — отдельная, заметно бОльшая величина, чем MIN_SEP. MIN_SEP — это
// порог нода-в-ноду ВНУТРИ одного кольца/облака (плотная упаковка листьев
// одного одуванчика); clusterGap() — зазор между КРАЯМИ соседних облаков
// целиком.
//
// Первая версия (SF-WEB-53) использовала фиксированную константу
// (MIN_SEP*2) — но на плотных графах (много полюсов делят узкие угловые
// клинья, см. placePole/fitR ниже) реальный тангенциальный зазор между
// соседними одуванчиками определяется НЕ этой константой вообще, а тем,
// насколько точно fitR подгоняет полюс под ширину его клина: при узком
// клине dR/sin(half) даёт РОВНО касание границ клина, без единого пикселя
// запаса. SF-WEB-54 сделала зазор пропорциональным dR (крупный кластер —
// шире просвет) — лучше, но всё ещё не решала главную причину «путаницы
// между блоками»: граница читается нечётко именно там, где МНОГО общих
// участников (Эйлеровы линзы) сходятся в одну зону — там гуще всего
// кросс-секторных рёбер (SF-WEB-55), и они визуально «склеивают» соседние
// кластеры в одно пятно, сколько бы просто-геометрического зазора там ни
// было. SF-WEB-56: зазор берёт МАКСИМУМ из трёх нижних оценок, включая
// новую — пропорциональную числу листьев, общих у узла с его родителем
// (sharedCountBetween, см. ниже, внутри placeExpandedNodes — данные по
// линзам известны только на конкретный граф, не константа уровня модуля).
// ОДНА формула для ОБОИХ случаев (родитель — сид ИЛИ другой полюс) —
// гарантирует, что зазор сид↔полюс и полюс↔полюс считаются одинаково.
const CLUSTER_GAP_FLOOR    = MIN_SEP * 4;    // px: минимум даже без общих участников
const CLUSTER_GAP_FRACTION = 0.45;           // доля от dR: крупный кластер — шире просвет
// [SF-WEB-56 follow-up] Первая версия росла ЛИНЕЙНО (sharedCount*39px) —
// на плотных реальных графах (десятки общих фичерящих у популярного
// артиста — обычное дело) это разгоняло зазор до тысяч пикселей, оставляя
// гигантские пустые дыры вместо «чуть заметнее раздвинутых» кластеров.
// sqrt(sharedCount) даёт УБЫВАЮЩУЮ отдачу (разница между 0 и 4 общими
// заметна, между 40 и 44 — почти нет) плюс жёсткий верхний КАП
// (SHARED_GAP_MAX) — сколько бы общих участников ни было, лишний зазор от
// них никогда не превышает несколько MIN_SEP.
const SHARED_GAP_STEP      = MIN_SEP * 0.6;  // px за sqrt(общих участников)
const SHARED_GAP_MAX       = MIN_SEP * 4;    // жёсткий потолок extra-зазора от общих участников

const PATH_NODE_GAP    = 200;   // px: шаг между узлами пути

function _easeOut3(t) { return 1 - Math.pow(1 - t, 3); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function _normAngle(a) {
  let x = a;
  while (x <= -Math.PI) x += 2 * Math.PI;
  while (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

// [SF-WEB-57] Золотой угол (филлотаксис) — тот же приём, что и раньше
// использовался только внутри _placeZoneLeafRings для рассеивания
// избыточных колец общих листьев (см. `rotate` там). Теперь это ЕДИНЫЙ
// источник детерминированного «запасного» направления везде, где реальный
// вектор (к родителю / сумма векторов к нескольким родителям) вырождается
// в ноль — см. _fallbackAngle ниже и заголовочный комментарий у placeChildren.
const GOLDEN_ANGLE = 2.399963229728653; // рад, ≈137.5°

// [SF-WEB-57] Детерминированный угол для узла/зоны, у которых нет ни одного
// осмысленного направляющего вектора (полюс, чей единственный родитель —
// сид в начале координат; общая линза, чьи владельцы легли строго напротив
// друг друга и их векторы взаимно уничтожились). seed — любое число,
// однозначно определяющее узел/зону (id полюса, сумма id владельцев зоны):
// один и тот же вход всегда даёт один и тот же угол, без обхода графа и без
// зависимости от того, сколько ещё узлов уже размещено — новый узел не
// сдвигает уже поставленные соседи, только сам получает следующий угол в
// детерминированной, визуально хорошо рассеивающейся последовательности.
function _fallbackAngle(seed) {
  return _normAngle(seed * GOLDEN_ANGLE);
}

// [SF-WEB-51] ГАРАНТИЯ отсутствия наложений — жёсткий кап итераций.
// Детерминированное размещение (шаги 1–5 ниже) уже почти-решение, так что
// нескольких проходов симметричного расталкивания хватает; кап ЖЁСТКИЙ (нет
// while-до-сходимости) — солвер физически не может зависнуть. Экспортируется,
// чтобы тест мог проверить завершение в пределах капа.
export const SOLVER_ITERS = 8;

// [SF-WEB-51] resolveCollisions — глобальный детерминированный солвер
// расстояния: та гарантия, которой независимая раскладка одуванчиков/линз
// (и тем более физика) не давала. После прогона любая пара ПОДВИЖНЫХ точек
// ≥ MIN_SEP (в пределах капа итераций; на почти-решённом входе сходится
// сильно раньше). Равномерная пространственная сетка (ячейка = MIN_SEP):
// каждая точка проверяет только 8 смежных ячеек → O(N) соседей на проход, не
// O(N²). ПРИКОЛОТЫЕ точки (seed + expanded-полюса) держат структуру и не
// двигаются — расслабляются только листья/линзы. Полностью детерминирован:
// фиксированное число проходов, обход в порядке вставки, индексно-заданный
// тайбрейк для строго совпавших точек — без Math.random, один вход → один
// выход.
//
// @param {Map<id,{x,y}>} targets      — подвижные И приколотые ноды (см. pinnedIds)
// @param {Set<id>}       pinnedIds     — какие из targets НЕ двигать
// @param {Map<id,{x,y}>} [extraPinned] — доп. приколотые коллайдеры, которых
//        нет в targets (сид: его (0,0) владеет mergeNetwork/initNetwork, не
//        этот Map) — участвуют в столкновениях, но не пишутся обратно.
export function resolveCollisions(targets, pinnedIds, extraPinned) {
  const ids = [...targets.keys()];
  const px = [], py = [], pin = [];
  for (const id of ids) {
    const p = targets.get(id);
    px.push(p.x); py.push(p.y); pin.push(pinnedIds.has(id) ? 1 : 0);
  }
  const emitCount = ids.length;
  if (extraPinned) {
    for (const p of extraPinned.values()) { px.push(p.x); py.push(p.y); pin.push(1); }
  }

  const N = px.length;
  if (N < 2) return;

  const MIN2 = MIN_SEP * MIN_SEP;
  const inv  = 1 / MIN_SEP;

  for (let iter = 0; iter < SOLVER_ITERS; iter++) {
    // (Пере)раскладка по сетке каждый проход — дёшево O(N), и держит поиск
    // соседей корректным по мере того, как точки расслабляются.
    const grid = new Map();
    for (let i = 0; i < N; i++) {
      const key = Math.floor(px[i] * inv) + ":" + Math.floor(py[i] * inv);
      let cell = grid.get(key);
      if (!cell) grid.set(key, cell = []);
      cell.push(i);
    }

    let moved = false;
    for (let i = 0; i < N; i++) {
      const cx = Math.floor(px[i] * inv), cy = Math.floor(py[i] * inv);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const cell = grid.get(gx + ":" + gy);
          if (!cell) continue;
          for (const j of cell) {
            if (j <= i) continue;             // каждая неупорядоченная пара один раз
            if (pin[i] && pin[j]) continue;   // две приколотые — расслабить нечем
            let dx = px[j] - px[i], dy = py[j] - py[i];
            const d2 = dx * dx + dy * dy;
            if (d2 >= MIN2) continue;
            let d = Math.sqrt(d2);
            if (d < 1e-9) {
              // Строго совпали — детерминированная ось по индексам (без
              // рандома, чтобы повторный прогон дал тот же результат).
              const a = i * 12.9898 + j * 78.233;
              dx = Math.cos(a); dy = Math.sin(a); d = 1;
            } else { dx /= d; dy /= d; }
            const pen = MIN_SEP - d;
            moved = true;
            if (pin[i])      { px[j] += dx * pen; py[j] += dy * pen; }
            else if (pin[j]) { px[i] -= dx * pen; py[i] -= dy * pen; }
            else {
              const h = pen * 0.5;
              px[i] -= dx * h; py[i] -= dy * h;
              px[j] += dx * h; py[j] += dy * h;
            }
          }
        }
      }
    }
    if (!moved) break;
  }

  for (let i = 0; i < emitCount; i++) {
    if (!pin[i]) targets.set(ids[i], { x: px[i], y: py[i] });
  }
}

// [SF-WEB-29 follow-up] Небольшой запас поверх «голого» NODE_W при расчёте
// ёмкости кольца — на больших графах чисто геометрический минимум (хорда
// РОВНО NODE_W) на глаз читается как касание/лёгкое наложение из-за
// hover-обводки и антиалиасинга circularImage по краю. Ёмкость колец теперь
// считается по слегка увеличенному целевому расстоянию, а не по NODE_W
// напрямую — при большом числе листьев это даёт систематически больше
// колец с чуть меньшим числом слотов на каждом, а не единичный лишний зазор.
const RING_CAP_MARGIN = 1.08;

// [SF-WEB-29] Ёмкость кольца радиуса r (сколько нод помещается без
// перекрытий) — точная формула по ХОРДЕ между соседними листьями, а не по
// приближению «длина дуги ≈ хорда». Для колец с малым числом слотов на
// кольцо (типично для НЕбольших/средних r — как раз тех, что чаще всего
// используются) разница ощутима: например при cap=6 и r≈75px старая формула
// (floor(2πr/NODE_W)) давала хорду ~75px — на ~4% МЕНЬШЕ NODE_W=78px,
// видимое как едва заметное наложение соседних листьев. Решаем обратную
// задачу впрямую: макс. cap, при котором chord = 2r·sin(π/cap) ≥ целевое
// расстояние (NODE_W·RING_CAP_MARGIN, см. выше).
//   sin(π/cap) ≥ target/(2r)  ⟺  cap ≤ π / asin(target/(2r))
// При r настолько малом, что target/(2r) ≥ 1 (запрошенный радиус физически
// не вмещает даже пару листьев на приемлемом расстоянии), возвращаем 1 —
// единственный лист на этом кольце, следующий уходит на кольцо шире.
function _ringCap(r) {
  const target = NODE_W * RING_CAP_MARGIN;
  const ratio = target / (2 * r);
  if (ratio >= 1) return 1;
  return Math.max(1, Math.floor(Math.PI / Math.asin(ratio)));
}

// [SF-WEB-29 follow-up] Радиальный шаг между кольцами — ЖЁСТКО зажат снизу
// на NODE_W (Math.max ниже): сколько бы ни тюнили LEAF_GAP, соседние кольца
// геометрически не могут сблизиться ближе диаметра ноды. Раньше это было
// только комментарием-обещанием ("LEAF_GAP всё ещё заметно больше NODE_W"),
// державшимся на том, что константу никто не уменьшит настолько, чтобы
// нарушить его — теперь это инвариант функции, не соглашение между
// константами. Это же развязывает LEAF_GAP как чисто визуальную ручку
// плотности (насколько кольца выглядят единым целым) от гарантии
// неперекрытия — можно уменьшать LEAF_GAP сколько угодно, пол не даст
// кольцам столкнуться. Логарифмический рост поверх пола — то же, что и
// раньше: иначе «одуванчик» с большим N превращается в частую спираль из
// многих тонких колец, читающуюся как один смазанный клубок вместо
// узнаваемых концентрических колец.
function _adaptiveRingGap(n) {
  const gap = LEAF_GAP * (1 + Math.log2(1 + Math.max(0, n) / 12) * 0.15);
  return Math.max(NODE_W, gap);
}

// Внешний радиус «одуванчика» для N эксклюзивных листьев. gap ДОЛЖЕН быть
// тем же значением, что использует фактическая раскладка колец ниже (шаги 3
// и 5) — иначе dR здесь (используемый для расчёта минимальной дистанции
// между полюсами/seed, см. minDist/minRFromSeed) недооценит реальный радиус
// уже размещённых листьев, и полюса/зоны Эйлера смогут наехать на чужой
// «одуванчик», который на самом деле шире, чем этот расчёт предполагал.
function _dandelionR(n) {
  if (n <= 0) return LEAF_R * 0.5;
  const gap = _adaptiveRingGap(n);
  let rem = n, k = 0;
  while (rem > 0) { rem -= _ringCap(LEAF_R + k * gap); k++; if (k > 60) break; }
  return LEAF_R + (k - 1) * gap + NODE_W * 0.5;
}

// [SF-WEB-29 follow-up] Общие листья зоны пересечения Эйлера использовали
// ОДНО плоское кольцо, растущее прямо пропорционально их числу — годится
// для типичных 2-4 общих артистов, но при большом числе (частый случай в
// плотном графе коллабораций: многие уже раскрытые полюса делят десятки
// общих фичерящих) это кольцо разрасталось в гигантский обод, в который
// сходились рёбра сразу от ВСЕХ полюсов зоны — читалось как «колесо со
// спицами», а не как узнаваемый кластер. Решение: тот же принцип
// концентрических колец, что и у обычного одуванчика листьев полюса
// (_ringCap задаёт точную ёмкость по хорде), но кольца стартуют ВПЛОТНУЮ к
// центру зоны (r0), а не на расстоянии LEAF_R — общий лист по прежнему
// «садится» рядом с естественным центром между своими полюсами, просто
// избыток при больших N расходится по дополнительным кольцам вместо
// раздувания единственного.
function _placeZoneLeafRings(leaves, cx, cy, targets, fromPos, getFrom) {
  if (!leaves.length) return;
  if (leaves.length === 1) {
    targets.set(leaves[0], { x: cx, y: cy });
    fromPos.set(leaves[0], getFrom(leaves[0]));
    return;
  }
  const gap = _adaptiveRingGap(leaves.length);
  const r0  = Math.max(NODE_W * 0.55, gap * 0.5);
  let rem = [...leaves], k = 0;
  while (rem.length) {
    const r     = r0 + k * gap;
    const cap   = _ringCap(r);
    const batch = rem.splice(0, cap);
    // Зоны Эйлера (в отличие от одуванчика полюса) не имеют «наружного»
    // направления — baseAngle там задаёт seed, здесь такого якоря нет.
    // Без сдвига каждое кольцо из ровно ОДНОГО избыточного листа (частый
    // случай при overflow на следующее кольцо) садится под тем же ang=0,
    // что и предыдущее — несколько таких колец подряд коллинеарны (все на
    // одном луче от центра зоны), в точности то же "выстраивание в линию",
    // которое эта раскладка должна была исключить. GOLDEN_ANGLE-сдвиг на
    // кольцо (тот же приём, что филлотаксис у растений) гарантирует, что
    // ни одно кольцо не повторяет направление предыдущего.
    const rotate = k * GOLDEN_ANGLE;
    batch.forEach((leaf, i) => {
      const ang = rotate + (2 * Math.PI * i) / batch.length;
      targets.set(leaf, { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
      fromPos.set(leaf, getFrom(leaf));
    });
    k++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// placeExpandedNodes
//
// Считает целевые позиции (targets) и стартовые позиции (fromPos) для анимации.
// Сложность: O(E + N) — нет итерационных циклов, нет релаксации.
// ─────────────────────────────────────────────────────────────────────────────
export function placeExpandedNodes(savedPositions) {
  const targets = new Map(), fromPos = new Map();
  const seedId = State.currentSeedId;
  if (seedId == null) return { targets, fromPos };

  // [SF-WEB-29 follow-up] Раньше здесь стоял ранний выход при пустом
  // State.expandedNodes — это отрезало шаг 5 (seed-only одуванчик) от
  // самого первого рендера сида (initNetwork, render.js), когда ничего ещё
  // не раскрыто: expanded=[] делает poles=[] сам по себе (шаги 2-4
  // естественным образом схлопываются в no-op без отдельной проверки), а
  // шаг 5 при этом обязан отработать — иначе прямые соседи свежего сида
  // вообще не получают дандельон-раскладку и остаются на откуп
  // vis.js-физике (barnesHut, см. networkOptions в visuals.js), чьи
  // параметры никогда не подгонялись под LEAF_R/LEAF_GAP — отсюда и
  // разъезжающиеся, непропорционально большие кольца именно вокруг сида.
  const expanded = [...State.expandedNodes];
  const expandedSet = new Set(expanded);

  // Начальная позиция для анимации: сохранённая — для уже существующих нод,
  // (0,0) — для новых нод (они вылетают из seed).
  const getFrom = id => {
    const sp = savedPositions[id];
    return sp ? { x: sp.x, y: sp.y } : { x: 0, y: 0 };
  };

  // Seed всегда в центре — позиция и фиксация выставляются в mergeNetwork ДО add().

  // БАГ (структурный, ломал самый частый сценарий — "раскрыть сам seed"):
  // раньше здесь стоял `if (!poles.length) return { targets, fromPos };` —
  // ранний выход, когда единственная раскрытая нода это сам seed (poles =
  // expanded минус seedId = []). Из-за этого шаг 5 ниже (одуванчик
  // seed-only листьев) НИКОГДА не выполнялся при первом же expand seed'а:
  // все новые листья не попадали ни в targets, ни в fromPos, стартовали и
  // оставались в (0,0) поверх seed, а дальше их расталкивала только общая
  // barnesHut-физика без всякой целевой раскладки — хаотичный «взрыв»
  // нод без колец, с наслоениями, именно то, что видно на скриншотах.
  // Остальной код (шаги 1-4) при poles=[] и без того схлопывается в no-op
  // (пустые Map/массивы), так что убирать здесь нечего — просто не бейлимся
  // раньше времени и всегда доходим до шага 5.
  const poles = expanded.filter(id => id !== seedId);

  // ── 1. Один проход O(E): классификация листьев ──────────────────────────────
  // [SF-WEB-52] Кэш весов рёбер убран — секторная раскладка выводит радиус/
  // угол полюса из дерева раскрытий и весов ПОДДЕРЕВЬЕВ, а не из веса ребра
  // seed→полюс, как прежний POLE_DIST-подход.
  const leafOwners = new Map();              // leafId → Set<poleId>

  for (const e of State.graphEdges) {
    const a = e.from, b = e.to;
    const aIsPole = expandedSet.has(a) && a !== seedId;
    const bIsPole = expandedSet.has(b) && b !== seedId;
    // [SF-WEB-29 follow-up] Сид тоже владелец — см. большой БАГ-комментарий
    // ниже про то, почему сид никогда не может стать чужим ЛИСТОМ. Быть
    // ВЛАДЕЛЬЦЕМ (одной из сторон линзы Эйлера) — другое дело: у сида
    // обычно десятки прямых связей, и часть из них закономерно приходится
    // на тех же артистов, что и раскрытые полюса делят между собой. Раньше
    // такой лист считался ИСКЛЮЧИТЕЛЬНО листом полюса (сидовское ребро в
    // классификации не участвовало вообще), и по факту рисовался с двумя
    // рёбрами: коротким до полюса (учтённым раскладкой) и длинным до сида
    // через весь холст (не учтённым) — на плотных графах таких длинных
    // рёбер набиралось сотни, а сами листья лишний раз скучивались в
    // кольце полюса вместо того, чтобы часть из них ушла в линзу между
    // сидом и полюсом. См. P.set(seedId, ...) ниже — сид получает
    // полноценную запись в P, чтобы геометрия линзы (шаг 4) могла считать
    // его такой же стороной, как и любой другой полюс.
    const aIsOwner = aIsPole || a === seedId;
    const bIsOwner = bIsPole || b === seedId;

    // БАГ (главная причина "seed прыгает при expand"): каждый полюс всегда
    // соединён рёбер с seed'ом напрямую (это и делает его полюсом). Раньше
    // условие "является ли b листом polюса a" проверяло только
    // !expandedSet.has(b) — но seedId по умолчанию НЕ входит в expandedSet
    // (сид попадает туда, только если сам был явно раскрыт), так что ребро
    // seed↔pole проходило проверку и seed классифицировался как «эксклюзивный
    // лист» полюса. Дальше (шаг 3, «Эксклюзивные листья») seed получал
    // target-позицию в кольце листьев ВОКРУГ полюса, а поскольку
    // runFlyoutAnimation пишет x/y напрямую в net.body.nodes (в обход
    // fixed:true), сид физически улетал из (0,0) к этому кольцу за 420мс —
    // видимый "прыжок" сида при каждом expand ноды, напрямую связанной с ним.
    // Фикс: явно исключаем seedId из кандидатов в листья (условие ниже —
    // "листом" может стать что угодно, кроме самого сида и других полюсов).
    if (aIsOwner && !expandedSet.has(b) && b !== seedId) {
      if (!leafOwners.has(b)) leafOwners.set(b, new Set());
      leafOwners.get(b).add(a);
    }
    if (bIsOwner && !expandedSet.has(a) && a !== seedId) {
      if (!leafOwners.has(a)) leafOwners.set(a, new Set());
      leafOwners.get(a).add(b);
    }
  }

  const exclusive    = new Map(poles.map(id => [id, []]));  // poleId → [leafId]
  const sharedLeaves = [];                                   // [{leaf, owners}]
  // [SF-WEB-29 follow-up] Листья, чья судьба уже решена здесь (эксклюзивный
  // лист полюса ИЛИ общий лист линзы) — шаг 5 (seedLeaves) ниже должен их
  // пропустить. Раньше для этого хватало простого leafOwners.has(leaf), но
  // теперь сид тоже может быть "владельцем" по одиночке — лист, чей
  // ЕДИНСТВЕННЫЙ владелец это сам сид (обычный прямой сосед сида, никак не
  // связанный ни с одним полюсом), должен по-прежнему попасть в seedLeaves
  // (свой одуванчик вокруг сида, шаг 5), а не потеряться молча — exclusive
  // Map ключей на seedId не имеет (это Map поле→листья, сид туда никогда не
  // входил и не должен).
  const handledLeaves = new Set();

  for (const [leaf, owners] of leafOwners) {
    if (owners.size === 1) {
      const [owner] = owners;
      if (owner === seedId) continue;  // одиночный сидовский лист → шаг 5
      if (exclusive.has(owner)) { exclusive.get(owner).push(leaf); handledLeaves.add(leaf); }
    } else {
      sharedLeaves.push({ leaf, owners });
      handledLeaves.add(leaf);
    }
  }

  // [SF-WEB-56] Число листьев, общих для ЛЮБОЙ пары «сосед» (полюс/сид) —
  // считается один раз на весь текущий граф (не константа уровня модуля,
  // как CLUSTER_GAP_FLOOR/FRACTION выше — зависит от конкретных sharedLeaves
  // ЭТОГО вызова placeExpandedNodes). placeChildren (шаг 2, ниже) и
  // clusterGap (эта же секция) читают ОДНУ и ту же таблицу — не две
  // рассинхронизирующиеся копии одного и того же прохода по sharedLeaves.
  const sharedCountCache = new Map();  // "loId_hiId" → число общих листьев
  for (const { owners } of sharedLeaves) {
    const os = [...owners].sort((a, b) => a - b);
    for (let i = 0; i < os.length; i++)
      for (let j = i + 1; j < os.length; j++) {
        const k = os[i] + "_" + os[j];
        sharedCountCache.set(k, (sharedCountCache.get(k) || 0) + 1);
      }
  }
  function sharedCountBetween(a, b) {
    return sharedCountCache.get(Math.min(a, b) + "_" + Math.max(a, b)) || 0;
  }

  // [SF-WEB-56] Зазор для узла с собственным радиусом dR, чей сосед-родитель
  // делит с ним sharedCount общих листьев — максимум из трёх оценок:
  // (1) безусловный пол, (2) пропорция от dR (SF-WEB-54), (3) пропорция от
  // sharedCount (см. заголовочный комментарий у CLUSTER_GAP_FLOOR выше).
  // sharedCount передаётся вызывающей стороной — placePole ниже берёт его из
  // sharedCountBetween(id, parent) (пара полюс↔сид/полюс↔полюс), а
  // Эйлер-линза (шаг 4 ниже) — напрямую leaves.length своей зоны (общее
  // число листьев у пары владельцев зоны — та же величина по построению, но
  // без лишнего похода через sharedCountBetween ради ровно того же числа).
  function clusterGap(dR, sharedCount) {
    const sharedExtra = Math.min(Math.sqrt(Math.max(0, sharedCount)) * SHARED_GAP_STEP, SHARED_GAP_MAX);
    return Math.max(
      CLUSTER_GAP_FLOOR,
      dR * CLUSTER_GAP_FRACTION,
      CLUSTER_GAP_FLOOR + sharedExtra
    );
  }

  // Seed-only листья (см. блок 5 ниже) — считаем заранее, до размещения
  // полюсов: их «одуванчик» вокруг seed занимает радиус dRSeed, и полюса не
  // должны садиться ближе dRSeed + собственного радиуса (см. minDist ниже),
  // иначе кластеры перекрываются.
  const seedLeaves = [];
  for (const n of State.graphNodes) {
    if (expandedSet.has(n.id) || n.id === seedId || handledLeaves.has(n.id)) continue;
    seedLeaves.push(n.id);
  }
  const dRSeed = _dandelionR(seedLeaves.length);

  // ── 2. [SF-WEB-57] ВЕКТОРНАЯ РАСКЛАДКА ПОЛЮСОВ ─────────────────────────────
  //
  // БАГ (структурный, «весь граф выстраивается в линию»): предыдущая
  // раскладка (SF-WEB-52) резала 2π на непересекающиеся клинья ПРОПОРЦИОНАЛЬНО
  // весу поддерева и всегда ставила узел в ЦЕНТР своего клина. У узла с РОВНО
  // одним ребёнком клин ребёнка (вес/сумма весов = 1) получал ВСЮ ширину
  // родительского клина целиком — тот же центр, тот же угол. Любая цепочка
  // «раскрыли одного, у него раскрыли одного, у того ещё одного» (самый
  // обычный сценарий навигации) садилась на ОДИН И ТОТ ЖЕ луч от seed, только
  // радиус рос — идеально коллинеарные точки, визуально «всё в линию».
  //
  // Новая модель — не абстрактная геометрия клиньев, а буквально то, что
  // описано в тикете: у каждого узла есть НАПРАВЛЕНИЕ (простая тригонометрия
  // от позиции родителя(ей) — сумма векторов, если родителей несколько, см.
  // eulerZones ниже) и РАССТОЯНИЕ по этому направлению (уже решённая раньше
  // цепочка «одуванчик-из-которого + зазор + линза + зазор + одуванчик-в-
  // который», см. baseR ниже — не менялась). Направление от ОДНОГО родителя —
  // это направление НА родителя от seed (продолжение того же луча наружу);
  // единственный случай, где такого вектора нет вообще — родитель это сам
  // seed (позиция (0,0), направления не существует) — детерминированный
  // запасной угол на этот случай см. _fallbackAngle выше («никогда не рисуем
  // с нулевым вектором, но на этот случай — резервное решение»).
  //
  // Несколько узлов с ОДНИМ и тем же родителем (сиблинги) наивно получили бы
  // ОДИНАКОВОЕ направление — тут в дело вступает избежание наложений
  // (тикет: «если пересекаются — сначала сдвиг по углу, если не помогает —
  // по расстоянию»): каждый следующий сиблинг размещается ПО ОЧЕРЕДИ
  // (детерминированный порядок — сортировка по id), пробуя сначала свой
  // «естественный» угол, при коллизии со уже поставленными в этом же раунде
  // сиблингами — нудж по углу в обе стороны, и только если совсем не
  // помещается — увеличение радиуса (см. placeChildren ниже). Никакого
  // отдельного обхода графа под это не требуется — соседи уже под рукой в P
  // (Map, доступ O(1)), между собой сиблинги перебираются один раз за проход,
  // не по всему графу.
  const poleParent = new Map();  // poleId → parentId (seedId либо другой poleId)
  const poleSet = new Set(poles);
  const graphNodeById = new Map(State.graphNodes.map(n => [n.id, n]));
  for (const id of poles) {
    const gn = graphNodeById.get(id);
    let parent = gn && gn._expandParent != null ? gn._expandParent : seedId;
    // Родитель мог сам больше не быть полюсом (устаревшая/битая ссылка) —
    // либо это законный seed, либо откатываемся на seed как безопасный
    // дефолт вместо зависания в поиске несуществующего узла.
    if (parent !== seedId && !poleSet.has(parent)) parent = seedId;
    if (parent === id) parent = seedId; // защита от самоссылки
    poleParent.set(id, parent);
  }
  // Защита от циклов в _expandParent (не должно возникать по построению
  // graph.js, но раскладка не должна повиснуть, если бухгалтерия всё же
  // разъедется): любой полюс, чья цепочка родителей не приходит к seedId за
  // разумное число шагов, принудительно становится корневым.
  for (const id of poles) {
    let cur = id, steps = 0;
    const seen = new Set();
    while (poleParent.get(cur) !== seedId) {
      if (seen.has(cur) || steps++ > poles.length) { poleParent.set(id, seedId); break; }
      seen.add(cur);
      cur = poleParent.get(cur);
    }
  }

  const rootPoleIds = poles.filter(id => poleParent.get(id) === seedId);

  // Дети каждого полюса (для рекурсии секторов) и радиус одуванчика каждого
  // полюса — как в SF-WEB-29 (_dandelionR по числу его эксклюзивных листьев).
  const poleDR = new Map(poles.map(id => [id, _dandelionR(exclusive.get(id).length)]));
  const poleChildren = new Map();
  for (const id of poles) {
    const p = poleParent.get(id);
    if (p !== seedId) {
      if (!poleChildren.has(p)) poleChildren.set(p, []);
      poleChildren.get(p).push(id);
    }
  }

  // [SF-WEB-56] Для КАЖДОГО полюса — максимум sharedCountBetween с любым его
  // "соседом по уровню" (другим полюсом с ТЕМ ЖЕ родителем — то есть тем,
  // с кем он реально делит угловую границу клина). Это отдельный сигнал от
  // sharedCountBetween(id, parent) (общее с РОДИТЕЛЕМ, актуально в первую
  // очередь для зазора сид↔полюс) — путаница между двумя СОСЕДНИМИ
  // клиньями определяется тем, сколько они делят МЕЖДУ СОБОЙ, а не с общим
  // предком; ровно ту зону (общая линза двух соседних полюсов) и накрывает
  // clusterGap ниже через Math.max(...) обоих сигналов.
  const maxSiblingShared = new Map();
  for (const group of [rootPoleIds, ...poleChildren.values()]) {
    for (const id of group) {
      let m = 0;
      for (const other of group) {
        if (other !== id) m = Math.max(m, sharedCountBetween(id, other));
      }
      maxSiblingShared.set(id, m);
    }
  }

  const P = new Map();   // poleId → {x, y, dR}  (плюс сам seedId, см. ниже)
  // Сид — полноправная "сторона" линзы Эйлера (шаг 4) наравне с любым полюсом:
  // позиция всегда (0,0), «радиус облака» — dRSeed.
  P.set(seedId, { x: 0, y: 0, dR: dRSeed });

  // Минимальный угловой зазор между footprint-ами двух соседей — поверх
  // asin(...)-половинок ниже, чтобы не полагаться на точное касание.
  const ANGULAR_GAP = 0.02;

  // Половина угла, под которым облако радиуса dR (плюс зазор gap) видно с
  // расстояния r — та же формула, что раньше использовал fitR (SF-WEB-53),
  // здесь же используется для проверки коллизий между сиблингами, а не для
  // нарезки клина.
  function _footprintHalf(dR, gap, r) {
    if (r < 1e-6) return Math.PI;
    return Math.min(Math.PI - 1e-3, Math.asin(clamp((dR + gap / 2) / r, -1, 1)) + ANGULAR_GAP);
  }
  function _angularSep(a, b) {
    return Math.abs(_normAngle(a - b));
  }

  // [SF-WEB-57] Размещает всех детей parentId (корневые полюсы — дети сида)
  // по одному, в детерминированном порядке (id). У каждого — «естественное»
  // направление (направление на parentId от seed; для сида это направления
  // не существует — _fallbackAngle) и расстояние baseR (та же
  // clusterGap-цепочка, что и раньше, без изменений). Коллизия с уже
  // поставленным в ЭТОМ ЖЕ раунде сиблингом решается СНАЧАЛА нуджем угла
  // (в обе стороны от естественного направления), и только если это не
  // помогает за разумное число попыток — увеличением радиуса (тикет: «сперва
  // угол, потом длина»).
  function placeChildren(parentId, childIds, parentR) {
    if (!childIds.length) return;
    const isRoot = parentId === seedId;
    const parentPos = P.get(parentId);
    const naturalAngle = isRoot ? null : Math.atan2(parentPos.y, parentPos.x);
    const sorted = [...childIds].sort((a, b) => a - b);
    const placedThisRound = [];  // { angle, half }

    for (const id of sorted) {
      const dR = poleDR.get(id);
      // [SF-WEB-56] Оба сигнала: сколько id делит с РОДИТЕЛЕМ и сколько — с
      // самым "делящимся" сиблингом по тому же уровню — больший побеждает.
      const sharedCount = Math.max(sharedCountBetween(id, parentId), maxSiblingShared.get(id) || 0);
      const gap = clusterGap(dR, sharedCount);
      const baseR = isRoot ? dRSeed + dR + gap : parentR + poleDR.get(parentId) + dR + gap;
      const attemptAngle = naturalAngle == null ? _fallbackAngle(id) : naturalAngle;

      let r = baseR;
      let angle = attemptAngle;
      let half = _footprintHalf(dR, gap, r);
      let ok = placedThisRound.every(s => _angularSep(angle, s.angle) >= half + s.half);

      let tries = 0;
      while (!ok && tries < 24) {
        tries++;
        const k = Math.ceil(tries / 2);
        const sign = tries % 2 === 1 ? 1 : -1;
        angle = _normAngle(attemptAngle + sign * k * (half + ANGULAR_GAP) * 1.3);
        ok = placedThisRound.every(s => _angularSep(angle, s.angle) >= half + s.half);
      }
      if (!ok) {
        // Углом не разошлись за разумное число попыток (типично — очень
        // много сиблингов с большими облаками вокруг одного узкого родителя)
        // — жертвуем расстоянием: растим радиус, пока собственный footprint
        // не сузится настолько, что ИСХОДНЫЙ угол уже ни с кем не пересекается.
        angle = attemptAngle;
        for (let grow = 0; grow < 32 && !ok; grow++) {
          r *= 1.15;
          half = _footprintHalf(dR, gap, r);
          ok = placedThisRound.every(s => _angularSep(angle, s.angle) >= half + s.half);
        }
      }

      const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
      P.set(id, { x, y, dR });
      targets.set(id, { x, y });
      fromPos.set(id, getFrom(id));
      placedThisRound.push({ angle, half });

      placeChildren(id, poleChildren.get(id) || [], r);
    }
  }

  placeChildren(seedId, rootPoleIds, 0);

  // ── 3. Эксклюзивные листья: концентрические кольца («одуванчик») ──────────────
  for (const [poleId, leaves] of exclusive) {
    if (!leaves.length) continue;
    const { x: px, y: py } = P.get(poleId);
    const baseAngle = Math.atan2(py, px);   // кольцо ориентировано наружу от seed
    // [SF-WEB-29] Тот же gap, что _dandelionR(leaves.length) использовал для
    // dR этого полюса выше (шаг 2) — держим фактическую раскладку и оценку
    // радиуса, от которой зависит minDist до соседей, в одном источнике.
    const gap = _adaptiveRingGap(leaves.length);
    let rem = [...leaves], k = 0;
    while (rem.length) {
      const r   = LEAF_R + k * gap;
      const cap = _ringCap(r);
      const batch = rem.splice(0, cap);
      batch.forEach((leaf, i) => {
        const ang = baseAngle + (2 * Math.PI * i) / batch.length;
        targets.set(leaf, { x: px + Math.cos(ang) * r, y: py + Math.sin(ang) * r });
        fromPos.set(leaf, getFrom(leaf));
      });
      k++;
    }
  }

  // ── 4. Shared-листья: в зоне пересечения (круги Эйлера) ─────────────────────
  //
  // Группируем по уникальному набору владельцев (одна «линза» на пару/тройку).
  const eulerZones = new Map();
  for (const { leaf, owners } of sharedLeaves) {
    const key = [...owners].map(String).sort().join('_');
    if (!eulerZones.has(key)) eulerZones.set(key, { owners: [...owners], leaves: [] });
    eulerZones.get(key).leaves.push(leaf);
  }

  for (const { owners, leaves } of eulerZones.values()) {
    const valid = owners.filter(o => P.has(o));
    if (!valid.length) continue;

    // [SF-WEB-57] Центр линзы — векторная сумма позиций ВСЕХ её владельцев
    // (сид включительно, если он один из них — P.get(seedId) всегда (0,0),
    // так что его вклад в сумму нулевой, но он честно участвует как любой
    // другой владелец), делённая на их число — учитывает и длину, и
    // направление каждого вектора, ОДНА формула что для 2, что для 3+
    // владельцев (раньше 2-владельца были отдельным веткой через середину
    // отрезка/грань клиньев — с отказом от клиньев как понятия эта ветка
    // не нужна, центроид даёт то же самое: для двух точек центроид И есть
    // середина отрезка).
    //
    // Единственный случай, где эта сумма вырождается в (0,0) — владельцы
    // легли строго по разные стороны от сида и взаимно «погасили» друг
    // друга (тот самый «никогда не рисуем линзу с нулевым вектором» из
    // тикета) — тогда угол берём из детерминированного запасного источника
    // (_fallbackAngle, тот же, что и для корневых полюсов у сида), а не
    // теряем лист в начале координат.
    // [SF-WEB-56] leaves.length — число листьев именно ЭТОЙ линзы, тот же
    // sharedCount, что clusterGap ждёт от placeChildren (см. его заголовок)
    // — чем крупнее сама линза, тем дальше её отталкивает от сида.
    const minRFromSeed = dRSeed + clusterGap(dRSeed, leaves.length) * 0.5;

    let cx = 0, cy = 0;
    valid.forEach(o => { cx += P.get(o).x; cy += P.get(o).y; });
    cx /= valid.length; cy /= valid.length;

    const rFromSeed = Math.hypot(cx, cy);
    if (rFromSeed < minRFromSeed) {
      const pushAng = rFromSeed > 1e-6
        ? Math.atan2(cy, cx)
        : _fallbackAngle(valid.reduce((a, b) => a + b, 0) + 1);
      cx = Math.cos(pushAng) * minRFromSeed;
      cy = Math.sin(pushAng) * minRFromSeed;
    }

    // [SF-WEB-29 follow-up] Общие листья садятся концентрическими кольцами
    // вокруг (cx, cy) — единая раскладка для 2 и 3+ владельцев (см.
    // _placeZoneLeafRings выше). Раньше это было одно раздувающееся кольцо —
    // при больших N см. комментарий у _placeZoneLeafRings.
    _placeZoneLeafRings(leaves, cx, cy, targets, fromPos, getFrom);
  }

  // ── 5. Seed-only листья: собственный «одуванчик» вокруг seed ─────────────────
  //
  // БАГ (структурный, ломал раскладку/физику новых листьев seed'а): раньше
  // этот блок только копировал savedPositions для УЖЕ существующих seed-only
  // листьев. Новые seed-only листья (только что пришли с бэкена, ещё не
  // рисовались — savedPositions[n.id] нет) вообще не получали ни target,
  // ни fromPos: ни на шаге "1" (не полюса), ни здесь. Дальше по цепочке:
  //   • mergeNetwork(): `fromPos.get(n.id) || {x:0,y:0}` → нода стартует
  //     ровно в (0,0), поверх seed и поверх всех остальных таких же нод;
  //   • runFlyoutAnimation({ ids: [...targets.keys()] }) — раз ноды нет в
  //     targets, её вообще нет в списке анимации "вылета"; она просто
  //     остаётся в (0,0), пока её не растащит общая физика отталкивания —
  //     без «одуванчика» (в отличие от листьев expanded-полюсов, см. блок 3
  //     выше), т.е. другой лайаут и другая физика на старте.
  // Фикс: новые seed-only листья получают тот же дандельон-раскладку
  // (концентрические кольца), что и листья полюсов в блоке 3, только вокруг
  // seed (0,0) вместо pole — и, как и остальные новые ноды, "вылетают" из
  // seed (fromPos = {0,0}), поэтому попадают в targets/анимацию наравне со
  // всеми. Уже видимые (с savedPositions) seed-only листья остаются на
  // месте — им незачем прыгать при каждом новом expand.
  // (seedLeaves уже посчитан выше, до размещения полюсов — см. dRSeed.)

  if (seedLeaves.length) {
    const freshSeedLeaves = [];
    for (const id of seedLeaves) {
      if (savedPositions[id]) {
        const { x, y } = savedPositions[id];
        targets.set(id, { x, y });
        fromPos.set(id, { x, y });
      } else {
        freshSeedLeaves.push(id);
      }
    }

    // Кольца начинаются с первого свободного радиуса, чтобы новые листья
    // не садились поверх уже существующих.
    // [SF-WEB-29] gap считается от ПОЛНОГО seedLeaves.length (то же число,
    // что уже ушло в dRSeed = _dandelionR(seedLeaves.length) выше), а не от
    // freshSeedLeaves.length — иначе при частично уже размещённом
    // seed-одуванчике этот цикл использовал бы другой шаг колец, чем dRSeed
    // предполагал, и минимальная дистанция до полюсов (minDist выше) снова
    // недооценивала бы фактический радиус.
    const gap = _adaptiveRingGap(seedLeaves.length);
    let rem = freshSeedLeaves, k = 0;
    while (rem.length) {
      const r     = LEAF_R + k * gap;
      const cap   = _ringCap(r);
      const batch = rem.splice(0, cap);
      batch.forEach((leaf, i) => {
        const ang = (2 * Math.PI * i) / batch.length;
        targets.set(leaf, { x: Math.cos(ang) * r, y: Math.sin(ang) * r });
        fromPos.set(leaf, { x: 0, y: 0 });
      });
      k++;
    }
  }

  // ── 6. [SF-WEB-51] Глобальный collision-solver — ГАРАНТИЯ ─────────────────
  // Шаги 1–5 кладут одуванчики полюсов и линзы Эйлера НЕЗАВИСИМО (каждый
  // сам по себе не пересекается, но между собой пересечься могут: линза
  // может налезть на чужой одуванчик, два одуванчика — друг на друга при
  // асимметричных дистанциях). Солвер закрывает это детерминированно: seed
  // и все полюса приколоты (структура держится), листья/линзы расслабляются
  // до попарного ≥ MIN_SEP. На типичном (уже почти-решённом) входе это
  // no-op или пара микро-сдвигов; на плотном графе со скриншота —
  // гарантированно разводит остаточные наложения без опоры на физику.
  const pinnedIds = new Set(poles);
  resolveCollisions(targets, pinnedIds, new Map([[seedId, { x: 0, y: 0 }]]));

  // ── 7. [SF-WEB-55] Классификация рёбер для собственного слоя отрисовки ────
  // (vis-adapter/edge-render.js) — геометрию узлов выше НЕ меняет, только
  // помечает уже готовые рёбра. "intra" — РОВНО та связь родитель→ребёнок
  // (poleParent-дерево ИЛИ полюс/сид → его СОБСТВЕННЫЙ эксклюзивный лист,
  // leafOwners.size===1), которая и определила позицию узла на шагах 2-5 —
  // короткая кривая внутри клина. Всё остальное (общие/линза-листья, лист↔
  // лист, полюс↔неродственный полюс) — "cross": дуга к общему хабу пары
  // секторов. Хаб пары — общий родительский полюс, если оба конца лежат в
  // одном и том же поддереве (rootSectorOf), иначе seed (hub:null — центр).
  const poleSetForClass = new Set(poles);
  function rootSectorOf(poleId) {
    let cur = poleId, guard = 0;
    while (poleParent.get(cur) !== seedId) {
      cur = poleParent.get(cur);
      if (++guard > poles.length + 1) return seedId;
    }
    return cur;
  }
  function sectorOf(id) {
    if (id === seedId) return seedId;
    if (poleSetForClass.has(id)) return rootSectorOf(id);
    const owners = leafOwners.get(id);
    // Ровно один владелец → сектор его дерева. Ноль (нет ни одной owner-
    // связи) ИЛИ 2+ (общий/линза-лист — сидит на ГРАНИЦЕ секторов, у него
    // нет одного законного дерева) — трактуем как принадлежащий сиду:
    // хаб дуги для рёбер такого узла — центр, а не произвольно выбранный
    // один из его нескольких владельцев.
    if (!owners || owners.size !== 1) return seedId;
    const [owner] = owners;
    return owner === seedId ? seedId : rootSectorOf(owner);
  }
  const edgeClass = new Map();
  for (const e of State.graphEdges) {
    const a = e.from, b = e.to;
    const isTreeEdge = poleParent.get(a) === b || poleParent.get(b) === a;
    const ownersA = leafOwners.get(a), ownersB = leafOwners.get(b);
    const isExclusiveEdge =
      (ownersA && ownersA.size === 1 && [...ownersA][0] === b) ||
      (ownersB && ownersB.size === 1 && [...ownersB][0] === a);
    const kind = (isTreeEdge || isExclusiveEdge) ? "intra" : "cross";
    let hub = null;  // null = хаб-по-умолчанию (seed, {0,0})
    if (kind === "cross") {
      const sa = sectorOf(a), sb = sectorOf(b);
      hub = (sa === sb && sa !== seedId) ? sa : null;
    }
    // edge.id — тот же "min(from,to)_max(from,to)" формат, что buildEdgeState
    // в graph.js даёт каждому ребру (см. комментарий в highlight.js о
    // _edgeById) — на реальных данных всегда присутствует; фоллбэк ниже
    // только для случаев, где его нет (напр. некоторые старые фикстуры в
    // layout.test.js, никогда не имевшие причины его выставлять).
    const key = e.id ?? `${Math.min(a, b)}_${Math.max(a, b)}`;
    edgeClass.set(key, { from: a, to: b, kind, hub });
  }

  return { targets, fromPos, edgeClass };
}

// SF-WEB-17: floor on node spacing — comfortably larger than the biggest
// node diameter (HUB_RADIUS*2 = 72px, see visuals.js) so path nodes never
// overlap regardless of how long the path or how narrow the canvas is.
// [SF-WEB-51] Reuses the same MIN_SEP metric as a hard floor (path nodes are
// hub-sized, so 140 stays the effective value — Math.max keeps it correct if
// MIN_SEP ever grows past it, one metric feeding both layouts).
const MIN_PATH_GAP = Math.max(140, MIN_SEP);

// ─────────────────────────────────────────────────────────────────────────────
// placePathNodes — readable left-to-right layout for a six-degrees path on
// the freshly-cleared canvas (see clearGraphForPathSearch/mergePathData).
// Replaces the old single-angle diagonal line (which read as a random
// skewed streak, and which picked its angle by inspecting already-rendered
// expanded nodes — meaningless here since the canvas is always empty at
// this point) with a straight horizontal row: `from` on the left, `to` on
// the right, evenly spaced, centered on (0,0) — the same origin convention
// the seed node uses elsewhere (see placeExpandedNodes).
//
// canvasSize lets the step adapt to the actual viewport instead of a fixed
// gap that either crowds a long path or leaves a short one looking sparse:
// spacing fills ~80% of the canvas width, clamped to [MIN_PATH_GAP,
// PATH_NODE_GAP] so it's never so tight nodes touch, nor so wide a short
// path looks needlessly spread out.
// ─────────────────────────────────────────────────────────────────────────────
export function placePathNodes(path, canvasSize = {}) {
  const targets = new Map(), fromPos = new Map();
  if (!path || path.length < 2) return { targets, fromPos };

  const n      = path.length;
  const width  = canvasSize.width > 0 ? canvasSize.width : 1100;
  const usable = Math.max(width * 0.8, MIN_PATH_GAP);
  const step   = clamp(usable / (n - 1), MIN_PATH_GAP, PATH_NODE_GAP);
  const totalWidth = step * (n - 1);
  const startX = -totalWidth / 2;

  for (let i = 0; i < n; i++) {
    const nodeId = path[i];
    targets.set(nodeId, { x: startX + step * i, y: 0 });
    // Каждая нода "вылетает" из центра — тот же приём, что и у expand'а
    // (см. placeExpandedNodes: новые ноды стартуют из seed), только общей
    // точкой вылета здесь служит центр холста, а не позиция seed'а: на
    // только что очищенном канвасе сохранённых позиций ещё нет.
    fromPos.set(nodeId, { x: 0, y: 0 });
  }

  return { targets, fromPos };
}
