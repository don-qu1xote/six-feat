// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/edge-render.js — [SF-WEB-55] Свой canvas-слой отрисовки рёбер.
//                              Отменяет прежний SF-WEB-53 (hideEdgesOnDrag/
//                              hideEdgesOnZoom, см. visuals.js::networkOptions)
//                              — рёбра теперь НИКОГДА не скрываются, включая
//                              pan/zoom/drag.
//
// Секторная раскладка (SF-WEB-52) уже кладёт большинство связей как короткие
// радиальные (родитель→лист внутри клина) — их не нужно "распутывать", только
// красиво нарисовать. Остальное (общие/линза-листья, лист↔лист, полюс↔
// неродственный полюс — "кросс-секторные" рёбра) рисуется дугами chord-стиля,
// изогнутыми К ЦЕНТРУ пары секторов, а не прямыми через весь холст.
//
// Классификация (kind: "intra"|"cross", hub) считается ОДИН РАЗ на смену
// раскладки — в layout.js::placeExpandedNodes (переиспользует уже посчитанные
// leafOwners/poleParent, ничего не пересчитывает заново) — и попадает сюда
// через setEdgeCache(). draw(ctx) вызывается на КАЖДЫЙ кадр (network.on(
// "beforeDrawing", drawEdges) в render.js) и только читает ЖИВЫЕ позиции нод
// (network.getPositions() — учитывает drag/pan/zoom бесплатно, т.к. ctx уже
// в мировых координатах) и перерисовывает кэш — никакого пересчёта
// классификации в горячем пути.
//
// Нативные рёбра vis.js остаются подключены и ловят hoverEdge/selectEdge как
// раньше (hit-testing/подсветку не трогаем) — просто их базовая заливка
// принудительно невидима (см. suppressNativeEdgeColor ниже) ИМЕННО для
// рёбер, попавших в этот кэш (см. render.js::_layoutNodeItems / physics.js::
// mergeNetwork), так что визуально их не видно и вся графика приходит
// отсюда. Небольшой рассинхрон хит-зоны прямой нативной линии и нашей
// дуги — известный, принятый для v1 компромисс (тикет SF-WEB-55, п.3).
// ════════════════════════════════════════════════════════════════════════════
import { State, COLOR } from "../state/state.js";
import { roleStyle } from "../state/helpers.js";
import { resolveEdgeDominantRole, lightenHexColor, edgeWidthForWeight } from "./visuals.js";
import { getHoveredEdgeIds } from "./highlight.js";

// [SF-WEB-55 п.4] На очень больших графах даже дешёвая quadraticCurveTo на
// каждое ребро каждый кадр заметно дороже lineTo — вместо того чтобы
// скрывать рёбра (запрещено тикетом), деградируем КРИВИЗНУ до прямых линий.
// Все рёбра по-прежнему рисуются — просто без изгиба.
//
// [SF-WEB-56 follow-up] Поднимался до 2000 в расчёте на то, что батчинг по
// стилю (см. drawEdges ниже) снял основную стоимость (число stroke()-
// вызовов) — это верно для ПЕРФА, но подъём порога попутно рассекретил
// другую, отдельную и на тот момент ещё не решённую проблему: кросс-
// секторная дуга между двумя далеко разнесёнными полюсами (см. историю
// правок CROSS_BOW_FRACTION выше) на графах такого размера всё ещё может
// визуально читаться как «вторая линия», даже с капом по длине хорды —
// сама геометрия дуги для by-widely-separated пар остаётся не до конца
// решённой (см. заголовочный комментарий про «математический предел» у
// Эйлер-зоны в layout.js). Возвращён к исходному 400 — то состояние,
// которое уже было подтверждено рабочим, — пока эта дуговая геометрия не
// станет надёжной при любом расстоянии между полюсами.
export const CURVE_DEGRADE_EDGE_THRESHOLD = 400;

// [SF-WEB-56 follow-up] Кросс-рёбра: изгиб к хабу. Первая версия тянула
// контрольную точку на 35% ДИСТАНЦИИ ДО ХАБА — на плотных графах хаб (сид)
// часто оказывается ОЧЕНЬ далеко от середины хорды (кросс-ребро между двумя
// дальними листьями разных секторов), и 35% этой большой дистанции давало
// контрольную точку далеко ЗА пределами самой хорды — квадратичная кривая
// с таким контролем визуально вырождается в резкий излом («галочку»/kite:
// два почти прямых отрезка A→control, control→B), а не в узнаваемую дугу —
// именно это читалось как «два ребра». Фикс: изгиб задаётся ДОЛЕЙ ДЛИНЫ
// САМОЙ ХОРДЫ (chordLen*CROSS_BOW_FRACTION), а не долей расстояния до
// хаба — направление всё ещё «к хабу» (для бандлинга по паре секторов), но
// величина прогиба больше не зависит от того, насколько хаб далёк, и
// кривая остаётся гладкой дугой при любой топологии.
const CROSS_BOW_FRACTION = 0.28;  // доля длины хорды — максимальный прогиб
// Внутри-секторные рёбра — небольшой перпендикулярный прогиб (доля от длины
// сегмента) вместо прямой линии; знак прогиба детерминирован (id-пара), не
// привязан ни к какому хабу — это просто "плавная короткая кривая".
const INTRA_BOW = 0.12;

