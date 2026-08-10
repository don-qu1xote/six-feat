import { State, setPathHighlight } from "../state/state.js";
import { restoreDefaultColors } from "../vis-adapter/index.js";
import { apiFetch, isTransientStatus } from "./net.js";
export { highlightPath } from "../vis-adapter/index.js";

// [SF-API-24] Обход в ширину в системе один, и он на сервере
// (CollabService::FindPath). Здесь раньше жил второй — по накопленному в
// браузере графу; два алгоритма на двух языках расходились в ответах, и
// расхождение видел пользователь: панель сравнения рисовала одну цепочку, а
// поиск пути по тем же двум артистам — другую.

// Ответы теперь ОТЛИЧАЮТСЯ от прежних клиентских, и это не побочный эффект, а
// суть замены:
//   • Сервер ищет по всей базе, клиент искал по тому, что успел нарисовать
//     холст (сид + глубина + обрезка по лимиту + ручные раскрытия). Поэтому
//     сервер находит путь там, где клиент честно отвечал «связи нет», и
//     находит более короткий — через артистов, которых на холсте нет.
//     Отсюда же следствие для отрисовки: цепочка может содержать узлы,
//     которых нет в State.graphNodes, и брать их имена надо из ответа
//     (data.nodes), а не из графа.
//   • Роль-фильтр. Клиентский граф уже приходил отфильтрованным (смена
//     фильтра перезапрашивает граф), так что расхождения по ролям не было —
//     и чтобы его не появилось, тот же набор ролей уходит в ручку и входит в
//     ключ кэша: снятая галочка «producer» — это другой вопрос, а не тот же.
//   • Путь теперь требует сессии с рабочим genius-токеном (ручка отвечает 422
//     без него), тогда как обход по нарисованному графу не требовал ничего.
//     Поэтому ошибка возвращается вызывающему как есть — её надо показать,
//     а не подменять словами «пути нет».

// Кэш живёт столько же, сколько граф: его сбрасывают там же, где раньше
// сбрасывали клиентскую матрицу смежности (новый поиск, раскрытие узла,
// сброс графа) — раскрытие дописывает данные в базу, поэтому ответ сервера
// после него тоже может измениться.

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
