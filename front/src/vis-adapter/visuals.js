// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/visuals.js — node/edge visual-object builders (nodeVisual/
//                          edgeVisual), sizing, and vis.Network options.
//                          Pure builders: given graph state, produce the
//                          plain objects vis.js's DataSet/Network expect —
//                          no DOM mutation, no network lifecycle here.
// ════════════════════════════════════════════════════════════════════════════
import { State, COLOR, ROLE_PRIORITY } from "../state/state.js";
import { placeholderFor, roleStyle } from "../state/helpers.js";
import { buildNodeTooltip, buildEdgeTooltip } from "./tooltips.js";

// [SF-WEB-45] hexToRgba — same #RRGGBB parsing lightenHexColor already does
// below, reused here so glow colors can carry an explicit alpha instead of
// the `${hex}NN` string-concat shorthand used elsewhere in this file (that
// shorthand only works because those NN suffixes are hand-picked valid hex
// pairs; seedShadow's hero-glow wants a value tuned in normal 0–1 terms).
export function hexToRgba(hex, alpha) {
  hex = hex.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Централити (betweenness) полностью убрана по запросу — раньше здесь была
// betweennessGlow(nodeData), вычислявшая glow-тень по _betweennessNorm.
// Seed получает выраженный hero-glow (см. seedShadow), остальные узлы — свой
// собственный, более сдержанный halo (см. nodeShadowFor) — оба через
// border+shadow, никогда не через opacity в данных ноды (см. большой
// комментарий "Структурный фикс" ниже: opacity:0 на входе исторически ломал
// circularImage — тот баг про fade-in, но урок общий, glow это тоже не
// opacity).
//
// [SF-WEB-45] color берётся из COLOR.signal (живой геттер на CSS-переменную
// --signal, см. state.js) вместо прежнего захардкоженного rgba(94,230,197,…)
// — тот хардкод был ровно тёмной темы, так что seed-glow в светлой теме
// молча оставался тёмно-бирюзовым вместо светлотемного --signal.
export function seedShadow() {
  return { enabled: true, color: hexToRgba(COLOR.signal, 0.55), size: 26, x: 0, y: 0 };
}

// [SF-WEB-45] Единая точка входа для "дефолтного" (не hover, не selected)
// shadow-поля ноды — используется и nodeVisual (первичная сборка), и
// highlight.js (buildDefaultColorCache/_defaultNodeUpdate, т.е. кэш и откат
// к состоянию покоя после hover/selection). Раньше это правило было
// продублировано в nodeVisual один раз и в highlight.js — дважды, каждая
// копия жёстко трактовала любую не-seed ноду как shadow:{enabled:false};
// расширять glow на expanded/leaf-ноды пришлось бы в трёх местах и рано или
// поздно рассинхронизировать. Теперь расширять/менять — только здесь.
export function nodeShadowFor(nodeData) {
  if (nodeData.isSeed) return seedShadow();
  const isExpired = nodeData.isExpired || nodeData.dataExpired || false;
  if (isExpired) return { enabled: false };
  const isExpanded = State.expandedNodes.has(nodeData.id);
  const domRole = nodeData._dominantRole || "primary";
  const accent  = roleStyle(domRole).color;
  return isExpanded
    ? { enabled: true, color: `${accent}30`, size: 12, x: 0, y: 0 }
    : { enabled: true, color: `${accent}22`, size: 6, x: 0, y: 0 };
}

// ════════════════════════════════════════════════════════════════════════════
// FIX #2: Helper to brighten hex colors for edge highlights
// ════════════════════════════════════════════════════════════════════════════
export function lightenHexColor(hex, factor = 0.4) {
  hex = hex.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const newR = Math.min(255, Math.round(r + (255 - r) * factor));
  const newG = Math.min(255, Math.round(g + (255 - g) * factor));
  const newB = Math.min(255, Math.round(b + (255 - b) * factor));
  return "#" + [newR, newG, newB]
    .map(x => x.toString(16).padStart(2, "0").toUpperCase())
    .join("");
}


// ════════════════════════════════════════════════════════════════════════════
// NODE SIZING
// ════════════════════════════════════════════════════════════════════════════

// Все узлы, включая seed, теперь одного фиксированного радиуса — раньше
// размер масштабировался по числу коллабораций (min/max радиус + кривая),
// что делало граф менее предсказуемым визуально и усложняло раскладку.
// totalWeight по-прежнему считаем — он используется в тултипах/сайдбаре
// ("N collabs"), просто больше не влияет на размер круга.
export const FIXED_NODE_RADIUS = 22;

// Экспайред-ноды (устаревшие/неполные данные, см. isExpired в nodeVisual) —
// свой фиксированный радиус, отдельный от обычных листьев. Раньше isExpired
// влиял только на цвет/прозрачность/пунктир границы, а размер брался из
// той же ветки, что и обычный лист (FIXED_NODE_RADIUS) — экспайред-ноды
// визуально не отличались по размеру от свежих. Фиксированный (не
// вычисляемый) и меньше обычного листа — читается как "второстепенная/
// устаревшая" на графе, но остаётся тем же кругом с тем же shape.
export const EXPIRED_NODE_RADIUS = 18;

// IDEA-39: seed и раскрытая (expanded) нода — обе «хабы» графа и должны
// читаться как один и тот же визуальный уровень, поэтому делят один радиус
// вместо прежних 36 (seed) / 24 (expanded). layout.js не завязан на
// конкретное значение радиуса хаба — его зазоры (LEAF_R, EULER_GAP, dR)
// уже считаются с большим запасом (минимум 75px), так что рост expanded-
// радиуса на 12px раскладку не ломает.
export const HUB_RADIUS = 36;

export function computeNodeSizes() {
  if (!State.graphNodes.length) return;

  const weightMap = new Map();
  for (const e of State.graphEdges) {
    const w = e.collaboration_count ?? (e.weight || 1);
    weightMap.set(e.from, (weightMap.get(e.from) || 0) + w);
    weightMap.set(e.to,   (weightMap.get(e.to)   || 0) + w);
  }

  for (const n of State.graphNodes) {
    const w = n._backendWeight || weightMap.get(n.id) || 1;
    n.totalWeight    = w;
    n.computedRadius = FIXED_NODE_RADIUS;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// NODE VISUAL
// ════════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────────
// Структурный фикс "аватарки пропадают на hover/drag": vis.js DataSet.update()
// в теории мержит частичные обновления, но на практике при частых update()
// на узлах с shape:"circularImage" изображение иногда не переживает серию
// апдейтов (особенно если State.nodesDS изначально создавался с opacity:0
// для fade-in, см. nodeVisual). Вместо того чтобы полагаться на то, что
// vis.js сохранит image/shape/brokenImage между вызовами, каждый partial
// update ниже (_applyHoverNode/_clearHoveredNode/_applyDefault/highlightPath)
// теперь явно прикладывает эти поля заново из State.graphNodes — единого
// источника истины. Небольшой лишний трафик в DataSet.update(), но
// гарантирует, что аватарка физически не может "потеряться".
// ────────────────────────────────────────────────────────────────────────────
export function _imageFieldsFor(graphNode) {
  if (!graphNode) return {};
  const image = graphNode.imageUrl || placeholderFor(graphNode.name, graphNode.isSeed);
  return {
    shape: "circularImage",
    image,
    brokenImage: placeholderFor(graphNode.name, graphNode.isSeed)
  };
}

export function nodeVisual(nodeData) {
  const { id, name, imageUrl, isSeed, computedRadius } = nodeData;
  
  const isExpanded = State.expandedNodes.has(id);
  // FIX #3: Add support for expired nodes
  const isExpired = nodeData.isExpired || nodeData.dataExpired || false;
  
  const domRole   = nodeData._dominantRole || (isSeed ? "featured" : "primary");
  const rs        = roleStyle(domRole);
  const image     = imageUrl || placeholderFor(name, isSeed);

  // ─────────────────────────────────────────────────────────────────────────
  // FIX #3: Visual hierarchy - different sizes for different node types
  // ─────────────────────────────────────────────────────────────────────────
  // Все размеры — фиксированные константы по типу ноды, ничего не
  // вычисляется по весу/числу коллабораций (см. FIXED_NODE_RADIUS/
  // EXPIRED_NODE_RADIUS выше и computeNodeSizes, который тоже отдаёт
  // единый FIXED_NODE_RADIUS для всех обычных листьев). isExpired теперь
  // и на размер влияет — экспайред-ноды меньше обычного листа и это тоже
  // фиксированное число, не диапазон.
  let radius;
  if (isSeed || isExpanded) {
    radius = HUB_RADIUS;  // Hubs (seed + expanded) share the same size
  } else if (isExpired) {
    radius = EXPIRED_NODE_RADIUS;  // Expired leaves: fixed, smaller than a normal leaf
  } else {
    radius = computedRadius || FIXED_NODE_RADIUS;  // Leaf nodes: fixed standard size
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FIX #3: Color & accent based on node type
  // ─────────────────────────────────────────────────────────────────────────
  let accent, dimBorder;
  
  if (isSeed) {
    accent = COLOR.signal;            // Turquoise for seed
    dimBorder = "rgba(94,230,197,0.45)";
  } else if (isExpired) {
    accent = COLOR.warn;              // Red/orange for expired
    dimBorder = `${COLOR.warn}40`;
  } else {
    accent = rs.color;                // Role-based color for normal/expanded
    dimBorder = `${rs.color}40`;
  }

  const borderCol  = isExpanded ? accent : dimBorder;

  // ─────────────────────────────────────────────────────────────────────────
  // FIX #3: Border width differentiates node states
  // ─────────────────────────────────────────────────────────────────────────
  let borderWidth, borderWidthSelected;
  if (isSeed || isExpanded) {
    borderWidth = 5;
    borderWidthSelected = 7;
  } else {
    borderWidth = 2;
    borderWidthSelected = 3;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FIX #3 / structural fix: Opacity - faded ТОЛЬКО для expired, никогда 0
  // для новых узлов. nodeData._isNew управлял входной fade-in анимацией,
  // но реальный рендер-пайплайн circularImage у vis.js не гарантирует, что
  // opacity:0 корректно поднимется до 1 при последующем partial-update —
  // на практике узел с изображением, стартовавший с opacity:0, иногда
  // навсегда остаётся визуально "пустым" (видны только рёбра). Поэтому
  // все узлы теперь стартуют полностью видимыми; anything fade-in-подобное
  // должно быть отдельной CSS/RAF-анимацией поверх готового узла, а не
  // частью его базового состояния данных.
  // ─────────────────────────────────────────────────────────────────────────
  const opacity = isExpired ? 0.6 : 1.0;

  // ─────────────────────────────────────────────────────────────────────────
  // FIX #3 / [SF-WEB-45]: Shadow/glow based on node importance — seed gets
  // its pronounced hero-glow, expanded/leaf nodes get their own softer halo,
  // expired nodes stay glow-free (reads as "secondary/stale"). See
  // nodeShadowFor above — same formula highlight.js's default-color cache
  // and hover/selection revert use, so the glow this function paints on
  // first render is exactly what those paths restore afterwards.
  // ─────────────────────────────────────────────────────────────────────────
  const shadow = nodeShadowFor(nodeData);

  // Seed: mass=1 т.к. он зафиксирован (fixed:true) и масса не влияет на физику.
  // Expanded: высокая масса — притягивают листья, но сами не улетают.
  // Leaf: масса 1 — свободно оседают вокруг expanded.
  const mass = isSeed ? 1 : (isExpanded ? 8 : 1);

  return {
    id,
    _accent:    accent,
    _dimBorder: dimBorder,
    shape:  "circularImage",
    image,
    brokenImage: placeholderFor(name, isSeed),
    size:   radius,
    borderWidth,
    borderWidthSelected,
    // Баг: shapeProperties: undefined для не-expired нод заставлял vis.js
    // сбрасывать внутренние параметры circularImage и ломал отрисовку нод
    // (на экране видны только рёбра, ноды невидимы). Используем spread,
    // чтобы shapeProperties попадал в объект только когда нужен.
    ...(isExpired ? { shapeProperties: { borderDashes: [4, 3] } } : {}),
    color: {
      border:     borderCol,
      background: COLOR.panel,
      highlight:  { border: COLOR.paper, background: COLOR.panel },
      hover:      { border: accent,      background: COLOR.panel }
    },
    title:  buildNodeTooltip({ ...nodeData, computedRadius: radius }),
    shadow,
    opacity,
    // Новые expanded не фиксируем заранее — placeExpandedNodes вызовет moveNode
    // и только потом зафиксирует. Иначе vis.js ставит их в (0,0) до moveNode.
    fixed: (isSeed || (isExpanded && !nodeData._isNew)) ? { x: true, y: true } : false,
    mass,
    x: isSeed ? 0 : undefined,
    y: isSeed ? 0 : undefined,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// EDGE VISUAL
// ════════════════════════════════════════════════════════════════════════════

// Единая формула ширины ребра по весу — раньше дублировалась двумя разными
// магическими вариантами (edgeVisual и _clearHoveredEdge), из-за чего смена
// одной легко расходилась с другой. См. edgeVisual для обоснования потолка.
export function edgeWidthForWeight(weight) {
  const w = Number(weight) > 0 ? Number(weight) : 1;
  return Math.min(1 + Math.sqrt(w) * 1.15, 6);
}

export function edgeVisual(e, nameById) {
  const weight = Number(e.weight) > 0 ? Number(e.weight) : 1;
  const role = resolveEdgeDominantRole(e);
  const rs   = roleStyle(role);
  const dashes = false;  // всегда сплошные — dashes медленны и нечитаемы

  // FIX #2: Brighten the color for hover/highlight instead of using gray
  const brightColor = lightenHexColor(rs.color, 0.35);

  // Баг "визуальный перевес рёбра/ноды": при весе ~24+ ширина ребра доходила
  // до 9px — почти половина диаметра листовой ноды (радиус 22px, т.е. 44px),
  // из-за чего толстые рёбра визуально "переедали" примыкающие к ним узлы.
  // Смягчаем кривую роста (меньший коэффициент) и снижаем потолок до 6px —
  // разница в весе всё ещё читается, но ни одно ребро больше не тяжелее
  // самой ноды, к которой оно подходит.
  const width = edgeWidthForWeight(weight);

  return {
    id:     e.id,
    from:   e.from,
    to:     e.to,
    width,
    dashes,
    title:  buildEdgeTooltip(e, nameById),
    color: {
      color:     rs.color,
      // Opacity зависит от размера графа — при 200+ нодах линии тоньше/прозрачнее
      opacity:   0.40,
      inherit:   false,
      hover:     { color: brightColor, opacity: 0.90 },
      highlight: { color: brightColor, opacity: 1.0 }
    },
    // smooth не указываем — берётся глобальный из networkOptions
    // (false при >EDGE_SMOOTH_THRESHOLD рёбрах, dynamic при меньшем).
    _role:  role,
    _color: rs.color,
    // chosen:false (см. networkOptions) отключил встроенный hover/highlight
    // vis.js — эти под-объекты он больше не читает. Но _brightColor тут
    // всё ещё нужен: наш собственный _applyHoverEdge (ниже) берёт готовый
    // осветлённый цвет отсюда вместо пересчёта на каждый hover.
    _brightColor: brightColor
  };
}

export function resolveEdgeDominantRole(e) {
  const roleSet = new Set();
  for (const c of (e.collaborations || []))
    for (const r of (c.roles || [])) roleSet.add(r.toLowerCase());
  if (e.dominant_role)   roleSet.add(e.dominant_role.toLowerCase());
  if (e.role_priority)   roleSet.add(e.role_priority.toLowerCase());
  if (e.dominantRole)    roleSet.add(e.dominantRole.toLowerCase());
  for (const r of ROLE_PRIORITY) {
    if (roleSet.has(r)) return r;
  }
  return "primary";
}

// ════════════════════════════════════════════════════════════════════════════
// NETWORK OPTIONS
// ════════════════════════════════════════════════════════════════════════════

// Порог размера графа (число узлов). SF-WEB-07: exported so physics.js can
// shorten the live-physics settle window and render.js can skip ring-guides
// on the same graphs this treats as "large" — one threshold, not several
// independently-tuned magic numbers.
export const LARGE_GRAPH_NODE_THRESHOLD = 150;

export function networkOptions() {
  // [SF-WEB-51] Физика ДЕМОТИРОВАНА до опционального органик-доводчика и
  // больше НЕ основной решатель раскладки: initNetwork/refreshNetwork/
  // mergeNetwork кладут ноды детерминированно через layout.js
  // (placeExpandedNodes + collision-solver) и сразу фиксируют — стабилизация
  // как раскладка не запускается (enabled:false ниже; init/refresh к тому же
  // явно выключают физику). Раньше на больших графах (>150) выбирался solver
  // "repulsion", у которого В КОНФИГЕ НЕТ avoidOverlap вообще — overlap-
  // избегания в режиме больших графов было ноль. Теперь везде barnesHut с
  // avoidOverlap: 1.0 (единственный overlap-aware solver у vis) и size из
  // nodeVisual (FIXED_NODE_RADIUS) — так короткий пост-drag settle
  // (events.js → nudgePhysics включает физику через setOptions) считает
  // столкновения по реальному радиусу и не даёт нодам налезать, независимо
  // от размера графа. Гарантию неперекрытия при этом даёт не физика, а
  // детерминированный солвер в layout.js — физика лишь мягко доводит.
  const physics = {
    enabled: false,
    solver: "barnesHut",
    barnesHut: {
      gravitationalConstant: -6000,
      centralGravity:        0.05,
      springLength:          170,
      springConstant:        0.04,
      damping:               0.88,
      avoidOverlap:          1.0
    },
    stabilization: { enabled: false },
    timestep:         0.35,
    adaptiveTimestep: true,
    maxVelocity:      60,
    minVelocity:      0.8
  };

  return {
    autoResize: true,
    layout:  { improvedLayout: false },
    // БАГ (краш "Cannot read properties of undefined (reading 'call')" в
    // недрах vis.js рендерера при hover): весь hover/highlight/default
    // покрас нод и рёбер мы делаем сами, напрямую через nodesDS.update()/
    // edgesDS.update() (см. _applyHoverNode/_applyHoverEdge/_applyDefault
    // в vis-adapter/highlight.js) — ЧАСТИЧНЫМИ объектами вида
    // {border,background} для нод и {color,opacity} для рёбер. nodesDS/
    // edgesDS.update() заменяет вложенные объекты целиком, а не мёржит —
    // из-за этого поля color.hover/color.highlight, с которыми нода/ребро
    // были изначально созданы (см. nodeVisual/edgeVisual), после первого же
    // нашего update() пропадают. Но chosen:true (дефолт vis.js) держит СВОЙ,
    // встроенный, НЕЗАВИСИМЫЙ от нашего кода механизм перекраски при hover/
    // selection — он тоже читает color.hover/color.highlight на каждый
    // релевантный кадр, и натыкаясь на выпиленные нашим update() поля,
    // падал в глубине рендерера. Две параллельные системы (наша ручная +
    // встроенная chosen) никогда не должны были работать одновременно на
    // одних и тех же данных — раз перекраску полностью ведёт наш код,
    // встроенную отключаем целиком, а не пытаемся аккуратно сохранять все
    // под-объекты в каждом partial-update.
    nodes:   { shapeProperties: { interpolation: true, useBorderWithImage: true }, chosen: false },
    edges: {
      color:          { inherit: false },
      hoverWidth:     1.4,
      selectionWidth: 2,
      chosen: false,
      // Кривые рёбра. type:"continuous" считает изгиб напрямую из позиций
      // концов — БЕЗ виртуальных узлов (в отличие от "dynamic", который и давал
      // спирали-«улитки» около seed). С выключенной физикой это дёшево и
      // выглядит мягко.
      smooth: { enabled: true, type: "continuous", roundness: 0.45 }
    },
    interaction: {
      hover:               true,
      dragNodes:           true,
      dragView:            true,
      zoomView:            true,
      tooltipDelay:        120,
      hoverConnectedEdges: true,
      hideEdgesOnDrag:     true,
      hideEdgesOnZoom:     true,
      navigationButtons:   false,
      // F-43: keyboard pan/zoom for the canvas itself. bindToWindow:false
      // scopes the arrow/+/- keys to the network canvas (active only once
      // it's focused/clicked) instead of window — otherwise it would hijack
      // arrow keys while typing in any of the page's text inputs. The
      // canvas remains an incomplete a11y story on its own (no per-node
      // focus/announcement), so "Find on map" (⌘K, see modals.js) is the
      // primary accessible/keyboard alternative to browsing nodes.
      keyboard:            { enabled: true, bindToWindow: false },
      multiselect:         false
    },
    physics
  };
}