const BASE_OPACITY   = 0.38;
const HOVER_OPACITY  = 0.85;
const SELECT_OPACITY = 1.0;
const PATH_OPACITY   = 0.95;

// [SF-WEB-56] Гасим нативную отрисовку ребра ПОЛНОСТЬЮ, не полагаясь на
// ОДНО-единственное числовое поле. Изначальная (SF-WEB-55) версия трогала
// только color.opacity:0 — визуально это давало "по два ребра на каждую
// связь" (прямая нативная линия vis.js поверх нашей дуги), потому что при
// hover/selectEdge highlight.js пишет СОБСТВЕННЫЙ, отдельный от базового
// edgeVisual(), цвет прямо в DataSet (_hoverEdgeUpdate/_defaultEdgeUpdate/
// _applyPath, см. highlight.js) — {color:{color, opacity:1}}, без всякого
// понятия о том, что это ребро "принадлежит" edge-render.js и должно
// оставаться невидимым. Тронуть highlight.js рискованно (там свои тесты и
// более широкая ответственность за node-хайлайт тоже) — вместо этого сама
// БАЗОВАЯ (стартовая) заливка ребра теперь заведомо избыточно невидима:
// и явная прозрачная rgba-строка (не зависит от того, как конкретно vis.js
// трактует числовой opacity:0 в каждой отдельной внутренней ветке), И
// opacity:0 на ВСЕХ трёх уровнях (базовый/hover/highlight — на случай если
// chosen:false не полностью выключает встроенное чтение под-объектов).
// Полная невидимость по умолчанию не мешает highlight.js's temporary
// hover/selection re-color поверх (это тот самый v1-компромисс, п.3
// тикета SF-WEB-55) — но устраняет постоянное, каждый-кадр дублирование в
// состоянии покоя, которое и было видно на скриншотах.
const INVISIBLE_EDGE_COLOR = "rgba(0,0,0,0)";
export function suppressNativeEdgeColor(edgeItem) {
  const invisible = { color: INVISIBLE_EDGE_COLOR, opacity: 0 };
  return {
    ...edgeItem,
    color: {
      ...edgeItem.color,
      color:     INVISIBLE_EDGE_COLOR,
      opacity:   0,
      hover:     invisible,
      highlight: invisible,
    },
  };
}

// edgeId → { from, to, kind: "intra"|"cross", hub: poleId|null, color, width }
let _cache = new Map();

// [SF-WEB-55] Пересобирается ТОЛЬКО на смену раскладки (вызывающая сторона —
// render.js::_layoutNodeItems / physics.js::mergeNetwork, сразу после
// placeExpandedNodes) — принимает edgeClass прямо из его результата, так что
// это не отдельный проход по графу, а просто перекладка уже посчитанного +
// разовая (O(E), не на каждый кадр) выборка цвета/ширины по роли ребра.
export function setEdgeCache(edgeClass) {
  const next = new Map();
  if (edgeClass && edgeClass.size) {
    const byId = new Map(State.graphEdges.map(e => [e.id, e]));
    for (const [edgeId, meta] of edgeClass) {
      const ge     = byId.get(edgeId);
      const role   = ge ? resolveEdgeDominantRole(ge) : "primary";
      const color  = roleStyle(role).color;
      const weight = ge && Number(ge.weight) > 0 ? Number(ge.weight) : 1;
      next.set(edgeId, { from: meta.from, to: meta.to, kind: meta.kind, hub: meta.hub, color, width: edgeWidthForWeight(weight) });
    }
  }
  _cache = next;
  // [SF-WEB-56 follow-up] Плоский Set на State (а не отдельный export
  // отсюда, который highlight.js импортировал бы напрямую — это создало бы
  // цикл edge-render.js→highlight.js→edge-render.js, ведь мы САМИ уже
  // импортируем getHoveredEdgeIds оттуда) — highlight.js читает его на
  // каждый hover/selectEdge/path-апдейт (см. её же комментарий у
  // _isSuppressedEdge), чтобы НЕ перекрашивать нативное ребро видимым
  // цветом для рёбер, которые рисует этот canvas-слой.
  State.suppressedEdgeIds = new Set(next.keys());
}

// Вызывать при полном сбросе графа (resetCanvasToEmpty/clearGraphForPathSearch/
// переход в path-режим) — иначе кэш держит рёбра для уже удалённых нод; сам
// draw() и без этого безопасен (getPositions() не найдёт id → ребро просто
// пропускается), но explicit-очистка не даёт устаревшим записям пережить
// смену графа молча.
export function clearEdgeCache() {
  _cache = new Map();
  State.suppressedEdgeIds = new Set();
}

// Только для тестов/отладки.
export function _edgeCacheSize() { return _cache.size; }

