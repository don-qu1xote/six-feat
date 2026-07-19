// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/physics.js — physics timing helpers (freeze/nudge), the RAF
//                          flyout animation, and mergeNetwork (the one
//                          operation that ties layout + physics + camera
//                          together for expand/path-search).
//
// Expand/path layout placement math («одуванчики» + «круги Эйлера») lives in
// layout.js; this file only consumes its output (targets/fromPos maps).
// ════════════════════════════════════════════════════════════════════════════
import { State, PHYSICS_SETTLE_MS, MOTION, prefersReducedMotion, visAnimation, scaledDuration } from "../state/state.js";
import { els } from "../dom/dom.js";
import { resetHoverState } from "./highlight.js";
import { nodeVisual, edgeVisual, LARGE_GRAPH_NODE_THRESHOLD, _imageFieldsFor } from "./visuals.js";
import { placeExpandedNodes } from "./layout.js";
import { setEdgeCache, suppressNativeEdgeColor } from "./edge-render.js";
import { highlightPath, highlightNeighborhood } from "./highlight.js";
import { setContourData } from "./bubble-contours.js";

// ════════════════════════════════════════════════════════════════════════════
// PHYSICS HELPERS
// ════════════════════════════════════════════════════════════════════════════

// SF-WEB-07: nudgePhysics() re-enables live physics (barnesHut/repulsion,
// see networkOptions in visuals.js) for its caller's requested window before
// scheduleFreeze() switches it back off. On a graph past
// LARGE_GRAPH_NODE_THRESHOLD, every physics tick during that window is
// already the more expensive O(n²) "repulsion" solver networkOptions()
// switches to at that size — most of the nodes involved already have their
// on-screen positions restored (refreshNetwork's moveNode loop) or are
// otherwise settled before physics is turned back on, so the caller's full
// requested duration just keeps ticking that expensive solver across
// hundreds of nodes to settle the handful that actually moved. [SF-WEB-29]
// The post-flyout expand case no longer uses live physics at all (see
// mergeNetwork's onDone below) — this cap now only applies to nudgePhysics()'s
// other callers (refreshNetwork's re-search settle, events.js's post-drag
// settle).
const LARGE_GRAPH_SETTLE_MS = 500;

// SF-WEB-09: мягкое появление новых нод — короткий scale/opacity поверх уже
// готовой ноды (не opacity:0 в данных, см. предупреждение в visuals.js о
// потере circularImage при opacity:0 → 1 partial-update). Read live from
// MOTION.med at point of use (below) rather than cached in a module-level
// const — was its own literal (220ms) before [SF-WEB-47]; MOTION.med is the
// closest converged bucket (20ms/9% shorter, imperceptible for a
// sub-animation that's already racing the much longer flyout).
const ENTRANCE_START_SCALE   = 0.55;
const ENTRANCE_START_OPACITY = 0.35;

// [SF-WEB-61] "придумай что-нибудь с плавностью и новыми анимациями" —
// staggered bloom: new leaves no longer all bloom in on the exact same
// frame, they ripple in one after another like a dandelion actually
// opening. Purely a per-node START-TIME offset inside the SAME rAF loop
// runFlyoutAnimation already runs (see entranceDelays below) — no extra
// per-frame work added for the whole graph, just an offset comparison per
// already-iterated entranceTargets entry.
const ENTRANCE_STAGGER_MS     = 18; // delay between consecutive new nodes' bloom start
const ENTRANCE_STAGGER_MAX_MS = 220; // cap total spread so a big expand's wave still finishes quickly

export function scheduleFreeze(ms) {
  clearTimeout(State.physicsTimer);
  State.physicsTimer = setTimeout(() => {
    State.physicsTimer = null;
    if (State.network) State.network.setOptions({ physics: { enabled: false } });
  }, ms);
}

