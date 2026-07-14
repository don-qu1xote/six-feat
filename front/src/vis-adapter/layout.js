// ═══════════════════════════════════════════════════════════════════════════
// vis-adapter/layout.js — expand/path layout placement math («одуванчики» +
//                         «круги Эйлера» for expand, linear placement for
//                         six-degrees paths). Pure position calculators:
//                         given current graph/expand state, produce target
//                         and starting {x,y} positions — no vis.js network
//                         mutation happens here (see physics.js::mergeNetwork
//                         for how targets/fromPos get applied + animated).
//
//  Настраивается пятью числами:
//    POLE_DIST  — расстояние seed → expanded-нода (px)
//    LEAF_R     — радиус первого кольца листьев (px)
//    LEAF_GAP   — шаг между кольцами листьев (px)
//    NODE_W     — ширина ноды + зазор (px, задаёт ёмкость кольца)
//    EULER_GAP  — зазор в зоне пересечения Эйлера (px)
//
//  Две публичные функции:
//    placeExpandedNodes(savedPositions) → {targets, fromPos}  (вычисление позиций)
//    placePathNodes(path, savedPositions) → {targets, fromPos}
//    mergeNetwork (physics.js) использует targets как СТАРТ вылета, физика
//    дойдёт до финала
// ═══════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";

const POLE_DIST   = 900;    // px: seed → expanded-нода
// [SF-WEB-29 follow-up] LEAF_R вернули к исходному 150 — с уменьшенным до 90
// смещение первого кольца от полюса/сида читалось слишком «оторванным»,
// одуванчик не воспринимался единым целым со своим центром. LEAF_GAP,
// наоборот, дополнительно уменьшен (было 120, затем 85) — межкольцевой шаг
// теперь ЗАЖИМАЕТСЯ снизу прямо в _adaptiveRingGap (см. ниже) на уровне
// NODE_W, а не просто "заметно больше" — так кольца становятся плотнее,
// читаются как единый элемент, но гарантия неперекрытия соседних колец не
// зависит от значения этой константы вообще: пол задаётся математически, а
// не подбором числа.
export const LEAF_R = 150;   // px: радиус первого кольца листьев
const LEAF_GAP      = 58;    // px: базовый шаг между кольцами (см. floor в _adaptiveRingGap)
// Все ноды теперь одного фиксированного радиуса (FIXED_NODE_RADIUS=22px,
// см. computeNodeSizes) — раскладку больше не нужно подстраивать под
// разброс размеров, значения ниже подобраны под этот единый диаметр (52px)
// с небольшим запасом на подписи/hover-обводку.
// [SF-WEB-29] Exported so layout.test.js can assert against the actual
// minimum-separation threshold instead of a duplicated magic number.
export const NODE_W = 78;    // px: ширина ноды + минимальный зазор
const EULER_GAP    = 72;    // px: зазор в линзе пересечения (Эйлер)
// [SF-WEB-29 follow-up] Зазор между «облаком» полюса-родителя и вложенным
// (2nd-degree) полюсом-ребёнком — см. _placeNestedPoles ниже. Того же
// порядка, что EULER_GAP (тот же смысл: минимальный зазор между двумя
// облаками), отдельная константа только чтобы её можно было тюнить
// независимо, не трогая зазор в линзах Эйлера.
const NESTED_POLE_GAP = 80;

const PATH_NODE_GAP    = 200;   // px: шаг между узлами пути

