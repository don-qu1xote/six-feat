// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/highlight.js — applyDimState and everything feeding it:
//   hover-node / hover-edge partial updates, path three-level dimming,
//   the "default" full-graph restore, and the default-color cache.
//
// ТЗ-204: applyDimState — единая точка входа для затемнения/подсветки графа
// ────────────────────────────────────────────────────────────────────────────
// Раньше highlightNeighborhood/highlightEdgePair/highlightPath/
// restoreDefaultColors независимо строили похожие, но не идентичные наборы
// {color, opacity} с магическими числами (0.08, 0.10, 0.12, 0.02),
// разбросанными по двум файлам. Теперь один applyDimState(mode, focusIds)
// решает уровень прозрачности/цвета через общую таблицу DIM_LEVELS
// (state.js) — единственное место, которое нужно поправить, если ТЗ вроде
// ТЗ-201/ТЗ-203 снова захочет подправить "затемнение".
//
// mode:
//   "hover"   — hover по ноде: focusIds = { nodeId }
//   "edge"    — hover по ребру: focusIds = { edgeId }
//   "path"    — three-level path highlight: focusIds = { path: [...] }
//   "default" — снять любую подсветку, вернуть дефолтные цвета
//
// Старые публичные функции (highlightNeighborhood, highlightEdgePair,
// restoreDefaultColors, highlightPath) остаются экспортированы как тонкие
// обёртки над applyDimState — обратная совместимость с attachNetworkEvents
// и остальными существующими вызовами.
//
// Оптимизации:
//  1. node-hover и edge-hover больше НЕ гасят остальной граф — каждый
//     обновляет только одну ноду/ребро (наведённый элемент подсвечивается
//     ярче своего акцентного цвета, всё остальное остаётся как было).
//     Раньше это был O(N) батч по всем нодам/рёбрам при каждом движении
//     мыши; теперь операция O(1) вне зависимости от размера графа, поэтому
//     ограничение по числу рёбер (использовавшееся раньше для отключения
//     hover на больших графах) больше не нужно ни для одного из двух путей.
//  2. "default" — батч-update только изменившихся элементов через Map для
//     O(1) lookup вместо find().
//  3. hover/edge — debounced на requestAnimationFrame, не дублируем при
//     быстром движении мыши.
//  4. ПЕРФ (лаги при наведении на графах с большим числом рёбер/хабами):
//     пункты 1-3 выше не были фактически O(1)/O(степень ноды) — каждый
//     lookup ноды/ребра по id всё ещё шёл через State.graphNodes.find()/
//     State.graphEdges.find(), O(N)/O(E). Хуже того, _applyHoverNodeEdges
//     сканировала ВСЕ рёбра графа (O(E)) чтобы найти инцидентные наведённой
//     ноде, и для КАЖДОГО найденного ребра снова звала _hoverEdgeUpdate(),
//     которая опять делала find() по всем рёбрам — итого O(E + degree·E)
//     синхронной работы на каждый hoverNode. На графе с сотнями рёбер и
//     хаб-нодой (degree ~50) это десятки тысяч сравнений в одном
//     rAF-колбэке — заметная просадка кадра при каждом движении мыши.
//     Фикс: _nodeById/_edgeById (Map<id, объект>) + _edgeIdsByNode
//     (Map<nodeId, edgeId[]>, adjacency-индекс) строятся один раз в
//     buildDefaultColorCache() (та же точка инвалидации, что и у
//     _defaultNodeColors/_defaultEdgeColors — см. invalidateColorCache) и
//     дают настоящий O(1) lookup по id и O(degree) обход инцидентных рёбер
//     вместо O(E) на каждый hover.
// ════════════════════════════════════════════════════════════════════════════
import { State, COLOR, PATH_HIGHLIGHT_LEVELS, DIM_LEVELS } from "../state/state.js";
import { roleStyle, placeholderFor } from "../state/helpers.js";
import { edgeWidthForWeight, seedShadow, _imageFieldsFor, resolveEdgeDominantRole, lightenHexColor } from "./visuals.js";

// Кэш «дефолтного» состояния нод и рёбер для быстрого mode="default".
// Заполняется в buildDefaultColorCache() при каждом изменении графа.
let _defaultNodeColors = null;  // Map<id, {border, shadow}>
let _defaultEdgeColors = null;  // Map<id, color>

