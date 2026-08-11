import { State, setPathHighlight } from "../state/state.js";
import { restoreDefaultColors } from "../vis-adapter/index.js";
import { apiFetch, isTransientStatus } from "./net.js";
export { highlightPath } from "../vis-adapter/index.js";

function pathCacheKey(fromId, toId) {
  const lo = Math.min(fromId, toId);
  const hi = Math.max(fromId, toId);
  const roles = [...State.activeFilters].sort().join(",");
  return `${lo}_${hi}_${roles}`;
}

function emptyResult(error, message) {
  return { path: [], nodes: [], edges: [], error, message };
}

export async function fetchPathBetween(fromId, toId, { signal } = {}) {
  if (!State._pathCache) State._pathCache = new Map();
  const key = pathCacheKey(fromId, toId);
  const cached = State._pathCache.get(key);
  if (cached) return cached;

  const roles = [...State.activeFilters].join(",");
  const url =
    `/api/v1/graph/path?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}` +
    `&roles=${encodeURIComponent(roles)}`;

  const res = await apiFetch(url, { signal });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}

  if (!res.ok || !data || data.error) {
    const result = emptyResult(data?.error || `http_${res.status}`, data?.message);
    // Кэшируется только устойчивый ответ. «Пути нет» — это ответ, и повторять
    // его запросом незачем; 401/422/503 — состояние, которое пользователь
    // может исправить (войти, подключить токен, подождать восстановления).
    const recoverable = isTransientStatus(res.status) || res.status === 401 || res.status === 422;
    if (!recoverable) State._pathCache.set(key, result);
    return result;
  }

  const result = {
    path: data.path || [],
    nodes: data.nodes || [],
    edges: data.edges || [],
    error: null,
  };
  State._pathCache.set(key, result);
  return result;
}

// [SF-API-23] Совместные треки одного ребра — по требованию.
// Ответ графа их больше не несёт: за сессию пользователь раскрывает одно-два
// ребра из полусотни, а разбирал JSON и держал в памяти все. Роли уходят в
// запрос и в ключ кэша по той же причине, что и у путей: с другим фильтром
// это другой вопрос, а не тот же.
function edgeCacheKey(fromId, toId) {
  const lo = Math.min(fromId, toId);
  const hi = Math.max(fromId, toId);
  const roles = [...State.activeFilters].sort().join(",");
  return `${lo}_${hi}_${roles}`;
}

export async function fetchEdgeDetails(fromId, toId, { signal } = {}) {
  if (!State._edgeCache) State._edgeCache = new Map();
  const key = edgeCacheKey(fromId, toId);
  const cached = State._edgeCache.get(key);
  if (cached) return cached;

  const roles = [...State.activeFilters].join(",");
  const url =
    `/api/v1/graph/edge?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}` +
    `&roles=${encodeURIComponent(roles)}`;

  const res = await apiFetch(url, { signal });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}

  if (!res.ok || !data || data.error) {
    const result = {
      collaborations: [],
      error: data?.error || `http_${res.status}`,
    };
    // Кэшируется только устойчивый ответ: 401/422/5xx пользователь ещё может
    // исправить, а «такого ребра нет» — уже ответ.
    const recoverable = isTransientStatus(res.status) || res.status === 401 || res.status === 422;
    if (!recoverable) State._edgeCache.set(key, result);
    return result;
  }

  const result = { collaborations: data.collaborations || [], error: null };
  State._edgeCache.set(key, result);
  return result;
}

// [SF-API-21] Раскладка накопленного графа считается на сервере.
// Структура едет в запросе, потому что накопленного графа сервер целиком не
// видел: он собран здесь из ответа /api/v1/graph и нескольких deepen'ов.
//
// Кэш ключуется самой структурой — включая закреплённые позиции. Позиции в
// ключе не прихоть: пользователь может утащить полюс мышью, и та же структура
// раскладывается тогда иначе; без них повторное раскрытие вернуло бы граф в
// состояние до перетаскивания. Округление до сотой доли — чтобы дрожание
// float не превращало один и тот же граф в новый вопрос.
function layoutCacheKey(request) {
  const round = (v) => Math.round(v * 100) / 100;
  const pinned = Object.keys(request.pinned)
    .sort()
    .map((id) => `${id}:${round(request.pinned[id].x)}:${round(request.pinned[id].y)}`)
    .join(",");
  const parents = Object.keys(request.expand_parent)
    .sort()
    .map((id) => `${id}>${request.expand_parent[id]}`)
    .join(",");
  const edges = request.edges
    .map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`))
    .sort()
    .join(",");
  return [
    request.seed_id,
    [...request.nodes].sort((a, b) => a - b).join(","),
    edges,
    request.expanded.join(","),
    parents,
    pinned,
    request.node_radius,
    request.node_gap,
  ].join("|");
}

// Синхронно: ответ на этот запрос уже есть, или его нет. Раскрытие по
// кэш-попаданию не должно ждать ни сети, ни микрозадачи — иначе анимация
// вылета начнётся кадром позже, чем начиналась до переноса геометрии.
export function cachedLayout(request) {
  if (!request) return null;
  if (!State._layoutCache) State._layoutCache = new Map();
  return State._layoutCache.get(layoutCacheKey(request)) || null;
}

// Возвращает {positions: Map(id -> {x, y}), contours: [...]} или null, если
// раскладку получить не удалось. [SF-API-22] Контуры едут вместе с позициями:
// они из этих позиций и выведены, и отдельный запрос за ними означал бы
// пересчитать раскладку второй раз ради тех же чисел.
// Ошибка здесь не исключение: у вызывающего есть чем нарисовать граф и без
// неё, и падать посреди раскрытия было бы хуже, чем разложить похуже.
export async function fetchLayout(request, { signal } = {}) {
  if (!request) return null;
  if (!State._layoutCache) State._layoutCache = new Map();
  const key = layoutCacheKey(request);
  const cached = State._layoutCache.get(key);
  if (cached) return cached;

  let res;
  try {
    res = await apiFetch("/api/v1/graph/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    return null;
  }

  let data = null;
  try {
    data = await res.json();
  } catch (_) {}

  if (!res.ok || !data || data.error || !Array.isArray(data.positions)) return null;

  const positions = new Map();
  for (const p of data.positions) positions.set(p.id, { x: p.x, y: p.y });
  const answer = { positions, contours: Array.isArray(data.contours) ? data.contours : [] };
  State._layoutCache.set(key, answer);
  return answer;
}

export function clearPathHighlight() {
  if (!State.pathHighlight || !State.nodesDS) {
    setPathHighlight(null);
    return;
  }

  const { nodeIds } = State.pathHighlight;

  const unfixUpdates = nodeIds.map((id) => ({
    id,
    fixed: false,
  }));

  if (unfixUpdates.length) State.nodesDS.update(unfixUpdates);
  restoreDefaultColors();
  setPathHighlight(null);
}
