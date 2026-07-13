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
export const LEAF_R       = 150;   // px: радиус первого кольца листьев
const LEAF_GAP      = 120;   // px: зазор между кольцами
// Все ноды теперь одного фиксированного радиуса (FIXED_NODE_RADIUS=22px,
// см. computeNodeSizes) — раскладку больше не нужно подстраивать под
// разброс размеров, значения ниже подобраны под этот единый диаметр (52px)
// с небольшим запасом на подписи/hover-обводку.
const NODE_W       = 78;    // px: ширина ноды + минимальный зазор
const EULER_GAP    = 72;    // px: зазор в линзе пересечения (Эйлер)

const PATH_NODE_GAP    = 200;   // px: шаг между узлами пути

function _easeOut3(t) { return 1 - Math.pow(1 - t, 3); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Ёмкость кольца радиуса r (сколько нод помещается без перекрытий)
function _ringCap(r) { return Math.max(1, Math.floor(2 * Math.PI * r / NODE_W)); }

// Внешний радиус «одуванчика» для N эксклюзивных листьев
function _dandelionR(n) {
  if (n <= 0) return LEAF_R * 0.5;
  let rem = n, k = 0;
  while (rem > 0) { rem -= _ringCap(LEAF_R + k * LEAF_GAP); k++; if (k > 60) break; }
  return LEAF_R + (k - 1) * LEAF_GAP + NODE_W * 0.5;
}

// ─────────────────────────────────────────────────────────────────────────────
// placeExpandedNodes
//
// Считает целевые позиции (targets) и стартовые позиции (fromPos) для анимации.
// Сложность: O(E + N) — нет итерационных циклов, нет релаксации.
// ─────────────────────────────────────────────────────────────────────────────
export function placeExpandedNodes(savedPositions) {
  const targets = new Map(), fromPos = new Map();
  if (!State.network || !State.nodesDS) return { targets, fromPos };

  const expanded = [...State.expandedNodes];
  if (!expanded.length) return { targets, fromPos };

  const seedId     = State.currentSeedId;
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
    // Фикс: явно исключаем seedId из кандидатов в листья.
    if (aIsPole && !expandedSet.has(b) && b !== seedId) {
      if (!leafOwners.has(b)) leafOwners.set(b, new Set());
      leafOwners.get(b).add(a);
    }
    if (bIsPole && !expandedSet.has(a) && a !== seedId) {
      if (!leafOwners.has(a)) leafOwners.set(a, new Set());
      leafOwners.get(a).add(b);
    }
  }

  const exclusive    = new Map(poles.map(id => [id, []]));  // poleId → [leafId]
  const sharedLeaves = [];                                   // [{leaf, owners}]

  for (const [leaf, owners] of leafOwners) {
    if (owners.size === 1) {
      const [pole] = owners;
      if (exclusive.has(pole)) exclusive.get(pole).push(leaf);
    } else {
      sharedLeaves.push({ leaf, owners });
    }
  }

  // Seed-only листья (см. блок 5 ниже) — считаем заранее, до размещения
  // полюсов: их «одуванчик» вокруг seed занимает радиус dRSeed, и полюса не
  // должны садиться ближе dRSeed + собственного радиуса (см. minDist ниже),
  // иначе кластеры перекрываются.
  const seedLeaves = [];
  for (const n of State.graphNodes) {
    if (expandedSet.has(n.id) || n.id === seedId || leafOwners.has(n.id)) continue;
    seedLeaves.push(n.id);
  }
  const dRSeed = _dandelionR(seedLeaves.length);

  // ── 2. Размещение полюсов вокруг seed ── O(N log N) ──────────────────────────
  //
  // Ключевой принцип: каждый полюс «отплывает» в том направлении, где он уже
  // находился как лист — это и есть эффект «нода отплывает в сторону от родителя».
  // Для новых нод без позиции находим наибольший свободный угол.

  const poleInfo = poles.map(id => {
    const sp = savedPositions[id];
    const ang = (sp && (sp.x !== 0 || sp.y !== 0))
      ? Math.atan2(sp.y, sp.x)
      : null;  // будет назначен ниже
    const wKey = id < seedId ? id + '_' + seedId : seedId + '_' + id;
    const w = wCache.get(wKey) || 1;
    const dist = clamp(POLE_DIST + (w - 1) * 22, POLE_DIST, POLE_DIST + 400);
    const dR = _dandelionR(exclusive.get(id).length);
    // Дистанция seed→полюс не может быть меньше суммы радиусов «одуванчиков»
    // seed'а и этого полюса (+ зазор) — иначе кластеры налезают друг на
    // друга, и их потом расталкивает physics вживую (видимое дёрганье).
    const minDist = dRSeed + dR + EULER_GAP;
    return { id, ang, dist: Math.max(dist, minDist), dR };
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
      const minAng = 2 * Math.asin(clamp((A.dR + B.dR + EULER_GAP) / (A.dist + B.dist), 0, 1));
      const gap = ((B.ang - A.ang) + 2 * Math.PI) % (2 * Math.PI);
      if (gap < minAng && gap >= 0) {
        const push = (minAng - gap) / 2;
        A.ang -= push; B.ang += push;
      }
    }
  }

  // Фиксируем позиции полюсов.
  const P = new Map();   // poleId → {x, y, dR}
  for (const { id, ang, dist, dR } of poleInfo) {
    const x = Math.cos(ang) * dist, y = Math.sin(ang) * dist;
    P.set(id, { x, y, dR });
    targets.set(id, { x, y });
    fromPos.set(id, getFrom(id));
  }

  // ── 3. Эксклюзивные листья: концентрические кольца («одуванчик») ──────────────
  for (const [poleId, leaves] of exclusive) {
    if (!leaves.length) continue;
    const { x: px, y: py } = P.get(poleId);
    const baseAngle = Math.atan2(py, px);   // кольцо ориентировано наружу от seed
    let rem = [...leaves], k = 0;
    while (rem.length) {
      const r   = LEAF_R + k * LEAF_GAP;
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
    // `(i - (leaves.length-1)/2) * NODE_W` случайно уводила настоящий общий
    // лист от центра. После фикса классификации при ОДНОМ реальном общем
    // листе сдвиг равен нулю — лист рисуется точно поверх seed и визуально
    // "исчезает" под ним. Фикс: отталкиваем центр зоны (и центроид для 3+)
    // от seed на safe-радиус, если он оказался ближе dRSeed (радиус
    // собственного одуванчика seed'а) + минимальный зазор.
    const minRFromSeed = dRSeed + NODE_W * 0.5;

    if (valid.length === 2) {
      // Два владельца: листья ложатся перпендикулярной лентой
      // ровно в центре зазора между краями их облаков.
      const A = P.get(valid[0]), B = P.get(valid[1]);
      const dx = B.x - A.x, dy = B.y - A.y;
      const D  = Math.hypot(dx, dy) || 1;
      const ux = dx / D, uy = dy / D;   // A→B
      const px = -uy, py = ux;          // перпендикуляр

      // Центроид зазора: посередине между краями облаков A и B.
      const midDist = (A.dR + (D - B.dR)) / 2;
      let cx = A.x + ux * clamp(midDist, A.dR * 0.5, D - B.dR * 0.5);
      let cy = A.y + uy * clamp(midDist, A.dR * 0.5, D - B.dR * 0.5);

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

      leaves.forEach((leaf, i) => {
        const off = (i - (leaves.length - 1) / 2) * NODE_W;
        targets.set(leaf, { x: cx + px * off, y: cy + py * off });
        fromPos.set(leaf, getFrom(leaf));
      });
    } else {
      // Три+ владельца: компактное кольцо в центроиде.
      let cx = 0, cy = 0;
      valid.forEach(o => { cx += P.get(o).x; cy += P.get(o).y; });
      cx /= valid.length; cy /= valid.length;

      const rFromSeed = Math.hypot(cx, cy);
      if (rFromSeed < minRFromSeed) {
        const pushAng = rFromSeed > 1e-6 ? Math.atan2(cy, cx) : 0;
        cx = Math.cos(pushAng) * minRFromSeed;
        cy = Math.sin(pushAng) * minRFromSeed;
      }

      const r = Math.max(NODE_W, (leaves.length * NODE_W) / (2 * Math.PI));
      leaves.forEach((leaf, i) => {
        const ang = (2 * Math.PI * i) / leaves.length;
        targets.set(leaf, { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
        fromPos.set(leaf, getFrom(leaf));
      });
    }
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
    let rem = freshSeedLeaves, k = 0;
    while (rem.length) {
      const r     = LEAF_R + k * LEAF_GAP;
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