// ПЕРФ (см. пункт 4 в шапке файла): O(1) id→объект lookup вместо
// State.graphNodes.find()/State.graphEdges.find() (O(N)/O(E) каждый),
// плюс готовый adjacency-индекс вместо пересканирования всех рёбер графа
// ради инцидентных наведённой ноде. Строятся вместе с _defaultNodeColors/
// _defaultEdgeColors (та же инвалидация), т.к. источник тот же самый
// проход по State.graphNodes/graphEdges.
let _nodeById      = null;  // Map<id, graphNode>
let _edgeById      = null;  // Map<id, graphEdge>
let _edgeIdsByNode = null;  // Map<nodeId, edgeId[]>

// Called by graph.js whenever State.graphNodes/graphEdges change.
export function invalidateColorCache() {
  _defaultNodeColors = null;
  _defaultEdgeColors = null;
  _nodeById = null;
  _edgeById = null;
  _edgeIdsByNode = null;
}

export function buildDefaultColorCache() {
  _defaultNodeColors = new Map();
  _defaultEdgeColors = new Map();
  _nodeById = new Map();
  _edgeById = new Map();
  _edgeIdsByNode = new Map();
  for (const n of State.graphNodes) {
    _nodeById.set(n.id, n);
    _edgeIdsByNode.set(n.id, []);
    _defaultNodeColors.set(n.id, {
      // Баг "ноды подсвечиваются серым": фоллбэк на случай отсутствующего
      // n._dimBorder был жёстко зашит как rgba(40,48,68,...) — это ровно
      // старый COLOR.line, тот самый серый, из-за которого была первая
      // версия этого бага. _dimBorder действительно всегда должен быть
      // проставлен refreshNodeDimBorders(), но раз фоллбэк реально
      // срабатывает где-то в проде — меняем его на приглушённый вариант
      // --primary2, а не на цвет линий канвы.
      border: n._dimBorder || "rgba(143,166,201,0.25)",
      shadow: n.isSeed ? seedShadow() : { enabled: false }
    });
  }
  for (const e of State.graphEdges) {
    _edgeById.set(e.id, e);
    _defaultEdgeColors.set(e.id, roleStyle(e.dominantRole).color);
    if (_edgeIdsByNode.has(e.from)) _edgeIdsByNode.get(e.from).push(e.id);
    if (_edgeIdsByNode.has(e.to))   _edgeIdsByNode.get(e.to).push(e.id);
  }
}

// Lazily (re)builds the caches above on first use after invalidation —
// same guard pattern _defaultEdgeUpdate/_applyDefault already used for
// _defaultNodeColors/_defaultEdgeColors, just centralized for the three
// lookup-only helpers below.
function _getNode(id) {
  if (!_nodeById) buildDefaultColorCache();
  return _nodeById.get(id);
}
function _getEdge(id) {
  if (!_edgeById) buildDefaultColorCache();
  return _edgeById.get(id);
}
function _getEdgeIdsForNode(nodeId) {
  if (!_edgeIdsByNode) buildDefaultColorCache();
  return _edgeIdsByNode.get(nodeId) || [];
}

// БАГ (этот патч): раньше _hlRafId был ОДНИМ общим requestAnimationFrame-id
// для дебаунса и node-hover, и edge-hover одновременно. Из-за
// interaction.hoverConnectedEdges: true (см. events.js) наведение
// на ноду синхронно шлёт от vis.js не только hoverNode, но и hoverEdge для
// КАЖДОГО подключённого к ней ребра — всё в одном тике. Каждый такой вызов
// делал cancelAnimationFrame(_hlRafId) и перезаписывал _hlRafId своим
// собственным rAF, отменяя ещё не выполнившийся кадр предыдущего hover-а.
// Итог: из всей пачки hoverNode+hoverEdge×N реально красился только
// ПОСЛЕДНИЙ запланированный — обычно одно из рёбер, а не сама нода, и
// _hoveredNodeId/_hoveredEdgeId (проставляются только ВНУТРИ rAF-колбэка)
// оставались рассинхронизированы с тем, что реально произошло на канве.
// Дальше это било по _applyDefault(): на blur, если ни _hoveredNodeId, ни
// _hoveredEdgeId не оказались проставлены (их rAF отменён гонкой выше),
// функция проваливалась в полный батч-сброс ВСЕГО графа — отсюда "все
// ноды и рёбра пропадают/сереют". Поскольку это относится к эфемерному
// состоянию отдельного hover-а, а не к настоящему сбросу вида, следующий
// hover уже не мог красиво "снять" эту подсветку — только новый такой же
// батч-сброс на следующем blur, отсюда ощущение "работает в одну сторону".
// Фикс — два отдельных rAF-id, чтобы node-hover и edge-hover дебаунсились
// независимо и не отменяли кадры друг друга.
let _hoverNodeRafId = null;
let _hoverEdgeRafId = null;

// Отслеживаем id последней подсвеченной ховером ноды, чтобы «default»
// мог откатить именно её, не трогая остальной граф (см. _applyHoverNode).
let _hoveredNodeId = null;

