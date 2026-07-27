// ════════════════════════════════════════════════════════════════════════════
// game/connect-store.js — [SF-GAME-32] Слой данных и идентичности раунда
// Connect: сам слайс состояния, кэши фото/id, разрешение имени в реальный
// Genius id и сериализация ссылки-шаринга.
//
// Выделено из connect.js, который до этого был одним модулем на 840 строк и
// ~45 функций: модель, контроллер и вью в одном файле, со своим императивным
// рендер-конвейером. Здесь — только «что мы знаем об артистах и раунде», без
// единого обращения к DOM: view читает это, actions это меняет.
//
// [ADR-0009] Каноничный ключ артиста в игре — РЕАЛЬНЫЙ Genius id. resolveId
// ниже — единственное место, где имя превращается в id; синтетических id
// здесь не появляется (их удаление из отрисовки — SF-GAME-34, следующий шаг).
// ════════════════════════════════════════════════════════════════════════════
import { State } from "../state/state.js";
import { apiFetch } from "../api/net.js";

// [SF-GAME-30] Слайс объявлен в state.js, а не создаётся здесь при первом
// обращении, как было раньше (`if (!State.connect) State.connect = {...}`).
// Мягкая инициализация вложенных кэшей остаётся: тесты и resetRound могут
// подменить слайс целиком.
export function slice() {
  const s = State.connect;
  if (!s.photos) s.photos = {};
  if (!s.ids) s.ids = {};
  if (!s.unresolved) s.unresolved = {};
  return s;
}

export function setPhoto(name, url) {
  if (!name || !url) return;
  slice().photos[name] = url;
}

export function setId(name, id) {
  if (!name || id == null) return;
  slice().ids[name] = id;
}

export function idFor(name) {
  return slice().ids[name] ?? null;
}

// [SF-GAME-34 / ADR-0009] Имя, которое уже пробовали разрешить и не смогли.
// Отличается от «ещё не разрешали»: первое — честная ошибка, которую надо
// показать игроку, второе — просто гонка с ещё не приехавшим ответом.
export function isUnresolved(name) {
  return slice().unresolved[name] === true;
}

// Имена текущей партии, которые не удалось разрешить (для честного состояния
// во вью). Порядок стабильный — по порядку появления в объекте.
export function unresolvedNames() {
  return Object.keys(slice().unresolved);
}

// Сбрасывается вместе с раундом: новая пара эндпоинтов — новые шансы у имён.
export function clearUnresolved() {
  slice().unresolved = {};
}

export function photoFor(name) {
  return slice().photos[name] ?? null;
}

export function eqName(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

export function endpointsReady() {
  const s = slice();
  return s.startName.trim().length > 0 && s.goalName.trim().length > 0;
}

// [design: manual entry is primary] Набранное имя не имеет id, если оно не
// пришло из автокомплита — разрешаем его через тот же /api/v1/search, что и
// сам автокомплит, беря верхнего кандидата. Так хоп, введённый с клавиатуры и
// подтверждённый Enter'ом, всё равно получает реальный id к моменту, когда он
// нужен (submit требует id для каждого узла). Результат кэшируется через
// setId, поэтому поиск делается один раз на имя.
// [SF-GAME-34 / ADR-0009] Единственное место, где имя превращается в id.
// Неудача теперь ЗАПИСЫВАЕТСЯ (slice().unresolved), а не просто возвращает
// null: раньше вызывающий молча подставлял синтетический id и рисовал
// фейковый узел, теперь у провала есть видимое состояние.
export async function resolveId(name) {
  const cached = idFor(name);
  if (cached != null) return cached;
  const { top, definitive } = await searchTopCandidate(name);
  if (!top) {
    // [SF-GAME-34] Помечаем имя нерешённым ТОЛЬКО когда поиск реально
    // ответил и артиста нет. Отвалившийся запрос (сеть/5xx) — это не «такого
    // артиста не существует», а «сейчас не проверить»: пометить его честной
    // ошибкой «не найдено на Genius» значило бы соврать про причину. Та же
    // посылка, что у game-graph.js для фронтира.
    if (definitive) slice().unresolved[name] = true;
    return null;
  }
  setId(name, top.id);
  if (top.image) setPhoto(name, top.image);
  delete slice().unresolved[name];
  return top.id;
}

// Голый поиск верхнего кандидата — без кэша и без учёта раунда. Отдельно от
// resolveId, потому что не всякий резолв принадлежит партии: админская
// публикация ежедневного челленджа (game-windows.js) тоже обязана превращать
// набранное имя в РЕАЛЬНЫЙ id (ADR-0009), но её результат не должен оседать в
// кэшах текущего раунда игрока.
//
// definitive: ответ получен и он окончательный (артиста нет) — в отличие от
// «не смогли спросить». Вызывающий решает, показывать ли это как ошибку.
async function searchTopCandidate(name) {
  const q = String(name || "").trim();
  if (!q) return { top: null, definitive: true };
  try {
    const res = await apiFetch(`/api/v1/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return { top: null, definitive: false };
    const data = await res.json();
    const top = data?.candidates?.[0];
    return top && top.id != null
      ? { top, definitive: true }
      : { top: null, definitive: true };
  } catch {
    return { top: null, definitive: false };
  }
}

// [SF-GAME-34 / ADR-0009] Публичный резолвер «имя → реальный Genius id» для
// кода вне партии. null = не опознали; вызывающий ОБЯЗАН показать это честно,
// а не подставить 0/выдуманный id.
export async function resolveArtistId(name) {
  const { top } = await searchTopCandidate(name);
  return top ? top.id : null;
}

// ── [SF-GAME-05] Deep-link sharing ───────────────────────────────────────────
// Та же URLSearchParams-на-.search конвенция, что у history.js's
// serializeGraphState/parseGraphState (router.js трогает только .hash, так что
// две схемы компонуются бесплатно). В ссылке едут ТОЛЬКО два имени, никогда не
// id челленджа: открытие ссылки просто предзаполняет start/goal ровно так, как
// если бы получатель набрал их сам, а это уже гоняет настоящий create-or-get
// POST /api/v1/game/challenge. Ни нового эндпоинта, ни резолва, которого
// сессия получателя не могла бы сделать сама.
export function serializeGameShareState({ from, to } = {}) {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params;
}

export function parseGameShareState(search) {
  const params = new URLSearchParams(search || "");
  return { from: params.get("from") || null, to: params.get("to") || null };
}