export function updateEdgeRenderMode() {
  if (!State.network) return;
  // Кривые рёбра (continuous): без виртуальных узлов, без спиралей.
  State.network.setOptions({ edges: { smooth: { enabled: true, type: "continuous", roundness: 0.45 } } });
}

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-54] FAST RENDER MODE — на графах больше LARGE_GRAPH_NODE_THRESHOLD
// низкий FPS при активном pan/zoom (то, что уже смягчено для рёбер через
// hideEdgesOnDrag/hideEdgesOnZoom, networkOptions.js) упирается в САМИ ноды:
// shape:"circularImage" с interpolation:true/useBorderWithImage:true
// (networkOptions) — самая дорогая часть перерисовки, а vis.js гоняет
// полный canvas-редрав КАЖДЫЙ rAF-кадр, пока идёт взаимодействие, и рёберный
// fast-path тут не помогает вообще.
//
// pokeFastRenderMode() — тот же приём, что hideEdgesOnDrag/Zoom, только
// руками и для нод: на время активного pan/zoom ноды временно превращаются
// в дешёвый "dot" (заливка без изображения/интерполяции, тот же size), а
// через FAST_MODE_EXIT_DELAY простоя без новых poke — возвращаются к
// circularImage. Вызывать на каждый dragStart/dragging/dragEnd/zoom тик —
// сам nodesDS.update() (дорогая часть) происходит РОВНО один раз на вход и
// один раз на выход, все промежуточные poke — это просто clearTimeout+
// setTimeout (дёшево).
//
// Восстановление ПОЛНЫМ _imageFieldsFor() (shape+image+brokenImage), а не
// одним shape — см. его же комментарий в visuals.js: партиальный update
// одного shape на circularImage-ноде у vis.js на практике иногда не
// переживает серию апдейтов и аватарка не возвращается.
// ════════════════════════════════════════════════════════════════════════════
const FAST_MODE_EXIT_DELAY = 220;
let _fastRenderActive = false;
let _fastRenderExitTimer = null;

export function pokeFastRenderMode() {
  if (!State.network || !State.nodesDS) return;
  if (State.graphNodes.length <= LARGE_GRAPH_NODE_THRESHOLD) return;
  if (!_fastRenderActive) {
    _fastRenderActive = true;
    State.nodesDS.update(State.graphNodes.map(n => ({ id: n.id, shape: "dot" })));
  }
  if (_fastRenderExitTimer) clearTimeout(_fastRenderExitTimer);
  _fastRenderExitTimer = setTimeout(() => {
    _fastRenderExitTimer = null;
    _fastRenderActive = false;
    if (State.nodesDS) {
      State.nodesDS.update(State.graphNodes.map(n => ({ id: n.id, ..._imageFieldsFor(n) })));
    }
  }, FAST_MODE_EXIT_DELAY);
}

// Сбрасывает fast-render-состояние без анимации/апдейта DataSet — вызывать
// при полной пересборке графа (initNetwork/refreshNetwork/destroyNetwork),
// иначе застрявший _fastRenderActive=true не даст следующему poke() снова
// переключить в "dot" НОВЫЙ (уже пересозданный, снова circularImage)
// набор нод, а зависший таймер попытается писать в уже мёртвый nodesDS.
export function resetFastRenderMode() {
  if (_fastRenderExitTimer) clearTimeout(_fastRenderExitTimer);
  _fastRenderExitTimer = null;
  _fastRenderActive = false;
}

export function nudgePhysics(ms, noFit) {
  if (!State.network) return;
  const requested = ms || PHYSICS_SETTLE_MS;
  const settleMs  = State.graphNodes.length > LARGE_GRAPH_NODE_THRESHOLD
    ? Math.min(requested, LARGE_GRAPH_SETTLE_MS)
    : requested;
  updateEdgeRenderMode();
  State.network.setOptions({
    physics: { enabled: true, stabilization: { enabled: false } }
  });
  scheduleFreeze(settleMs);
}