// Экспортируется, чтобы destroyNetwork()/clearGraphForPathSearch() могли
// сбросить оба id при полной пересборке графа — иначе устаревший
// _hoveredNodeId/_hoveredEdgeId от предыдущего графа мог бы вызвать
// безобидный, но лишний update() по несуществующему id на новом графе.
export function resetHoverState() {
  _hoveredNodeId = null;
  _hoveredEdgeIds.clear();
  _pendingHoverEdgeIds.clear();
  if (_hoverNodeRafId) { cancelAnimationFrame(_hoverNodeRafId); _hoverNodeRafId = null; }
  if (_hoverEdgeRafId) { cancelAnimationFrame(_hoverEdgeRafId); _hoverEdgeRafId = null; }
}

// Used by events.js dragStart: cancels any not-yet-applied hover rAF without
// rolling back already-applied hover colors (unlike clearHoverHighlight,
// which also reverts applied state) — dragStart only needs to stop a hover
// update from landing mid-drag, not repaint the graph.
export function cancelPendingHover() {
  if (_hoverNodeRafId) { cancelAnimationFrame(_hoverNodeRafId); _hoverNodeRafId = null; }
  if (_hoverEdgeRafId) { cancelAnimationFrame(_hoverEdgeRafId); _hoverEdgeRafId = null; }
}

function _applyHoverNode(nodeId) {
  if (!State.nodesDS) return;

  if (_hoverNodeRafId) cancelAnimationFrame(_hoverNodeRafId);
  _hoverNodeRafId = requestAnimationFrame(() => {
    _hoverNodeRafId = null;
    if (!State.nodesDS) return;

    // _accent берём из State.graphNodes, а НЕ из nodesDS.get() —
    // vis.js DataSet не сохраняет кастомные поля (_accent, _dimBorder)
    // после обновлений нод через nodesDS.update(), они молча теряются.
    // graphNodes — единственный надёжный источник истины для этих полей.
    const graphNode = _getNode(nodeId);
    if (!graphNode) return;
    const accentColor = graphNode._accent || COLOR.pulse;
    const isSeedNode  = graphNode.isSeed;

    _hoveredNodeId = nodeId;
    try {
      State.nodesDS.update({
        id: nodeId,
        ..._imageFieldsFor(graphNode),
        color: { border: accentColor, background: COLOR.panel },
        borderWidth: 3,
        shadow: {
          enabled: true,
          color: isSeedNode ? "rgba(94,230,197,0.65)" : `${accentColor}90`,
          size:  isSeedNode ? 26 : 20,
          x: 0, y: 0
        }
      });
    } catch (err) {
      // Ховер — самое частое и самое "хрупкое по времени" взаимодействие с
      // графом (может пересечься с перерасчётом физики, пересборкой
      // DataSet и т.д.). Что бы ни пошло не так внутри vis.js — это не
      // повод ронять/подвешивать весь граф, просто отменяем hover.
      console.warn("hover node update failed", err);
      _hoveredNodeId = null;
    }

    _applyHoverNodeEdges(nodeId);
  });
}

function _clearHoveredNode() {
  if (_hoveredNodeId == null || !State.nodesDS) return;
  const graphNode = _getNode(_hoveredNodeId);
  if (graphNode) {
    const isExpanded = State.expandedNodes.has(graphNode.id);
    const defaultBorderWidth = graphNode.isSeed ? 5 : (isExpanded ? 4 : 2);
    const defaultShadow = graphNode.isSeed ? seedShadow() : { enabled: false };
    const dimBorder = graphNode._dimBorder || "rgba(143,166,201,0.25)";
    try {
      State.nodesDS.update({
        id: _hoveredNodeId,
        ..._imageFieldsFor(graphNode),
        color: { border: dimBorder, background: COLOR.panel },
        borderWidth: defaultBorderWidth,
        shadow: defaultShadow
      });
    } catch (err) {
      console.warn("hover node clear failed", err);
    }
  }
  _hoveredNodeId = null;
}