function _pathEdgeKeySet(path) {
  const set = new Set();
  if (!Array.isArray(path)) return set;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    set.add(`${Math.min(a, b)}_${Math.max(a, b)}`);
  }
  return set;
}

function _curvePoint(meta, from, to, positions, degradeCurves) {
  if (degradeCurves) return null;  // прямая линия — управляющая точка не нужна
  if (meta.kind === "intra") {
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const bow = len * INTRA_BOW * (meta.from < meta.to ? 1 : -1);
    return { x: mx + nx * bow, y: my + ny * bow };
  }
  const hubPos = meta.hub == null ? { x: 0, y: 0 } : (positions[meta.hub] || { x: 0, y: 0 });
  const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
  const chordLen = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const toHubX = hubPos.x - mx, toHubY = hubPos.y - my;
  const hubDist = Math.hypot(toHubX, toHubY);
  // Направление к хабу — но прогиб капается долей длины ХОРДЫ, а не долей
  // hubDist (см. заголовок CROSS_BOW_FRACTION выше). hubDist===0 (хаб ровно
  // в середине хорды, вырожденный случай) — считаем прогиб нулевым, а не
  // делим на ноль.
  const bow = chordLen * CROSS_BOW_FRACTION;
  const ux = hubDist > 1e-6 ? toHubX / hubDist : 0;
  const uy = hubDist > 1e-6 ? toHubY / hubDist : 0;
  return { x: mx + ux * bow, y: my + uy * bow };
}

// [SF-WEB-55/56] network.on("beforeDrawing", drawEdges) — ctx уже в мировых
// координатах (тот же трюк, что и render.js::_drawRingGuides), так что
// pan/zoom синхронизируются бесплатно, без отдельного пересчёта на нашей
// стороне.
//
// [SF-WEB-56 follow-up] Перф: раньше на каждое ребро был отдельный
// save()/beginPath()/…/stroke()/restore() — save/restore чистая накладная
// стоимость (мы и так явно выставляем globalAlpha/strokeStyle/lineWidth на
// каждое ребро, сохранять/восстанавливать больше нечего), а сам stroke() —
// самая дорогая часть canvas-рисования (растеризация), и она вызывалась
// РОВНО по разу на каждое ребро, на КАЖДЫЙ кадр всей flyout-анимации (не
// разово, как раскладка) — на плотном графе (сотни рёбер) это заметно
// садило FPS именно во время самой анимации разлёта нод, а не до неё.
// Подавляющее большинство рёбер в состоянии покоя делят один и тот же
// {opacity, color, width} (роль ребра фиксирует цвет/ширину, hover/select/
// path — редкие исключения) — группируем по этому стилю и строим ОДИН путь
// (несколько moveTo/curveTo) на группу, так что stroke() вызывается по разу
// НА СТИЛЬ (обычно единицы), а не по разу на ребро (были бы сотни).
export function drawEdges(ctx) {
  if (!_cache.size || !State.network) return;
  const positions   = State.network.getPositions();
  const hoveredIds  = getHoveredEdgeIds();
  const selectedId  = State.selectedEdgeId;
  const onPathSet   = _pathEdgeKeySet(State.pathHighlight);
  const degradeCurves = _cache.size > CURVE_DEGRADE_EDGE_THRESHOLD;

  const groups = new Map();  // "color|opacity|width" → { color, opacity, width, segments: [...] }

  for (const [edgeId, meta] of _cache) {
    const from = positions[meta.from];
    const to   = positions[meta.to];
    if (!from || !to) continue;  // нода вне текущего DataSet (устаревший кэш) — пропускаем, не рисуем мусор

    const isSelected = edgeId === selectedId;
    const isHovered  = hoveredIds.has(edgeId);
    const onPath      = onPathSet.has(edgeId);

    let opacity = BASE_OPACITY, color = meta.color, width = meta.width;
    if (isSelected)    { opacity = SELECT_OPACITY; color = lightenHexColor(meta.color, 0.35); width = meta.width + 2; }
    else if (isHovered) { opacity = HOVER_OPACITY; color = lightenHexColor(meta.color, 0.35); width = meta.width + 1.4; }
    else if (onPath)    { opacity = PATH_OPACITY; color = COLOR.neon; width = meta.width + 2; }

    const control = _curvePoint(meta, from, to, positions, degradeCurves);

    const key = `${color}|${opacity}|${width}`;
    let group = groups.get(key);
    if (!group) { group = { color, opacity, width, segments: [] }; groups.set(key, group); }
    group.segments.push({ from, to, control });
  }

  for (const group of groups.values()) {
    ctx.globalAlpha = group.opacity;
    ctx.strokeStyle = group.color;
    ctx.lineWidth   = group.width;
    ctx.beginPath();
    for (const { from, to, control } of group.segments) {
      ctx.moveTo(from.x, from.y);
      if (control) ctx.quadraticCurveTo(control.x, control.y, to.x, to.y);
      else ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;  // нейтральное состояние для того, что vis.js рисует дальше
}
