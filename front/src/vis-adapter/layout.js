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
//    POLE_GAP   — зазор между одуванчиками соседних полюсов (px)
//
//  Публичные функции:
//    placeExpandedNodes(savedPositions) → {targets, fromPos}  (инициал + expand)
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
// [SF-WEB-53] Зазор МЕЖДУ КЛАСТЕРАМИ (одуванчик-одуванчик, одуванчик-линза)
// — отдельная, заметно бОльшая величина, чем MIN_SEP. MIN_SEP — это порог
// нода-в-ноду ВНУТРИ одного кольца/облака (плотная упаковка листьев одного
// одуванчика); CLUSTER_GAP — порог между КРАЯМИ соседних облаков целиком,
// он должен визуально читаться как отдельный, более просторный воздух между
// блоками, а не совпадать по величине с межлистовым шагом. Кратность 2×
// подобрана так, чтобы разрыв между соседними одуванчиками был отчётливо
// виден на глаз даже на плотных графах, но не раздувал общий радиус раскладки
// сверх меры.
const CLUSTER_GAP = MIN_SEP * 2;
// [SF-WEB-51] Зазор между одуванчиками соседних полюсов — выведен из
// единой метрики CLUSTER_GAP (а не отдельный магический литерал, каким был
// прежний EULER_GAP=72, использовавшийся тут по совпадению): «дистанция
// полюсов ≥ Rp_i + Rp_j + POLE_GAP» (см. угловое расталкивание ниже).
// Неперекрытие листьев соседних одуванчиков между собой гарантирует
// глобальный солвер (шаг 6), так что отдельный зазор именно для линз больше
// не нужен как константа.
const POLE_GAP = CLUSTER_GAP;
// [SF-WEB-29 follow-up] Зазор между «облаком» полюса-родителя и вложенным
// (2nd-degree) полюсом-ребёнком — см. _placeNestedPoles ниже. Того же
// порядка, что POLE_GAP (тот же смысл: минимальный зазор между двумя
// облаками), отдельная константа только чтобы её можно было тюнить
// независимо, не трогая зазор в линзах Эйлера.
const NESTED_POLE_GAP = CLUSTER_GAP;

const PATH_NODE_GAP    = 200;   // px: шаг между узлами пути