// БАГ (структурный, "подсветка соседних нод/рёбер работает некорректно" +
// "выделение остаётся после ухода мыши"): interaction.hoverConnectedEdges
// (см. events.js) заставляет vis.js слать по ОДНОМУ hoverEdge на
// КАЖДОЕ ребро наведённой ноды синхронно, всё в одном тике. Раньше здесь
// был единственный _hoveredEdgeId + единственный debounce-id: каждый
// hoverEdge отменял rAF предыдущего, так что из всей пачки реально
// красилось (и потом откатывалось) только последнее по порядку ребро —
// остальные, у которых события всё же долетели до vis.js, взгляд игнорировал.
// А clearHoverHighlight()/_applyDefault() ниже откатывали ТОЛЬКО ноду ИЛИ
// ТОЛЬКО ребро (return сразу после первого совпадения) — если у ноды
// подсвечены и она сама, и ребро одновременно (обычный случай при
// hoverConnectedEdges), один blur-вызов откатывал лишь одно из двух,
// второе оставалось подсвеченным до случайного следующего blur-события.
// Фикс: _hoveredEdgeIds — Set (а не один id), накопление всех edgeId,
// пришедших в течение одного кадра, и откат — это всегда откат ОБОИХ
// (ноды и всех рёбер), а не return после первого.
let _hoveredEdgeIds = new Set();
let _pendingHoverEdgeIds = new Set();

// Фиксированная прибавка к базовой ширине ребра (edgeWidthForWeight) для
// hover-подсветки. Раньше ширина считалась приращением к ТЕКУЩЕЙ ширине из
// DataSet ((ed.width || 1.5) + 2) — при повторных наведениях на одну и ту
// же ноду/ребро без ухода мыши (rAF планируется заново на каждый
// hoverNode/hoverEdge) это раз за разом брало уже увеличенную предыдущим
// наведением ширину и прибавляло ещё, так что ширина ребра росла без
// ограничений (см. IDEA-40). Считаем ширину АБСОЛЮТНО от веса ребра —
// один и тот же результат при любом числе повторных наведений.
const HOVER_EDGE_WIDTH_DELTA = 2;

// IDEA-40: фиксированная прибавка к базовой ширине для ПЕРСИСТЕНТНОЙ подсветки
// выбранного (кликнутого) ребра — больше, чем hover-дельта, чтобы "выбрано"
// визуально отличалось от простого наведения на другое ребро.
const SELECTED_EDGE_WIDTH_DELTA = 3;

// ТЗ (контраст hover): раньше на hover ребро просто поднималось до
// opacity:1 в своём обычном (приглушённом) цвете роли — разница с
// default (opacity 0.40, тот же цвет) была только в прозрачности,
// сам оттенок не менялся, из-за чего подсветка читалась слабо.
// Теперь берём заранее осветлённый _brightColor (см. edgeVisual) —
// hover-ребро одновременно ярче цветом, полностью непрозрачно и
// заметно толще, три сигнала вместо одного. Общая для _applyHoverEdge
// и _applyHoverNodeEdges (IDEA-37), чтобы оба пути красили ребро
// идентично и откатывались одинаково через _clearHoveredEdge.
function _hoverEdgeUpdate(edgeId) {
  // IDEA-40: выбранное (кликнутое, State.selectedEdgeId) ребро уже несёт
  // свою персистентную подсветку (см. selectEdge/_selectedEdgeUpdate ниже) —
  // hover (напрямую или через _applyHoverNodeEdges при наведении на одну из
  // его нод) не должен её временно перекрашивать/утончать, иначе на blur
  // пришлось бы отличать "откатить hover" от "откатить выбор".
  if (edgeId === State.selectedEdgeId) return null;
  const ed = State.edgesDS.get(edgeId);
  if (!ed) return null;
  const edgeColor = ed._brightColor || ed._color || COLOR.pulse;
  const graphEdge = _getEdge(edgeId);
  const weight = graphEdge && Number(graphEdge.weight) > 0 ? Number(graphEdge.weight) : 1;
  return {
    id: edgeId,
    color: { color: edgeColor, opacity: 1 },
    width: edgeWidthForWeight(weight) + HOVER_EDGE_WIDTH_DELTA
  };
}

// IDEA-37: hover ноды подсвечивает ВСЕ инцидентные ей рёбра, вычисленные
// напрямую из State.graphEdges (O(степень ноды): e.from === nodeId ||
// e.to === nodeId) — независимо от interaction.hoverConnectedEdges и от
// FAST_RENDER_EDGE_THRESHOLD (events.js), который на графах с >150 рёбер
// отключает per-edge hoverEdge целиком и на двух-хабовых графах оставлял
// ноду без единой подсвеченной связи. Накапливаем id в тот же
// _hoveredEdgeIds, что и _applyHoverEdge, — откат идёт общим
// _clearHoveredEdge.
function _applyHoverNodeEdges(nodeId) {
  if (!State.edgesDS) return;
  const upd = [];
  for (const edgeId of _getEdgeIdsForNode(nodeId)) {
    const u = _hoverEdgeUpdate(edgeId);
    if (!u) continue;
    _hoveredEdgeIds.add(edgeId);
    upd.push(u);
  }
  if (upd.length) {
    try { State.edgesDS.update(upd); }
    catch (err) { console.warn("hover node edges update failed", err); }
  }
}