function _easeOut3(t) { return 1 - Math.pow(1 - t, 3); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

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

  // ── 1. Один проход O(E): кэш весов рёбер + классификация листьев ────────────
  const wCache    = new Map();               // "minId_maxId" → weight
  const leafOwners = new Map();              // leafId → Set<poleId>

  for (const e of State.graphEdges) {
    const a = e.from, b = e.to;
    const key = a < b ? a + '_' + b : b + '_' + a;
    wCache.set(key, e.weight || 1);

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

  // ── 2. Размещение полюсов ── O(N log N) ──────────────────────────────────────
  //
  // [SF-WEB-29 follow-up] Полюса делятся на КОРНЕВЫЕ (прямые соседи seed'а —
  // раскладываются на орбите вокруг seed, алгоритм ниже без изменений) и
  // ВЛОЖЕННЫЕ (2nd-degree: раскрытый узел САМ БЫЛ листом другого, уже
  // раскрытого полюса — см. graph.js::mergeGraph, поле _expandParent).
  // Раньше вложенные полюса классифицировались наравне с корневыми и
  // выносились на ту же орбиту вокруг seed на POLE_DIST — визуально
  // «отрывались» от родителя, у которого были листом секунду назад, и
  // задача «раскрыть уже видимого коллаборатора» превращалась в
  // непредсказуемый скачок через весь холст вместо роста дерева наружу.
  // Вложенные полюса размещаются ПОСЛЕ корневых, в _placeNestedPoles ниже,
  // относительно уже вычисленной позиции своего родителя.
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

  const rootPoleIds   = poles.filter(id => poleParent.get(id) === seedId);
  const nestedPoleIds = poles.filter(id => poleParent.get(id) !== seedId);

  // [SF-WEB-29 follow-up] БАГ (реальный, видимый после нескольких expand'ов
  // подряд): угловое расталкивание корневых полюсов ниже и minDist от seed
  // считали только dR полюса — радиус ЕГО СОБСТВЕННОГО кольца эксклюзивных
  // листьев. Если у полюса есть вложенное (2nd-degree) поддерево (см. шаг
  // «Вложенные полюса» ниже), оно занимает место ЗА пределами dR, примерно в
  // том же направлении, что и сам полюс относительно seed — но ни угловое
  // расталкивание, ни minDist об этом не знали. Результат: сосед, чей
  // одуванчик рассчитан «впритык» по чужому голому dR, наезжает на чужое
  // вложенное поддерево, которое на самом деле торчит дальше — отсюда
  // скученные, перекрёстные кластеры именно там, где что-то было раскрыто
  // не один раз подряд. poleReach(id) — консервативная (bottom-up по дереву
  // _expandParent) оценка «докуда дотягивается» всё поддерево полюса,
  // включая любых вложенных потомков; используется вместо голого dR всюду,
  // где считается зазор до соседей.
  const poleDR = new Map(poles.map(id => [id, _dandelionR(exclusive.get(id).length)]));
  const poleChildren = new Map();
  for (const id of poles) {
    const p = poleParent.get(id);
    if (p !== seedId) {
      if (!poleChildren.has(p)) poleChildren.set(p, []);
      poleChildren.get(p).push(id);
    }
  }
  const poleReachCache = new Map();
  function poleReach(id) {
    if (poleReachCache.has(id)) return poleReachCache.get(id);
    const own = poleDR.get(id);
    let reach = own;
    for (const c of (poleChildren.get(id) || [])) {
      // Расстояние от центра id до центра ребёнка c (та же формула, что и
      // сама раскладка вложенных полюсов ниже) плюс всё, что тянется за
      // пределы c (его собственный poleReach, рекурсивно).
      const viaChild = own + poleDR.get(c) + NESTED_POLE_GAP + poleReach(c);
      if (viaChild > reach) reach = viaChild;
    }
    poleReachCache.set(id, reach);
    return reach;
  }

  // Ключевой принцип: каждый корневой полюс «отплывает» в том направлении,
  // где он уже находился как лист — это и есть эффект «нода отплывает в
  // сторону от родителя». Для новых нод без позиции находим наибольший
  // свободный угол.

  const poleInfo = rootPoleIds.map(id => {
    const sp = savedPositions[id];
    const ang = (sp && (sp.x !== 0 || sp.y !== 0))
      ? Math.atan2(sp.y, sp.x)
      : null;  // будет назначен ниже
    const wKey = id < seedId ? id + '_' + seedId : seedId + '_' + id;
    const w = wCache.get(wKey) || 1;
    const dist = clamp(POLE_DIST + (w - 1) * 22, POLE_DIST, POLE_DIST + 400);
    const dR = poleDR.get(id);
    const reach = poleReach(id);
    // Дистанция seed→полюс не может быть меньше суммы радиуса «одуванчика»
    // seed'а и ПОЛНОГО (с учётом вложенных детей) охвата этого полюса
    // (+ зазор) — иначе кластеры налезают друг на друга, и их потом
    // расталкивает physics вживую (видимое дёрганье).
    const minDist = dRSeed + reach + EULER_GAP;
    return { id, ang, dist: Math.max(dist, minDist), dR, reach };
  });

  // Назначаем углы полюсам без сохранённой позиции.
  const takenAngles = poleInfo.filter(p => p.ang !== null).map(p => p.ang);
  for (const p of poleInfo.filter(p => p.ang === null)) {
    if (takenAngles.length === 0) {
      p.ang = -Math.PI / 2;  // первый полюс — вверх
    } else {
      // Ищем наибольший зазор между существующими углами.
      const sorted = [...takenAngles].sort((a, b) => a - b);
      let bestGap = 0, bestAng = 0;
      for (let i = 0; i < sorted.length; i++) {
        const next = sorted[(i + 1) % sorted.length];
        const gap  = ((next - sorted[i]) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
        if (gap > bestGap) { bestGap = gap; bestAng = sorted[i] + gap / 2; }
      }
      p.ang = bestAng;
    }
    takenAngles.push(p.ang);
  }

  // Лёгкое угловое расталкивание (3 прохода, только O(N) — N мало).
  // Гарантирует что одуванчики не перекрывают друг друга.
  for (let pass = 0; pass < 3; pass++) {
    poleInfo.sort((a, b) => a.ang - b.ang);
    for (let i = 0; i < poleInfo.length; i++) {
      const A = poleInfo[i], B = poleInfo[(i + 1) % poleInfo.length];
      const minAng = 2 * Math.asin(clamp((A.reach + B.reach + EULER_GAP) / (A.dist + B.dist), 0, 1));
      const gap = ((B.ang - A.ang) + 2 * Math.PI) % (2 * Math.PI);
      if (gap < minAng && gap >= 0) {
        const push = (minAng - gap) / 2;
        A.ang -= push; B.ang += push;
      }
    }
  }

  // Фиксируем позиции корневых полюсов.
  const P = new Map();   // poleId → {x, y, dR}  (плюс сам seedId, см. ниже)
  // [SF-WEB-29 follow-up] Сид — полноправная "сторона" линзы Эйлера (шаг 4)
  // наравне с любым полюсом, раз теперь может быть владельцем общего листа
  // (см. aIsOwner/bIsOwner выше). Позиция сида всегда (0,0), а его "радиус
  // облака" — dRSeed, уже посчитанный выше по тому же принципу, что и dR
  // любого полюса (_dandelionR от числа его собственных листьев).
  P.set(seedId, { x: 0, y: 0, dR: dRSeed });
  for (const { id, ang, dist, dR } of poleInfo) {
    const x = Math.cos(ang) * dist, y = Math.sin(ang) * dist;
    P.set(id, { x, y, dR });
    targets.set(id, { x, y });
    fromPos.set(id, getFrom(id));
  }

  // Вложенные полюса — располагаем относительно уже вычисленной позиции
  // родителя (который к этому моменту гарантированно уже в P: родитель либо
  // корневой (уже размещён выше), либо сам вложенный, но БЛИЖЕ к корню по
  // цепочке — обрабатываем их слоями, пока очередь не опустеет).
  let pendingNested = nestedPoleIds;
  let guard = 0;
  while (pendingNested.length && guard++ < poles.length + 1) {
    const placeableNow = pendingNested.filter(id => P.has(poleParent.get(id)));
    if (!placeableNow.length) break; // не должно происходить после нормализации выше

    // Группируем по родителю — так дети одного полюса веерно расходятся по
    // дуге, а не садятся друг на друга под одним и тем же углом.
    const byParent = new Map();
    for (const id of placeableNow) {
      const parentId = poleParent.get(id);
      if (!byParent.has(parentId)) byParent.set(parentId, []);
      byParent.get(parentId).push(id);
    }

    for (const [parentId, siblingIds] of byParent) {
      const parentPos = P.get(parentId);
      const parentAngFromSeed = Math.atan2(parentPos.y, parentPos.x);
      // Веер в ±30° вокруг направления seed→родитель — читается как «растёт
      // наружу из родителя», а не разлетается во все стороны произвольно.
      const FAN = Math.PI / 3;
      siblingIds.forEach((id, i) => {
        const dR = poleDR.get(id);
        const ang = parentAngFromSeed + (siblingIds.length > 1
          ? (i - (siblingIds.length - 1) / 2) * (FAN / (siblingIds.length - 1))
          : 0);
        // Дистанция от родителя не может быть меньше суммы их «одуванчиков»
        // (+ зазор) — тот же принцип, что minDist у корневых полюсов, но
        // относительно родителя, а не seed. poleReach(id), а не голый dR —
        // если у ЭТОГО вложенного полюса самого есть ещё дети (3rd-degree+),
        // они тоже должны уместиться до того, как здесь встанет следующий
        // (по любой ветке) сосед.
        const dist = parentPos.dR + poleReach(id) + NESTED_POLE_GAP;
        const x = parentPos.x + Math.cos(ang) * dist;
        const y = parentPos.y + Math.sin(ang) * dist;
        P.set(id, { x, y, dR });
        targets.set(id, { x, y });
        fromPos.set(id, getFrom(id));
      });
    }

    pendingNested = pendingNested.filter(id => !P.has(id));
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
    const minRFromSeed = dRSeed + NODE_W * 0.5;
    let cx, cy;

    if (valid.length === 2) {
      // Два владельца: центр линзы — середина зазора между краями их облаков.
      const A = P.get(valid[0]), B = P.get(valid[1]);
      const dx = B.x - A.x, dy = B.y - A.y;
      const D  = Math.hypot(dx, dy) || 1;
      const ux = dx / D, uy = dy / D;   // A→B
      const px = -uy, py = ux;          // перпендикуляр, нужен только для оттталкивания от seed ниже

      // Центроид зазора: посередине между краями облаков A и B.
      const midDist = (A.dR + (D - B.dR)) / 2;
      cx = A.x + ux * clamp(midDist, A.dR * 0.5, D - B.dR * 0.5);
      cy = A.y + uy * clamp(midDist, A.dR * 0.5, D - B.dR * 0.5);

      // БАГ (овершут): прошлый фикс прибавлял к cx/cy ПОЛНЫЙ minRFromSeed
      // перпендикулярно линии A→B, вместо минимально необходимого сдвига —
      // если у seed'а накопилось много собственных листьев (dRSeed большой,
      // после нескольких expand'ов — обычное дело), зону общего листа
      // отшвыривало на сотни px в сторону от коридора между A и B, и лист
      // повисал сиротой с длинным рёбром через весь холст. Считаем
      // минимальный перпендикулярный сдвиг d по теореме Пифагора так, чтобы
      // итоговая точка легла РОВНО на радиус minRFromSeed от seed, а не
      // дальше — зона остаётся максимально близко к своей «естественной»
      // позиции между полюсами.
      const rFromSeed = Math.hypot(cx, cy);
      if (rFromSeed < minRFromSeed) {
        const d = Math.sqrt(Math.max(0, minRFromSeed * minRFromSeed - rFromSeed * rFromSeed));
        cx += px * d;
        cy += py * d;
      }
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

  return { targets, fromPos };
}

// SF-WEB-17: floor on node spacing — comfortably larger than the biggest
// node diameter (HUB_RADIUS*2 = 72px, see visuals.js) so path nodes never
// overlap regardless of how long the path or how narrow the canvas is.
const MIN_PATH_GAP = 140;

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