// Fit viewport на последний добавленный expanded-кластер.
// Анимация мягкая — не перебрасывает весь граф.
export function _fitToExpandedCluster() {
  if (!State.network || State.expandedNodes.size === 0) return;
  // Берём последний expanded и его листья
  const expanded = [...State.expandedNodes];
  const lastExpanded = expanded[expanded.length - 1];
  const conn = State.network.getConnectedNodes(lastExpanded);
  const nodeIds = [lastExpanded, ...conn].slice(0, 40);
  // Не делаем fit если уже смотрим на нужную область
  try {
    State.network.fit({
      nodes: nodeIds,
      // [SF-WEB-47] Was a bare {duration:600,...} literal that never
      // checked prefers-reduced-motion at all — visAnimation() covers both.
      animation: visAnimation(MOTION.xxslow)
    });
  } catch(e) { /* ignore */ }
}


export function mergeNetwork(nameById, savedPositions, options = {}) {
  // См. комментарий в refreshNetwork() (render.js) — тот же риск: expand
  // (самое частое мутирующее графа-действие) может случиться, пока висит
  // незавершённый hover на ноде/ребре, которые дальше по ходу mergeNetwork
  // получают fixed/mass/physics-обновления. Сбрасываем hover-состояние
  // сразу, прежде чем что-либо мутировать.
  resetHoverState();

  // Отменяем предыдущую анимацию вылета, если ещё идёт.
  if (State._expandAnimId != null) {
    cancelAnimationFrame(State._expandAnimId);
    State._expandAnimId = null;
  }
  // Останавливаем предыдущую физику/таймер заморозки.
  clearTimeout(State.physicsTimer);
  State.physicsTimer = null;
  if (State.network) State.network.setOptions({ physics: { enabled: false } });

  const dsNodeIds = new Set(State.nodesDS.getIds());
  const dsEdgeIds = new Set(State.edgesDS.getIds());

  const freshNodes = State.graphNodes.filter(n => n._isNew && !dsNodeIds.has(n.id));

  // ── Детерминированный старт ────────────────────────────────────────────────
  // ВАЖНО: вычисляем fromPos ДО nodesDS.add(), чтобы vis.js никогда не видел
  // ноды в (0,0). Каждая нода получает x/y прямо в объекте данных.
  // [SF-WEB-55] edgeClass приходит отсюда же (placeExpandedNodes) — только в
  // обычном expand-режиме, не в path-режиме (options.pathTargets/pathFromPos
  // уже готовы заранее и мимо placeExpandedNodes не идут — там свой,
  // видимый нативный рендер рёбер, без нашего canvas-слоя).
  let targets, fromPos, edgeClass, sectorMembers;
  if (options.pathTargets && options.pathFromPos) {
    targets = options.pathTargets;
    fromPos = options.pathFromPos;
  } else {
    ({ targets, fromPos, edgeClass, sectorMembers } = placeExpandedNodes(savedPositions));
  }

  // [SF-WEB-55] Только НОВЫЕ (только что добавляемые) рёбра гасим до
  // opacity:0 — уже существующие в DataSet рёбра получили это ещё при первом
  // добавлении (initNetwork/refreshNetwork/более раннем mergeNetwork),
  // трогать их снова незачем. В path-режиме (edgeClass отсутствует) рёбра
  // остаются такими, какими их построил edgeVisual() — видимыми, без
  // нашего слоя.
  const newEdgeItems = State.graphEdges
    .filter(e => !dsEdgeIds.has(e.id))
    .map(e => {
      const v = edgeVisual(e, nameById);
      return edgeClass ? suppressNativeEdgeColor(v) : v;
    });
  if (edgeClass) {
    setEdgeCache(edgeClass);
    // [SF-WEB-62] "в файнд пафе рёбра при экспандеде пропали" —
    // initPathNetwork (ui/path-result.js's linear path layout) draws its
    // OWN edges with full native visible color, no custom canvas layer
    // involved. A regular double-click expand on TOP of that network still
    // runs this normal (non-path) branch — placeExpandedNodes classifies
    // EVERY edge in the graph into edgeClass, including the path's own
    // pre-existing ones, but only brand-new edges (via newEdgeItems above)
    // ever got suppressNativeEdgeColor() applied. Left un-suppressed, a
    // pre-existing path edge now had TWO conflicting renderers drawing it
    // at once — vis.js's own native line AND our custom curved one, at
    // different offsets — reading as broken/missing rather than doubled.
    // Catch those up here so every edge our cache now covers is
    // consistently native-invisible, regardless of which code path first
    // added it to the DataSet.
    const catchUpUpdates = [];
    for (const e of State.graphEdges) {
      if (!dsEdgeIds.has(e.id)) continue;  // brand-new — newEdgeItems above already handled it
      if (!edgeClass.has(e.id)) continue;  // not covered by our cache — leave its native color alone
      catchUpUpdates.push(suppressNativeEdgeColor({ id: e.id }));
    }
    if (catchUpUpdates.length && State.edgesDS) State.edgesDS.update(catchUpUpdates);
  }
  if (sectorMembers) setContourData(sectorMembers);

  // Сначала фиксируем seed — он уже в DS, просто обновляем координату и fixed.
  // Это делается до add() чтобы vis.js не двигал его при добавлении соседей.
  const seedId = State.currentSeedId;
  if (seedId != null) {
    State.nodesDS.update({ id: seedId, x: 0, y: 0, fixed: { x: true, y: true } });
  }

  // Встраиваем стартовые позиции прямо в объекты нод — vis.js ставит их туда
  // при add(), без промежуточного кадра в (0,0). SF-WEB-09: новые ноды также
  // стартуют уменьшенными/полупрозрачными (не opacity:0 — см. предупреждение
  // выше) — runFlyoutAnimation доводит их до финального size/opacity вместе
  // с полётом позиции, entranceTargets хранит финальные значения для этого.
  const entranceTargets = new Map();
  const newNodeItems = freshNodes.map(n => {
    const v = nodeVisual(n);
    const f = fromPos.get(n.id) || { x: 0, y: 0 };
    entranceTargets.set(n.id, { size: v.size, opacity: v.opacity });
    return { ...v, x: f.x, y: f.y, size: v.size * ENTRANCE_START_SCALE, opacity: ENTRANCE_START_OPACITY };
  });

  if (newNodeItems.length) State.nodesDS.add(newNodeItems);
  if (newEdgeItems.length) State.edgesDS.add(newEdgeItems);

  const existingUpdates = State.graphNodes
    .filter(n => !n._isNew && dsNodeIds.has(n.id))
    .map(n => {
      const v = nodeVisual(n);
      return { id: n.id, size: v.size, color: v.color, borderWidth: v.borderWidth,
               shadow: v.shadow, mass: v.mass, title: v.title, fixed: v.fixed };
    });
  if (existingUpdates.length) State.nodesDS.update(existingUpdates);

  // [SF-WEB-62] "сохранять подсветку пути при экспанде" — existingUpdates
  // just reset EVERY node (including any on the currently highlighted
  // path) back to nodeVisual's plain resting look, silently dropping the
  // path highlight even though State.pathHighlight itself still holds the
  // path. Re-apply it now the new graph shape is in place — dim:false, the
  // same "highlight path + endpoints, leave everything else at its normal
  // look" treatment Compare mode uses (SF-WEB-61), since the freshly
  // expanded node's own new leaves are ordinary graph content, not
  // something to dim down.
  if (State.pathHighlight) highlightPath(State.pathHighlight, { dim: false });

  // [SF-WEB-70] Same gap as pathHighlight above, just never reported under
  // that name — existingUpdates resets EVERY existing node's color/border/
  // shadow back to nodeVisual's plain resting look (see its own comment),
  // including a persistently FOCUSED node (State.focusedNodeId, set by
  // setFocus in events.js). highlightNeighborhood is the exact same call
  // setFocus itself uses for that persistent look (visually the
  // "hover-style" accent border, just held rather than reverted on blur) —
  // this is a 1:1 replay, not a different code path. Left unre-applied,
  // any expand triggered while a node is focused silently drops its
  // highlight — a plausible root cause behind "подсветка... ломается"
  // reports tied to expand/animation timing: the node's incident edges'
  // color is driven by _hoverNodeEdgeUpdates/getSelectedNodeEdgeIds, which
  // this same call recomputes — a dropped node focus here also reads as
  // "edge highlighting broken".
  if (State.focusedNodeId != null) highlightNeighborhood(State.focusedNodeId);

  // SF-WEB-09: раньше здесь стоял отдельный синхронный net.moveNode() на
  // каждую уже существующую ноду ("телепорт" в fromPos ДО начала полёта) —
  // существующие ноды визуально не летели вместе с новыми, а прыгали. fromPos
  // для них и так равен их текущей сохранённой позиции (см. getFrom в
  // layout.js), так что первый кадр RAF-полёта ниже (pct=0 → sx,sy=fromPos)
  // сам расставляет стартовые позиции — единый RAF-вылет для ВСЕХ нод из
  // targets (новых и существующих), без отдельного домашнего "телепорта".
  const net = State.network;

  // ── Вылет: RAF-анимация 420мс, ноды летят fromPos → targets ──────────────
  // [SF-WEB-29] targets уже сами по себе не наслаиваются (см. layout.js) —
  // после вылета ноды просто фиксируются на месте, без живой физики.
  // ТЗ-209: сам полёт делегирован общему runFlyoutAnimation() (см. ниже) —
  // здесь остаётся только то, что специфично для mergeNetwork: фиксация всех
  // нод на приземлившихся позициях и подстройка камеры.

  for (const n of freshNodes) n._isNew = false;

  runFlyoutAnimation({
    ids: [...targets.keys()],
    fromPos,
    targets,
    // [SF-WEB-53] Тот же zoom-множитель, что и у vis.js camera-анимаций
    // (visAnimation) — на крупном плане то же перемещение в координатах
    // графа покрывает больше экранных пикселей за кадр, поэтому там нужен
    // более длинный полёт, чтобы не «рвать» его на глаз.
    durationMs: scaledDuration(MOTION.flight),
    entranceTargets,
    onDone: () => {
      // [SF-WEB-29] Раньше здесь снимался fixed со всех нод и на
      // EXPAND_PHYSICS_SETTLE_MS включался живой barnesHut ("усадка") — эта
      // фаза не столько чинила реальные наложения, сколько РАЗЪЕЗЖАЛА уже
      // готовую раскладку: кольца-одуванчики и линзы Эйлера, посчитанные
      // layout.js геометрически ТОЧНО (см. _ringCap/_dandelionR там —
      // минимальная попарная дистанция между листьями теперь считается по
      // хорде, а не по приближению «длина дуги», и полюса разносятся на
      // dR-зависимый minDist, учитывающий фактический радиус каждого
      // одуванчика), превращались в бесформенный кластер под действием
      // gravitationalConstant/avoidOverlap. Раз targets сами по себе уже не
      // перекрываются, живая физика после вылета — это чистый минус
      // (визуальная тряска без функциональной пользы), а не страховка:
      // убираем фазу целиком, фиксируем каждую ноду ровно там, где она уже
      // приземлилась после runFlyoutAnimation. path-узлы и раньше оставались
      // fixed на всё время — теперь ВСЕ ноды ведут себя так же, никакого
      // отдельного unfix/refix цикла не требуется.
      net.setOptions({ physics: { enabled: false } });
      updateEdgeRenderMode();
      const fixAll = State.graphNodes.map(n => ({ id: n.id, fixed: { x: true, y: true } }));
      if (State.nodesDS) State.nodesDS.update(fixAll);

      // [SF-WEB-61] "при каждом появлении новой экспандед ноды у нас
      // отезжает экран... нужно делать фокус на новый экспандед, а не
      // оттдалять камеру" — the old rule fit the WHOLE graph's targets
      // (every pole and leaf ever placed, not just this expand's), always
      // centered on the seed. As the graph grew across expands, that
      // farthest-point radius only ever grew too — every single new expand
      // zoomed the camera OUT a bit further, regardless of where the node
      // the user just double-clicked actually was, which reads as "the
      // screen keeps pulling away" exactly as reported. Fix: fit the camera
      // to THIS expand's own new content (the freshly-expanded hub + its
      // brand-new children) instead of the graph's full historical extent —
      // the camera now pans/zooms toward what the user just asked to see,
      // not away from it.
      try {
        const focusIds = State.lastExpandedId != null
          ? [State.lastExpandedId, ...freshNodes.map(n => n.id)]
          : [...targets.keys()];  // path mode / no known expand target — fall back to fitting everything

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const id of focusIds) {
          const t = targets.get(id);
          if (!t) continue;
          if (t.x < minX) minX = t.x;
          if (t.x > maxX) maxX = t.x;
          if (t.y < minY) minY = t.y;
          if (t.y > maxY) maxY = t.y;
        }
        if (!isFinite(minX)) throw new Error("no focus target");

        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const w  = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
        const pad = 140;
        const cw  = (els.network && els.network.clientWidth)  || 1100;
        const ch  = (els.network && els.network.clientHeight) || 720;
        const sc  = Math.min(cw / (w + pad * 2), ch / (h + pad * 2));
        net.moveTo({
          position: { x: cx, y: cy },
          scale:    Math.max(0.14, Math.min(sc, 1.25)),
          // [SF-WEB-47] Was its own literal (700) and never checked
          // prefers-reduced-motion — visAnimation(MOTION.xxslow) covers
          // both (snapped 100ms/14% into the same "big deliberate camera
          // move" bucket _fitToExpandedCluster above already uses).
          animation: visAnimation(MOTION.xxslow)
        });
      } catch (e) { /* ignore */ }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ТЗ-209: runFlyoutAnimation — общий RAF-хелпер "лети из fromPos в targets"
// ────────────────────────────────────────────────────────────────────────────
// Раньше этот паттерн (Float32Array-буферы координат + requestAnimationFrame
// цикл с easeOut + запись напрямую в net.body.nodes для скорости) жил только
// внутри mergeNetwork's flyStep. С появлением линейной раскладки пути
// (placePathNodes, ТЗ-202/ТЗ-205) тот же паттерн понадобился бы второй раз —
// вместо копипасты выносим его сюда один раз, и любой будущий фикс вроде
// ТЗ-G (лишний moveNode в RAF) достаточно будет применить в одном месте.
//
// SF-WEB-09: тот же RAF-хелпер теперь везёт ВСЕ ноды из targets одним
// вылетом (не только новые — существующие, чьи targets сдвинулись, летят
// вместе с ними, без отдельного синхронного "телепорта" в mergeNetwork), и
// умеет мягкое scale/opacity появление новых нод (entranceTargets) поверх
// того же RAF-цикла. prefers-reduced-motion полностью пропускает полёт —
// ноды и entranceTargets применяются мгновенно, одним кадром.
//
// @param {Object} opts
// @param {Array}            opts.ids             — id-ы нод, участвующих в полёте
// @param {Map<id,{x,y}>}    opts.fromPos          — стартовые позиции
// @param {Map<id,{x,y}>}    opts.targets          — целевые позиции
// @param {number}           opts.durationMs       — длительность анимации, мс
// @param {Map<id,{size,opacity}>} [opts.entranceTargets] — финальные
//        size/opacity новых нод, стартующих уменьшенными/полупрозрачными
//        (см. ENTRANCE_START_SCALE/ENTRANCE_START_OPACITY выше)
// @param {Function}         [opts.onDone]         — вызывается по завершении, ровно один раз
// @returns {number|null} RAF handle текущего шага (для отмены через cancelAnimationFrame),
//        или null если анимация была пропущена (reduced motion / пустой ids)
// ─────────────────────────────────────────────────────────────────────────────
// [SF-WEB-63] "золотой стандарт по анимациям... всё как у больших сервисов"
// — pure ease-OUT (1-(1-t)^3, SF-WEB-59-and-earlier) snaps to near-full
// velocity right at t=0. The SF-WEB-61/62 attempt at fixing that switched
// to ease-IN-OUT, which traded the snap for the opposite problem: a full
// 50%-of-duration ease-IN ramp reads as sluggish/"provisaem" (sagging) —
// nodes visibly lag behind before they get moving. Real large-scale
// products (Material Design's own "standard" motion curve, used for
// exactly this "object moves to a new position" case) use
// cubic-bezier(0.4, 0.0, 0.2, 1.0): a SHORT acceleration phase (roughly the
// first fifth of the duration) into a long, gentle deceleration — enough
// ease-in to not feel like a snap, nowhere near enough to feel laggy.
function _cubicBezierEase(p1x, p1y, p2x, p2y) {
  const bezier = (t, a1, a2) =>
    ((1 - 3 * a2 + 3 * a1) * t * t * t) + ((3 * a2 - 6 * a1) * t * t) + (3 * a1 * t);
  const bezierSlope = (t, a1, a2) =>
    3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1;
  return function (x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton-Raphson: solve bezier(t, p1x, p2x) = x for t, then evaluate y.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = bezier(t, p1x, p2x) - x;
      const slope = bezierSlope(t, p1x, p2x);
      if (Math.abs(slope) < 1e-6) break;
      t -= dx / slope;
    }
    return bezier(t, p1y, p2y);
  };
}
const _easeOutFlyout = _cubicBezierEase(0.4, 0.0, 0.2, 1.0);

// ─────────────────────────────────────────────────────────────────────────────
// _fastMoveNode — единственная точка хрупкости: обращение к недокументированному
// net.body.nodes ради скорости per-frame записи внутри RAF-цикла вылета.
//
// КОНТРАКТ: если net.body.nodes[id] существует, мутируем x/y напрямую (без
// redraw — вызывающий код батчит один net.redraw() на кадр) и возвращаем true.
// Если приватная структура отсутствует/изменила форму в будущей версии
// vis-network, откатываемся на публичный network.moveNode(id, x, y) — он
// дороже (layout+redraw на каждый вызов), но даёт то же визуальное поведение,
// и возвращаем false, чтобы вызывающий код не делал redraw повторно.
// ─────────────────────────────────────────────────────────────────────────────
function _fastMoveNode(net, body, id, x, y) {
  const nb = body && body[id];
  if (nb) { nb.x = x; nb.y = y; return true; }
  if (net) net.moveNode(id, x, y);
  return false;
}

// Одноразовая (за сессию модуля) проверка формы net.body.nodes: сделана лениво,
// при первом вызове runFlyoutAnimation с непустым ids (иначе нет "known id"
// чтобы проверить — откладываем до следующего вызова). Если форма ломается,
// быстрый путь отключается для ВСЕХ последующих вылетов (не только текущего) —
// раз приватная структура изменилась, она не починится сама в рамках сессии.
let _bodyShapeChecked = false;
let _bodyShapeValid   = true;

export function runFlyoutAnimation({ ids, fromPos, targets, durationMs, entranceTargets, onDone }) {
  const net  = State.network;

  // SF-WEB-09: reduced motion — размещаем все ноды сразу на targets и сразу
  // применяем финальные size/opacity новых нод, без RAF-полёта/появления.
  if (prefersReducedMotion() || !ids.length) {
    for (const id of ids) {
      const t = targets.get(id);
      if (t && net) net.moveNode(id, t.x, t.y);
    }
    if (entranceTargets && entranceTargets.size && State.nodesDS) {
      State.nodesDS.update([...entranceTargets].map(([id, v]) => ({ id, size: v.size, opacity: v.opacity })));
    }
    State._expandAnimId = null;
    if (onDone) onDone();
    return null;
  }

  let body = net && net.body && net.body.nodes;

  if (!_bodyShapeChecked && ids.length) {
    _bodyShapeChecked = true;
    const knownId = ids[0];
    const nb = body && body[knownId];
    _bodyShapeValid = !!body && !!nb && typeof nb.x === "number" && typeof nb.y === "number";
    if (!_bodyShapeValid) {
      console.warn("[vis-adapter] private net.body.nodes shape changed — falling back to public moveNode");
    }
  }
  if (!_bodyShapeValid) body = null;

  const M  = ids.length;
  const sx = new Float32Array(M), sy = new Float32Array(M);
  const tx = new Float32Array(M), ty = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const f = fromPos.get(ids[i]) || { x: 0, y: 0 };
    const t = targets.get(ids[i]) || { x: 0, y: 0 };
    sx[i] = f.x; sy[i] = f.y; tx[i] = t.x; ty[i] = t.y;
  }

  let t0 = null;
  // SF-WEB-09: появление новых нод завершается раньше самого полёта позиции
  // (ENTRANCE_MS <= durationMs обычно) — как только entrance-доля дошла до 1,
  // прекращаем слать nodesDS.update() для entranceTargets на каждый кадр.
  let entranceDone = !entranceTargets || !entranceTargets.size;

  // [SF-WEB-61] Per-node bloom start offset — entranceTargets' own insertion
  // order (== freshNodes' order from mergeNetwork) drives the ripple, capped
  // at ENTRANCE_STAGGER_MAX_MS regardless of how many new nodes there are.
  let entranceDelays = null;
  if (!entranceDone) {
    entranceDelays = new Map();
    let i = 0;
    for (const id of entranceTargets.keys()) {
      entranceDelays.set(id, Math.min(i * ENTRANCE_STAGGER_MS, ENTRANCE_STAGGER_MAX_MS));
      i++;
    }
  }

  function step(ts) {
    if (!State.network) { State._expandAnimId = null; return; }
    if (t0 === null) t0 = ts;
    const elapsed = ts - t0;
    const pct = _easeOutFlyout(Math.min(elapsed / durationMs, 1));

    let usedFastPath = false;
    for (let i = 0; i < M; i++) {
      const moved = _fastMoveNode(net, body, ids[i],
        sx[i] + (tx[i] - sx[i]) * pct, sy[i] + (ty[i] - sy[i]) * pct);
      usedFastPath = usedFastPath || moved;
    }
    if (usedFastPath) net.redraw();
    // Зафиксированные ноды (seed, path-nodes) сами сдвинуться не могут —
    // moveNode на каждый кадр для них не нужен (лишний layout/redraw,
    // источник микро-дёрга при быстрой анимации).

    if (!entranceDone) {
      const updates = [];
      let allDone = true;
      for (const [id, v] of entranceTargets) {
        const delay = entranceDelays.get(id) || 0;
        const ePct  = Math.min(Math.max(elapsed - delay, 0) / MOTION.med, 1);
        if (ePct < 1) allDone = false;
        updates.push({
          id,
          size:    v.size * (ENTRANCE_START_SCALE + (1 - ENTRANCE_START_SCALE) * ePct),
          opacity: ENTRANCE_START_OPACITY + (v.opacity - ENTRANCE_START_OPACITY) * ePct,
        });
      }
      if (updates.length && State.nodesDS) State.nodesDS.update(updates);
      if (allDone) entranceDone = true;
    }

    if (pct < 1) {
      State._expandAnimId = requestAnimationFrame(step);
      return;
    }

    State._expandAnimId = null;
    if (onDone) onDone();
  }

  State._expandAnimId = requestAnimationFrame(step);
  return State._expandAnimId;
}