function _applyHoverEdge(edgeId) {
  if (!State.edgesDS || !State.network) return;

  _pendingHoverEdgeIds.add(edgeId);
  if (_hoverEdgeRafId != null) return;  // уже запланирован — заберёт весь набор разом

  _hoverEdgeRafId = requestAnimationFrame(() => {
    _hoverEdgeRafId = null;
    if (!State.edgesDS) return;

    const ids = [..._pendingHoverEdgeIds];
    _pendingHoverEdgeIds.clear();

    const upd = [];
    for (const edgeId of ids) {
      const u = _hoverEdgeUpdate(edgeId);
      if (!u) continue;
      _hoveredEdgeIds.add(edgeId);
      upd.push(u);
    }
    if (upd.length) {
      try { State.edgesDS.update(upd); }
      catch (err) { console.warn("hover edge update failed", err); }
    }
  });
}

// Общий билдер "вернуть ребро к дефолтному виду" — используется и батчем
// _clearHoveredEdge (hover-откат), и clearSelectedEdge (снятие выбора), и
// _applyDefault (полный сброс), чтобы формула цвета/ширины дефолта не
// расходилась между тремя местами.
function _defaultEdgeUpdate(edgeId) {
  if (!State.edgesDS) return null;
  if (!_defaultEdgeColors) buildDefaultColorCache();
  const ed = State.edgesDS.get(edgeId);
  if (!ed) return null;
  const color = _defaultEdgeColors.get(edgeId) || (ed._color || COLOR.pulse);
  const graphEdge = _getEdge(edgeId);
  const weight = graphEdge ? (Number(graphEdge.weight) > 0 ? Number(graphEdge.weight) : 1) : 1;
  return { id: edgeId, color: { color, opacity: 0.45 }, width: edgeWidthForWeight(weight) };
}

function _clearHoveredEdge() {
  if (_hoveredEdgeIds.size === 0 || !State.edgesDS) return;

  const upd = [];
  for (const edgeId of _hoveredEdgeIds) {
    // IDEA-40: выбранное ребро не откатывается по hover-blur — оно и так
    // никогда не должно было попасть в _hoveredEdgeIds (см. guard в
    // _hoverEdgeUpdate), но проверяем явно, на случай если в будущем
    // появится ещё один путь наполнения этого Set-а.
    if (edgeId === State.selectedEdgeId) continue;
    const u = _defaultEdgeUpdate(edgeId);
    if (u) upd.push(u);
  }
  if (upd.length) {
    try { State.edgesDS.update(upd); }
    catch (err) { console.warn("hover edge clear failed", err); }
  }
  _hoveredEdgeIds.clear();
}

// ─── Persistent edge selection (IDEA-40) ───────────────────────────────────
// Клик по ребру (ui/sidebar.js::showEdgeSidebar) раньше вызывал
// highlightEdgePair(), которое заводит ту же ВРЕМЕННУЮ hover-подсветку, что
// и наведение мышью — State.selectedEdgeId нигде не выставлялся, поэтому
// уход курсора (blurEdge → clearHoverHighlight) откатывал "выбранное" ребро
// к дефолту как обычный hover-out. selectEdge/clearSelectedEdge ниже — это
// отдельный от hover путь: пишут напрямую в edgesDS, не участвуют в
// _hoveredEdgeIds, и потому не могут быть случайно откачены hover-логикой
// (см. guard в _hoverEdgeUpdate/_clearHoveredEdge выше).
function _selectedEdgeUpdate(edgeId) {
  if (!State.edgesDS) return null;
  const ed = State.edgesDS.get(edgeId);
  if (!ed) return null;
  const graphEdge = _getEdge(edgeId);
  const weight = graphEdge && Number(graphEdge.weight) > 0 ? Number(graphEdge.weight) : 1;
  return {
    id: edgeId,
    color: { color: COLOR.neon, opacity: 1 },
    width: edgeWidthForWeight(weight) + SELECTED_EDGE_WIDTH_DELTA
  };
}

// Выставляет State.selectedEdgeId и красит ребро в устойчивый (не зависящий
// от hover/blur) стиль. Одновременно выбранным может быть только одно
// ребро — если уже было выбрано другое, оно сначала возвращается к дефолту.
export function selectEdge(edgeId) {
  if (State.selectedEdgeId != null && State.selectedEdgeId !== edgeId) {
    const prevUpd = _defaultEdgeUpdate(State.selectedEdgeId);
    State.selectedEdgeId = null;
    if (prevUpd && State.edgesDS) {
      try { State.edgesDS.update(prevUpd); }
      catch (err) { console.warn("selected edge revert failed", err); }
    }
  }

  State.selectedEdgeId = edgeId;
  const upd = _selectedEdgeUpdate(edgeId);
  if (upd && State.edgesDS) {
    try { State.edgesDS.update(upd); }
    catch (err) { console.warn("select edge update failed", err); }
  }
}