function _easeOut3(t) { return 1 - Math.pow(1 - t, 3); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

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
    const rotate = k * 2.399963;
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

  // ── 2. [SF-WEB-52] СЕКТОРНАЯ РАСКЛАДКА ПОЛЮСОВ («пирог») ──────────────────────
  //
  // Отказ от «плоской борьбы за одну плоскость» (SF-WEB-51 расталкивал полюса
  // углами постфактум) в пользу РЕКУРСИВНОЙ нарезки 2π на непересекающиеся
  // клинья. Дерево раскрытий: корень = seed, родитель полюса = ближайший
  // раскрытый предок (poleParent, разбор вложенных ниже — как в SF-WEB-29).
  // Корень владеет полными 2π; дети узла делят его клин ПРОПОРЦИОНАЛЬНО весу
  // поддерева (лист = 1, под-полюс = сумма поддерева), но не уже собственной
  // угловой «нужды» (footprint одуванчика). Рекурсивно на любую глубину;
  // радиус узла растёт с глубиной (кольцо на хоп). Так ВСЁ поддерево любого
  // узла целиком лежит в своём клине → два одуванчика физически не могут
  // пересечься, в каком бы порядке и от какой бы ноды граф ни рос. Кольца
  // листьев (_ringCap/_dandelionR, шаг 3), классификацию линз (шаг 4) и
  // финальный resolveCollisions (шаг 6) НЕ трогаем — меняется только правило
  // выбора {x,y} полюсов здесь и целевая точка линзы (на «границу секторов»).
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

  // Вес узла = размер его поддерева в «листовых слотах»: лист = 1, под-полюс
  // = сумма его поддерева. Пол в 1, чтобы полюс без листьев и без детей всё
  // равно получил ненулевой клин.
  const weightCache = new Map();
  function subtreeWeight(id) {
    if (weightCache.has(id)) return weightCache.get(id);
    let w = exclusive.get(id).length;
    for (const c of (poleChildren.get(id) || [])) w += subtreeWeight(c);
    w = Math.max(1, w);
    weightCache.set(id, w);
    return w;
  }

  // [SF-WEB-52 §3] Сериация верхнеуровневых полюсов: ставим рядом тех, кто
  // делит больше общих листьев (простая жадная цепочка по матрице общих) —
  // тогда границы линз чистые и кросс-рёбер меньше. Детерминированно (обходы
  // отсортированы, тайбрейки по id).
  function orderRootPoles(ids) {
    if (ids.length <= 2) return [...ids].sort((a, b) => a - b);
    const idset = new Set(ids);
    const shared = new Map(); // "a_b" → число общих листьев
    const deg = new Map(ids.map(id => [id, 0]));
    for (const { owners } of sharedLeaves) {
      const os = [...owners].filter(o => idset.has(o)).sort((a, b) => a - b);
      for (let i = 0; i < os.length; i++)
        for (let j = i + 1; j < os.length; j++) {
          const k = os[i] + "_" + os[j];
          shared.set(k, (shared.get(k) || 0) + 1);
          deg.set(os[i], deg.get(os[i]) + 1);
          deg.set(os[j], deg.get(os[j]) + 1);
        }
    }
    const sc = (a, b) => shared.get(Math.min(a, b) + "_" + Math.max(a, b)) || 0;
    const remaining = new Set(ids);
    let start = [...ids].sort((a, b) => (deg.get(b) - deg.get(a)) || (a - b))[0];
    const order = [start];
    remaining.delete(start);
    while (remaining.size) {
      const last = order[order.length - 1];
      let best = null, bestC = -1;
      for (const c of [...remaining].sort((a, b) => a - b)) {
        const cc = sc(last, c);
        if (cc > bestC) { bestC = cc; best = c; }
      }
      order.push(best);
      remaining.delete(best);
    }
    return order;
  }

  const P = new Map();   // poleId → {x, y, dR}  (плюс сам seedId, см. ниже)
  // Сид — полноправная "сторона" линзы Эйлера (шаг 4) наравне с любым полюсом:
  // позиция всегда (0,0), «радиус облака» — dRSeed.
  P.set(seedId, { x: 0, y: 0, dR: dRSeed });

  // Рекурсивная нарезка. Узел id владеет клином [lo,hi]; ставим его в ЦЕНТР
  // клина. Клин детей делится СТРОГО ПРОПОРЦИОНАЛЬНО весу поддерева и в сумме
  // равен клину родителя (тест §б). РАДИУС узла адаптируется под ширину его
  // клина: одуванчик радиуса Rp виден из seed под углом 2·asin(Rp/r), и чтобы
  // он целиком уместился в клин полуширины `half`, нужно asin(Rp/r) ≤ half ⟺
  // r ≥ Rp/sin(half). Так секторы ВСЕГДА непересекающиеся (это чистая нарезка
  // угла), а «тесно» решается не наложением, а выносом полюса ДАЛЬШЕ — узкий
  // клин просто уезжает по радиусу, пока его одуванчик не влезет. baseR держит
  // минимум (клир seed-облака / родителя) и «кольцо на хоп». parentR — уже
  // вычисленный (с учётом выноса) радиус родителя.
  function placePole(id, lo, hi, parentR) {
    const half = (hi - lo) / 2;
    const center = (lo + hi) / 2;
    const dR = poleDR.get(id);
    const parent = poleParent.get(id);
    const baseR = parent === seedId
      ? dRSeed + dR + POLE_GAP
      : parentR + poleDR.get(parent) + dR + NESTED_POLE_GAP;
    const fitR = half >= Math.PI / 2 ? 0 : dR / Math.sin(half);
    const r = Math.max(baseR, fitR);
    const x = Math.cos(center) * r, y = Math.sin(center) * r;
    P.set(id, { x, y, dR });
    targets.set(id, { x, y });
    fromPos.set(id, getFrom(id));

    const kids = [...(poleChildren.get(id) || [])].sort((a, b) => a - b);
    if (!kids.length) return;
    let sumW = 0;
    for (const c of kids) sumW += subtreeWeight(c);
    let cur = lo;
    for (const c of kids) {
      const wdt = (hi - lo) * subtreeWeight(c) / sumW;
      placePole(c, cur, cur + wdt, r);
      cur += wdt;
    }
  }

  // Корень (seed) владеет полными 2π; делим их между корневыми полюсами
  // (сериированный порядок) СТРОГО пропорционально весу поддерева. Сид-only
  // листья (шаг 5) живут во ВНУТРЕННЕМ кольце вокруг (0,0) и в дележе 2π не
  // участвуют — они радиально ближе seed'а, чем любой корневой полюс, так что
  // за угол с полюсами не спорят.
  if (rootPoleIds.length) {
    const ordered = orderRootPoles(rootPoleIds);
    let sumW = 0;
    for (const p of ordered) sumW += subtreeWeight(p);
    let cur = -Math.PI / 2; // старт «вверх», детерминированно
    for (const p of ordered) {
      const wdt = 2 * Math.PI * subtreeWeight(p) / sumW;
      placePole(p, cur, cur + wdt, 0);
      cur += wdt;
    }
  }

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

    // БАГ (реальный, отдельный от "seed прыгает"): когда полюсов ровно два
    // и оба свежие (без сохранённой позиции), угловое размещение (шаг 2)
    // ставит второй полюс в «наибольший зазор» — а для двух полюсов это
    // ровно 180° от первого. Середина отрезка между двумя точками,
    // расположенными строго по разные стороны от seed на одинаковом
    // расстоянии, геометрически совпадает с seed (0,0). Раньше это было не
    // видно только потому, что тот же баг классификации листьев (см. выше)
    // ошибочно добавлял сам seed в тот же eulerZone как «лишний» общий
    // лист — из-за этого массив leaves был длиннее на 1, и формула сдвига
    // случайно уводила настоящий общий лист от центра. После фикса
    // классификации при ОДНОМ реальном общем листе центр зоны совпадал с
    // seed и лист визуально "исчезал" под ним. Фикс: отталкиваем центр зоны
    // (и центроид для 3+) от seed на safe-радиус, если он оказался ближе
    // dRSeed (радиус собственного одуванчика seed'а) + минимальный зазор.
    const minRFromSeed = dRSeed + CLUSTER_GAP * 0.5;
    let cx, cy;

    if (valid.length === 2) {
      // [SF-WEB-52 §4] Два владельца → лист(ья) на УГЛОВОЙ ГРАНИЦЕ между
      // секторами A и B (после сериации они обычно соседи, так что это ровно
      // шов их клиньев). Целевой угол — биссектриса по КОРОТКОЙ дуге между
      // угловыми положениями A и B (т.е. «между их угловыми диапазонами»);
      // радиус — средний между двумя полюсами. Классификацию линз
      // (eulerZones/leafOwners) не трогаем — меняется только эта точка.
      const A = P.get(valid[0]), B = P.get(valid[1]);
      const rA = Math.hypot(A.x, A.y), rB = Math.hypot(B.x, B.y);
      // Если один из владельцев — сид (в начале координат, угол не
      // определён), лист(ья) садятся на ЛУЧ seed→другой полюс (его угол), т.е.
      // «на границе» между внутренним seed-облаком и сектором полюса. Иначе —
      // биссектриса по короткой дуге между угловыми положениями A и B.
      let thA = Math.atan2(A.y, A.x), thB = Math.atan2(B.y, B.x);
      if (rA < 1e-6) thA = thB;
      if (rB < 1e-6) thB = thA;
      let dth = thB - thA;
      while (dth >  Math.PI) dth -= 2 * Math.PI;
      while (dth < -Math.PI) dth += 2 * Math.PI;
      const thMid = thA + dth / 2;
      const rMid  = Math.max(minRFromSeed, (rA + rB) / 2);
      cx = Math.cos(thMid) * rMid;
      cy = Math.sin(thMid) * rMid;
    } else {
      // Три+ владельца: центроид позиций всех полюсов зоны.
      cx = 0; cy = 0;
      valid.forEach(o => { cx += P.get(o).x; cy += P.get(o).y; });
      cx /= valid.length; cy /= valid.length;

      const rFromSeed = Math.hypot(cx, cy);
      if (rFromSeed < minRFromSeed) {
        const pushAng = rFromSeed > 1e-6 ? Math.atan2(cy, cx) : 0;
        cx = Math.cos(pushAng) * minRFromSeed;
        cy = Math.sin(pushAng) * minRFromSeed;
      }
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

  return { targets, fromPos };
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
