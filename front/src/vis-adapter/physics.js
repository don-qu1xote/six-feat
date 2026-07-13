// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/physics.js — physics timing helpers (freeze/nudge), the RAF
//                          flyout animation, and mergeNetwork (the one
//                          operation that ties layout + physics + camera
//                          together for expand/path-search).
//
// Expand/path layout placement math («одуванчики» + «круги Эйлера») lives in
// layout.js; this file only consumes its output (targets/fromPos maps).
// ════════════════════════════════════════════════════════════════════════════
import { State, PHYSICS_SETTLE_MS, PHYSICS_EXPAND_MS } from "../state/state.js";
import { els } from "../dom/dom.js";
import { resetHoverState } from "./highlight.js";
import { nodeVisual, edgeVisual, LARGE_GRAPH_NODE_THRESHOLD } from "./visuals.js";
import { placeExpandedNodes, LEAF_R } from "./layout.js";

// ════════════════════════════════════════════════════════════════════════════
// PHYSICS HELPERS
// ════════════════════════════════════════════════════════════════════════════

// ТЗ-IDEA-36: таргеты expand-нод уже почти не перекрываются (см. layout.js
// minDist), так что живой физике после вылета остаётся только лёгкая усадка —
// её окно короче общего PHYSICS_EXPAND_MS (который также переиспользуется для
// нежного пост-drag доседания одной ноды в events.js).
// SF-WEB-09: раньше здесь стояло 450мс — раскладка targets уже почти без
// наслоений (layout.js::minDist), и с новым единым RAF-полётом (включая
// существующие ноды, см. runFlyoutAnimation) видимой "усадки" почти не
// остаётся. Сокращаем окно вживую-физики до минимума, достаточного лишь для
// редких реальных пересечений, а не для полноценного расталкивания.
const EXPAND_PHYSICS_SETTLE_MS = Math.min(180, PHYSICS_EXPAND_MS);

// SF-WEB-07: nudgePhysics() re-enables live physics (barnesHut/repulsion,
// see networkOptions in visuals.js) for its caller's requested window before
// scheduleFreeze() switches it back off. On a graph past
// LARGE_GRAPH_NODE_THRESHOLD, every physics tick during that window is
// already the more expensive O(n²) "repulsion" solver networkOptions()
// switches to at that size — most of the nodes involved already have their
// on-screen positions restored (refreshNetwork's moveNode loop) or are
// otherwise settled before physics is turned back on, so the caller's full
// requested duration just keeps ticking that expensive solver across
// hundreds of nodes to settle the handful that actually moved. Same
// reasoning EXPAND_PHYSICS_SETTLE_MS above already applies to the
// post-flyout case — cap it here too, for every other nudgePhysics() caller
// (refreshNetwork's re-search settle, events.js's post-drag settle).
const LARGE_GRAPH_SETTLE_MS = 500;

// SF-WEB-09: мягкое появление новых нод — короткий scale/opacity поверх уже
// готовой ноды (не opacity:0 в данных, см. предупреждение в visuals.js о
// потере circularImage при opacity:0 → 1 partial-update).
const ENTRANCE_MS            = 220;
const ENTRANCE_START_SCALE   = 0.55;
const ENTRANCE_START_OPACITY = 0.35;

// SF-WEB-09: prefers-reduced-motion → мгновенное размещение вместо RAF-полёта.
function _prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-14] PIN / UNPIN — object action bar's manual position lock,
// independent of the seed/expanded-node auto-fixing nodeVisual() already
// does. Backed by State.pinnedNodes (see state.js) rather than only the
// DataSet's own `fixed` field, since nodeVisual() recomputes `fixed` from
// scratch on every merge/update — a pin recorded only in the live DataSet
// item would silently come unstuck the next time that node's item is
// rebuilt. nodeVisual() ORs State.pinnedNodes.has(id) into its own `fixed`
// computation, so this survives across re-renders.
// ════════════════════════════════════════════════════════════════════════════

export function isNodePinned(nodeId) {
  return State.pinnedNodes.has(nodeId);
}