// Снимает выбор (если он есть) и возвращает ребро к дефолтному виду.
// Вызывается из clearFocus/hideArtistSidebar (см. events.js/ui/sidebar.js) —
// т.е. при клике по пустому месту, закрытии сайдбара, выборе другой ноды.
export function clearSelectedEdge() {
  if (State.selectedEdgeId == null) return;
  const prevUpd = _defaultEdgeUpdate(State.selectedEdgeId);
  State.selectedEdgeId = null;
  if (prevUpd && State.edgesDS) {
    try { State.edgesDS.update(prevUpd); }
    catch (err) { console.warn("clear selected edge failed", err); }
  }
}

// Вызывается из blurNode/blurEdge — это НЕ то же самое, что "снять всю
// подсветку и вернуть граф к дефолту" (см. _applyDefault ниже, mode=
// "default", всё ещё используется clearFocus()/новым setFocus()/сбросом
// path-подсветки). blur — это всегда реакция на конкретный hover, который
// либо уже что-то перекрасил (тогда откатываем именно это), либо ещё не
// успел отрисоваться (см. большой комментарий над _hoverNodeRafId — его
// rAF мог быть отменён гонкой node/edge-hover'ов) — тогда откатывать
// нечего, канва и так в дефолтном состоянии, и батч-сброс всего графа тут
// не нужен и только создаёт видимый "мигаем в серый" эффект на каждый
// hover-out.
//
// Откатываем И ноду, И рёбра безусловно (не return после первого) —
// hoverConnectedEdges обычно подсвечивает и то, и другое одновременно, и
// оставлять одно из двух подсвеченным после ухода мыши — ровно тот баг,
// который чинит эта функция.
//
// БАГ (подсветка "не там, где курсор", стабильно воспроизводится в плотных
// зонах графа — много нод/рёбер близко друг к другу, например вокруг
// seed'а): vis.js гарантирует порядок blur(A)→hover(B) только ВНУТРИ ОДНОГО
// mousemove — для соседних/пересекающихся hit-областей курсор может за один
// кадр пересечь несколько нод, и тогда несколько пар blur/hover приходят
// одна за другой, каждая синхронно, ДО того как rAF первой обработанной
// hover-подсветки успевает выполниться. Раньше clearHoverHighlight() не
// знала, ДЛЯ какой ноды пришёл конкретный blur, — она просто откатывала то,
// что СЕЙЧАС лежит в _hoveredNodeId. Если к моменту обработки такого
// (устаревшего) blur свежий hover для ДРУГОЙ ноды уже успел выполнить свой
// rAF и переставить _hoveredNodeId, устаревший blur всё равно откатывал ЕЁ —
// снимал подсветку с ноды, которую курсор реально наводит СЕЙЧАС, оставляя
// на экране либо старую, либо вообще никакую подсветку — то есть
// "подсвечено не то, над чем курсор". Фикс: blurNode передаёт id ноды,
// которую он реально блюрит (params.node, см. events.js); откатываем ноду
// только если он всё ещё совпадает с _hoveredNodeId — иначе это устаревший
// blur для уже вытесненной ноды, и трогать нечего (новую, актуальную
// подсветку оставляем как есть — её отменит её собственный будущий blur).
// blurEdge по-прежнему не передаёт id (второй параметр остаётся undefined)
// — поведение для рёбер не меняется.
export function clearHoverHighlight(blurredNodeId) {
  if (_hoverNodeRafId) { cancelAnimationFrame(_hoverNodeRafId); _hoverNodeRafId = null; }
  if (_hoverEdgeRafId) { cancelAnimationFrame(_hoverEdgeRafId); _hoverEdgeRafId = null; }
  _pendingHoverEdgeIds.clear();

  if (blurredNodeId !== undefined && blurredNodeId !== _hoveredNodeId) return;

  if (_hoveredNodeId != null) _clearHoveredNode();
  if (_hoveredEdgeIds.size > 0) _clearHoveredEdge();
  // Если ни то, ни другое не сработало — подсветки фактически не было
  // (или она не успела долететь до канвы), граф уже выглядит как
  // дефолтный, трогать нечего.
}

function _applyDefault() {
  if (!State.nodesDS || !State.edgesDS) return;
  if (_hoverNodeRafId) { cancelAnimationFrame(_hoverNodeRafId); _hoverNodeRafId = null; }
  if (_hoverEdgeRafId) { cancelAnimationFrame(_hoverEdgeRafId); _hoverEdgeRafId = null; }
  _pendingHoverEdgeIds.clear();

  // Ховер теперь трогает только наведённую ноду + её рёбра (см.
  // _applyHoverNode/_applyHoverEdge) — здесь достаточно откатить именно
  // их, не перестраивая весь граф батчем. Оба отката безусловны (не
  // return после первого) — см. комментарий у clearHoverHighlight.
  let hadHover = false;
  if (_hoveredNodeId != null)   { _clearHoveredNode(); hadHover = true; }
  if (_hoveredEdgeIds.size > 0) { _clearHoveredEdge(); hadHover = true; }
  if (hadHover) return;

  // Используем кэш вместо повторного вычисления shadow/border для каждой ноды.
  if (!_defaultNodeColors) buildDefaultColorCache();

  const nU = [], eU = [];
  _defaultNodeColors.forEach(({ border, shadow }, id) => {
    const graphNode = _getNode(id);
    nU.push({ id, ..._imageFieldsFor(graphNode), color: { border, background: COLOR.panel }, opacity: DIM_LEVELS.off, shadow });
  });
  _defaultEdgeColors.forEach((color, id) => {
    // IDEA-40: полный batch-сброс (например, из clearPathHighlight) не
    // должен откатывать персистентно выбранное ребро — оно возвращается к
    // дефолту только через clearSelectedEdge (клик по пустому месту, закрытие
    // сайдбара, выбор другого ребра/ноды), не как побочный эффект пути,
    // изначально не связанного с выбором ребра.
    if (id === State.selectedEdgeId) return;
    eU.push({ id, color: { color, opacity: 0.45 } });
  });
  if (nU.length) State.nodesDS.update(nU);
  if (eU.length) State.edgesDS.update(eU);
}

// ─── Theme recolor in place (SF-WEB-13) ────────────────────────────────────
// setTheme (ui/theme.js) used to reuse refreshNetwork() (render.js) to
// repaint an already-drawn graph after a dark/light flip — but refreshNetwork
// ends with nodesDS/edgesDS.clear()+add() followed by nudgePhysics(), so a
// plain theme toggle re-enabled physics and let expanded clusters/leaves
// drift from wherever the user had settled them, just to repaint colours.
// recolorInPlace instead patches only the colour-bearing fields of the
// nodes/edges that already exist via nodesDS.update()/edgesDS.update() — no
// clear()/add(), no moveNode/nudgePhysics — so positions and physics state
// are left exactly as they were.
//
// Mirrors the same border/shadow formula nodeVisual (visuals.js) uses for a
// node's resting (non-hover/non-path) appearance. theme.js calls
// refreshNodeDimBorders() (graph.js) right before this, which already
// refreshed n._accent/n._dimBorder for the new theme — read here from
// State.graphNodes rather than recomputed a second time.
export function recolorInPlace(nameById) {
  if (!State.nodesDS || !State.edgesDS) return;

  const nU = State.graphNodes.map(n => {
    const isExpanded = State.expandedNodes.has(n.id);
    const accent      = n._accent;
    const dimBorder   = n._dimBorder || "rgba(143,166,201,0.25)";
    const borderColor = isExpanded ? accent : dimBorder;

    let shadow;
    if (n.isSeed)        shadow = seedShadow();
    else if (isExpanded) shadow = { enabled: true, color: `${accent}30`, size: 12, x: 0, y: 0 };
    else                  shadow = { enabled: false };

    // ТЗ-16 (спринт 3 — placeholderFor станет тема-зависимым): узлы без
    // настоящего Genius-фото рисуют placeholderFor(), чей accent-цвет
    // берётся из COLOR.signal/COLOR.pulse — перекрашиваем аватар под новую
    // тему. Узлы с реальным imageUrl не трогаем.
    const imageUpdate = n.imageUrl ? {} : {
      image:       placeholderFor(n.name, n.isSeed),
      brokenImage: placeholderFor(n.name, n.isSeed)
    };

    return {
      id: n.id,
      _accent:    accent,
      _dimBorder: dimBorder,
      color: {
        border:     borderColor,
        background: COLOR.panel,
        hover:      { border: accent, background: COLOR.panel }
      },
      shadow,
      ...imageUpdate
    };
  });

  const eU = State.graphEdges.map(e => {
    const color       = roleStyle(resolveEdgeDominantRole(e)).color;
    const brightColor = lightenHexColor(color, 0.35);
    return {
      id: e.id,
      color: { color, opacity: 0.40 },
      _color:       color,
      _brightColor: brightColor
    };
  });

  if (nU.length) State.nodesDS.update(nU);
  if (eU.length) State.edgesDS.update(eU);
}