export function pinNode(nodeId) {
  State.pinnedNodes.add(nodeId);
  // Capture the node's CURRENT (physics-settled) position — the DataSet
  // item's own x/y can be stale if physics has moved it since the last
  // update(), and fixed:true without fresh x/y would snap it back to that
  // stale spot instead of locking it where it visually is right now.
  const pos = State.network?.getPositions([nodeId])?.[nodeId];
  State.nodesDS?.update({ id: nodeId, fixed: { x: true, y: true }, ...(pos || {}) });
}

export function unpinNode(nodeId) {
  State.pinnedNodes.delete(nodeId);
  // Releasing a seed/still-expanded node shouldn't un-fix it — those have
  // their own independent reason to stay fixed (see nodeVisual) — only
  // actually release physics if nothing else is holding this node in place.
  const gn = State.graphNodes.find(n => n.id === nodeId);
  const stillFixed = !!gn && (gn.isSeed || (State.expandedNodes.has(nodeId) && !gn._isNew));
  State.nodesDS?.update({ id: nodeId, fixed: stillFixed ? { x: true, y: true } : false });
}

export function toggleNodePin(nodeId) {
  if (isNodePinned(nodeId)) unpinNode(nodeId);
  else pinNode(nodeId);
  return isNodePinned(nodeId);
}

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
      animation: { duration: 600, easingFunction: "easeInOutQuad" }
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
  const newEdgeItems  = State.graphEdges
    .filter(e => !dsEdgeIds.has(e.id))
    .map(e => edgeVisual(e, nameById));

  // ── Детерминированный старт ────────────────────────────────────────────────
  // ВАЖНО: вычисляем fromPos ДО nodesDS.add(), чтобы vis.js никогда не видел
  // ноды в (0,0). Каждая нода получает x/y прямо в объекте данных.
  let targets, fromPos;
  if (options.pathTargets && options.pathFromPos) {
    targets = options.pathTargets;
    fromPos = options.pathFromPos;
  } else {
    ({ targets, fromPos } = placeExpandedNodes(savedPositions));
  }

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

  // SF-WEB-09: раньше здесь стоял отдельный синхронный net.moveNode() на
  // каждую уже существующую ноду ("телепорт" в fromPos ДО начала полёта) —
  // существующие ноды визуально не летели вместе с новыми, а прыгали. fromPos
  // для них и так равен их текущей сохранённой позиции (см. getFrom в
  // layout.js), так что первый кадр RAF-полёта ниже (pct=0 → sx,sy=fromPos)
  // сам расставляет стартовые позиции — единый RAF-вылет для ВСЕХ нод из
  // targets (новых и существующих), без отдельного домашнего "телепорта".
  const net = State.network;

  // ── Вылет: RAF-анимация 420мс, ноды летят fromPos → targets ──────────────
  // После завершения вылета включаем физику — она разрешит все наслоения.
  // ТЗ-209: сам полёт делегирован общему runFlyoutAnimation() (см. ниже) —
  // здесь остаётся только то, что специфично для mergeNetwork: включение
  // физики, подстройка камеры и заморозка после её остановки.

  for (const n of freshNodes) n._isNew = false;

  runFlyoutAnimation({
    ids: [...targets.keys()],
    fromPos,
    targets,
    durationMs: 420,
    entranceTargets,
    onDone: () => {
      // Снимаем fixed со всех нод кроме seed — физика должна двигать их.
      // Seed остаётся fixed, expanded-ноды получают высокую массу (притягивают листья).
      const pathNodeIds = options.pathNodeIds || [];
      const pathNodeSet = new Set(pathNodeIds);

      const unfixUpdates = [];
      for (const n of State.graphNodes) {
        if (n.id === State.currentSeedId) continue;
        if (pathNodeSet.has(n.id)) continue;  // ← ВАЖНО: узлы пути остаются fixed

        const isExp = State.expandedNodes.has(n.id);
        unfixUpdates.push({
          id:    n.id,
          fixed: false,
          mass:  isExp ? 6 : 1,
        });
      }
      if (unfixUpdates.length) State.nodesDS.update(unfixUpdates);

      // Включаем barnesHut с параметрами для expand:
      //   springLength = LEAF_R  → листья оседают на нужном радиусе
      //   avoidOverlap = 1       → ноды не наслаиваются
      //   centralGravity = 0     → кластеры не съезжаются к центру
      //   gravitationalConstant большой → expanded-ноды сильно отталкиваются
      // ТЗ-IDEA-36: листья/полюса уже прилетают в детерминированные target-
      // позиции почти без наслоений (см. layout.js), так что живой физике
      // здесь остаётся только мелкая усадка, а не расталкивание целых
      // кластеров — снижаем потолок скорости и раньше признаём движение
      // затухшим, чтобы граф оседал быстро и без видимой тряски.
      net.setOptions({
        physics: {
          enabled: true,
          solver:  "barnesHut",
          barnesHut: {
            gravitationalConstant: -12000,
            centralGravity:        0.0,
            springLength:          LEAF_R,
            springConstant:        0.06,
            damping:               0.85,
            avoidOverlap:          1.0
          },
          stabilization: { enabled: false },  // стабилизируем через тики, не batch
          timestep:         0.3,
          adaptiveTimestep: true,
          maxVelocity:      25,
          minVelocity:      3
        }
      });

      // Камера: seed — постоянный смысловой центр графа. Раньше позиция
      // камеры считалась как центр bbox { minX..maxX, minY..maxY } самих
      // targets (полюсов+листьев), а bbox всегда асимметричен относительно
      // seed (кластеры растут в одну сторону от (0,0), seed в bbox не
      // участвует, только неявно как нулевая точка отсчёта) — из-за этого
      // при КАЖДОМ expand камера панорамировалась в новую точку где-то между
      // seed и новым кластером, и seed визуально "прыгал" по экрану (его
      // экранные координаты менялись, хотя graph-координата всегда (0,0)).
      // Фикс: camera position всегда (0,0) — seed остаётся неподвижным на
      // экране, меняется только scale (по симметричному радиусу до самой
      // дальней target-точки), т.е. только зум, без панорамирования.
      try {
        let maxAbsX = 0, maxAbsY = 0;
        for (const t of targets.values()) {
          maxAbsX = Math.max(maxAbsX, Math.abs(t.x));
          maxAbsY = Math.max(maxAbsY, Math.abs(t.y));
        }
        const pad = 140;
        const cw  = (els.network && els.network.clientWidth)  || 1100;
        const ch  = (els.network && els.network.clientHeight) || 720;
        const sc  = Math.min(cw / Math.max(1, 2 * maxAbsX + pad * 2),
                             ch / Math.max(1, 2 * maxAbsY + pad * 2));
        net.moveTo({
          position: { x: 0, y: 0 },
          scale:    Math.max(0.14, Math.min(sc, 1.25)),
          animation: { duration: 700, easingFunction: "easeInOutQuad" }
        });
      } catch (e) { /* ignore */ }

      // Замораживаем через укороченное EXPAND_PHYSICS_SETTLE_MS (см. выше) —
      // targets и так почти без наслоений, долгое окно только продлевало
      // видимую тряску. После заморозки восстанавливаем красивые кривые рёбра.
      State.physicsTimer = setTimeout(() => {
        State.physicsTimer = null;
        if (!State.network) return;
        State.network.setOptions({ physics: { enabled: false } });
        updateEdgeRenderMode();
        // Фиксируем все ноды на их финальных позициях.
        const fixAll = State.graphNodes.map(n => ({
          id:    n.id,
          fixed: { x: true, y: true }
        }));
        if (State.nodesDS) State.nodesDS.update(fixAll);
        // Seed уже fixed и не мог сместиться за время анимации — moveNode здесь избыточен.
      }, EXPAND_PHYSICS_SETTLE_MS);
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
function _easeOutFlyout(t) { return 1 - Math.pow(1 - t, 3); }

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
  if (_prefersReducedMotion() || !ids.length) {
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
      const ePct = Math.min(elapsed / ENTRANCE_MS, 1);
      const updates = [];
      for (const [id, v] of entranceTargets) {
        updates.push({
          id,
          size:    v.size * (ENTRANCE_START_SCALE + (1 - ENTRANCE_START_SCALE) * ePct),
          opacity: ENTRANCE_START_OPACITY + (v.opacity - ENTRANCE_START_OPACITY) * ePct,
        });
      }
      if (updates.length && State.nodesDS) State.nodesDS.update(updates);
      if (ePct >= 1) entranceDone = true;
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