// ─── Path highlight (moved here from analytics-client.js — ТЗ-204) ────────
// analytics-client.js остаётся чисто про BFS-математику без DOM/vis.js-знания;
// всё, что трогает nodesDS/edgesDS, живёт здесь рядом с остальными
// highlight-функциями.

function isNodeExpanded(nodeId) {
  return State.expandedNodes && State.expandedNodes.has(nodeId);
}

function isEdgeInExpandedTree(fromId, toId) {
  if (!State.expandedNodes || State.expandedNodes.size === 0) return false;
  return State.expandedNodes.has(fromId) && State.expandedNodes.has(toId);
}

function getNodeHighlightLevel(nodeId, pathSet) {
  if (pathSet.has(nodeId)) return "onPath";
  if (isNodeExpanded(nodeId)) return "expandedOffPath";
  return "neverTouched";
}

function getEdgeHighlightLevel(fromId, toId, pathEdgesSet) {
  const lo = Math.min(fromId, toId);
  const hi = Math.max(fromId, toId);
  const edgeKey = `${lo}_${hi}`;

  if (pathEdgesSet.has(edgeKey)) return "onPath";
  if (isEdgeInExpandedTree(fromId, toId)) return "expandedOffPath";
  return "neverTouched";
}

function _applyPath(path) {
  if (!State.nodesDS || !State.edgesDS || !path) return;

  const pathSet   = new Set(path);
  const pathEdges = new Set();

  for (let i = 0; i < path.length - 1; i++) {
    const lo = Math.min(path[i], path[i + 1]);
    const hi = Math.max(path[i], path[i + 1]);
    pathEdges.add(`${lo}_${hi}`);
  }

  const nodeIds = State.nodesDS.getIds();
  const nU = nodeIds.map(id => {
    const level  = getNodeHighlightLevel(id, pathSet);
    const config = PATH_HIGHLIGHT_LEVELS[level];
    const graphNode = _getNode(id);

    let borderColor;
    if (level === "onPath")             borderColor = COLOR.neon;
    else if (level === "expandedOffPath") borderColor = "rgba(94,230,197,0.6)";
    else                                   borderColor = "rgba(40,48,68,0.08)";

    return {
      id,
      ..._imageFieldsFor(graphNode),
      color:       { border: borderColor, background: COLOR.panel },
      opacity:     config.opacity,
      borderWidth: config.width
    };
  });

  const edgeIds = State.edgesDS.getIds();
  const eU = edgeIds.map(id => {
    // edge.id is already built as `${min(from,to)}_${max(from,to)}` (see
    // buildEdgeState in graph.js), so _edgeById (keyed by that same id) is
    // an O(1) equivalent of the old O(E) find() that recomputed lo_hi for
    // every edge to match it against `id`.
    const edgeObj = _getEdge(id);

    if (!edgeObj) {
      return { id, color: { color: "rgba(40,48,68,0.02)", opacity: 0.02 }, width: 1 };
    }

    const level  = getEdgeHighlightLevel(edgeObj.from, edgeObj.to, pathEdges);
    const config = PATH_HIGHLIGHT_LEVELS[level];

    let edgeColor = "rgba(40,48,68,0.02)";
    if (level === "onPath")               edgeColor = COLOR.neon;
    else if (level === "expandedOffPath") edgeColor = "rgba(94,230,197,0.5)";

    return { id, color: { color: edgeColor, opacity: config.edgeOpacity }, width: config.edgeWidth };
  });

  State.nodesDS.update(nU);
  State.edgesDS.update(eU);
}

/**
 * ТЗ-204: единая точка входа для всех вариантов затемнения/подсветки.
 * @param {"hover"|"edge"|"path"|"default"} mode
 * @param {{nodeId?, edgeId?, path?}} focusIds
 */
export function applyDimState(mode, focusIds = {}) {
  switch (mode) {
    case "hover":   return _applyHoverNode(focusIds.nodeId);
    case "edge":    return _applyHoverEdge(focusIds.edgeId);
    case "path":    return _applyPath(focusIds.path);
    case "default":
    default:        return _applyDefault();
  }
}

// ─── Тонкие обёртки для обратной совместимости ─────────────────────────────
export function highlightNeighborhood(nodeId) { return applyDimState("hover", { nodeId }); }
export function highlightEdgePair(edgeId)     { return applyDimState("edge",  { edgeId }); }
export function highlightPath(path)           { return applyDimState("path", { path }); }
export function restoreDefaultColors()        { return applyDimState("default"); }
