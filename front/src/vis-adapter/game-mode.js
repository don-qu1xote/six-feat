// ════════════════════════════════════════════════════════════════════════════
// vis-adapter/game-mode.js — [SF-GAME-31 / ADR-0008] Ограниченный игровой
// режим движка графа. Формальный контракт вместо того, что было раньше:
// игровой модуль сам двигал DOM-узел (`container.appendChild(els.network)` в
// game-board.js) и сам дописывал на глобальный State два свойства
// (`graphGameMode`/`gameClick`), которых нет ни в одном списке полей — то
// есть граница Explorer↔Game существовала, но не грепалась и ломалась тихо.
//
// Ровно тот же приём, что уже применён к Compare (compare-mode.js): режим,
// который меняет СМЫСЛ клика по узлу, живёт отдельным модулем vis-adapter с
// парой enter/exit + isActive, а events.js в самом верху своей node-ветки
// спрашивает isGameModeActive() и отдаёт клик сюда, минуя обычный
// selectObject-конвейер, пока режим включён.
//
// Что здесь ограничивается (ADR-0008):
//   • интеракция — клик по узлу становится игровым ходом, а не expand/select;
//   • хром Explorer'а (рейл, compare, bubble-sets, sidebar) на игровой
//     поверхности не показывается;
//   • сам движок — ОДИН И ТОТ ЖЕ State.network на #network. Не копия графа:
//     та же физика, та же раскладка, тот же seed-hero, те же тултипы.
//
// Чего здесь НЕТ: построения игрового графа и раскраски ролей — это игровая
// логика, она остаётся в game/game-board.js. Здесь только вход/выход и
// роутинг клика.
// ════════════════════════════════════════════════════════════════════════════
import { State, setGameMode, setNodes, setEdges } from "../state/state.js";
import { els } from "../dom/dom.js";
import { exitCompareMode } from "./compare-mode.js";

export function isGameModeActive() {
  return State.game.mode === true;
}

// Тумблер interaction.hover на живой сети. Отдельной функцией, потому что
// зовётся с обоих концов режима и обязан молча пережить «сети ещё нет».
// Ограничения движка, которые обязаны пережить пересоздание сети внутри
// replaceGraph. Идемпотентна и молча пропускает «сети ещё нет», поэтому её
// безопасно звать на каждый ре-биндинг доски.
export function applyGameEngineOptions() {
  if (!isGameModeActive()) return;
  applyHoverOption(false);
  // [SF-GAME-56] Рёбра в игре тоньше и спокойнее, чем в Explorer'е. Там
  // толщина ребра несёт данные (число коллабораций), и жирная линия — это
  // информация. В игре рёбер ровно два вида, и оба не про вес: пройденная
  // линия и лучи одуванчика. Толстые линии здесь только шумели и утяжеляли
  // кадр, конкурируя с узлами, которые и есть содержание доски.
  try {
    State.network.setOptions({ edges: { width: 1, selectionWidth: 1, hoverWidth: 0 } });
  } catch { /* сеть не поднята */ }
}

function applyHoverOption(on) {
  try { State.network && State.network.setOptions({ interaction: { hover: on } }); }
  catch { /* сеть не поднята */ }
}

// Вход в режим. container — колонка игровой поверхности, куда переезжает
// #network; onNodeClick — игровой роутер клика (game-board.js::handleClick).
// Идемпотентен: повторный вход при уже включённом режиме только обновляет
// роутер и контейнер, а не теряет homeParent (иначе выход вернул бы #network
// не туда, откуда его забрали).
export function enterGameMode({ container, onNodeClick } = {}) {
  if (!els.network || !container) return;

  // Compare и игра оба переопределяют смысл клика — одновременно они
  // существовать не могут. Тихо, потому что переход на другую поверхность
  // сам по себе достаточная обратная связь.
  exitCompareMode({ silent: true });

  // homeParent запоминаем ТОЛЬКО на первом входе: между играми #network
  // всегда лежит обратно в #app-canvas, но повторный enter при активном
  // режиме не должен записать в homeParent игровую же колонку.
  const home = isGameModeActive() ? State.game.homeParent : els.network.parentElement;
  if (els.network.parentElement !== container) container.appendChild(els.network);

  setGameMode(true, { clickRouter: onNodeClick || null, homeParent: home });

  // [SF-GAME-55] Ограничиваем ещё и НАТИВНЫЙ ховер движка.
  //
  // interaction.hover заставляет vis вести своё состояние наведения и
  // перерисовывать канву на КАЖДОМ переходе курсора с узла на узел. Замер: 13
  // полных перерисовок за один проход мыши сквозь веер — а каждая заново
  // рисует все узлы, включая circularImage с реальными фотографиями. Это и
  // есть «граф дёргается при движении мышки»: дёргается не частота кадров
  // (там честные 60fps), а сами узлы, которых перерисовывают под курсором.
  //
  // В игре ховеру всё равно нечего делать: подсветку соседства режим уже
  // запрещает (events.js), тултип показывает то же имя, что и так написано на
  // узле, а «сюда можно кликнуть» верно для всего нарисованного — это и
  // говорит курсор (connect.css ставит pointer на канву). Выключаем.
  // Применить СРАЗУ нельзя: на первом входе сети ещё нет, а даже когда есть —
  // replaceGraph чуть позже пересоздаёт её с дефолтными опциями (hover:true).
  // Поэтому вызов живёт там же, где игра прицепляется к живой сети, —
  // game-board.js::ensureRingHook, через applyGameEngineOptions ниже.
  applyGameEngineOptions();

  // vis подхватывает новый размер бокса на следующем кадре (autoResize) —
  // подтолкнём, иначе первый кадр рисуется в старую геометрию.
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      try { State.network && State.network.redraw(); } catch { /* ещё не поднят */ }
    });
  }
}

// Выход: снять ограничение, очистить игровой граф и вернуть #network ровно
// туда, откуда он был взят. Граф чистим, чтобы Explorer-канва вернулась
// пустой, а не с чужой недоигранной цепочкой на ней.
export function exitGameMode() {
  if (!isGameModeActive() && !State.game.homeParent) return;

  const home = State.game.homeParent;
  setGameMode(false);
  applyHoverOption(true);   // [SF-GAME-55] Explorer'у ховер нужен — возвращаем

  try {
    if (State.nodesDS) State.nodesDS.clear();
    if (State.edgesDS) State.edgesDS.clear();
  } catch { /* сеть не поднята */ }
  setNodes([]);
  setEdges([]);

  if (els.network && home && els.network.parentElement !== home) {
    home.appendChild(els.network);
  }
}

// Вызывается из events.js вместо обычного клик-конвейера, пока режим включён.
// Свою активность проверяет сам (events.js уже проверил, но no-op здесь
// безопаснее, чем доверие каждому будущему вызывающему) — та же посылка, что
// у handleCompareModeNodeClick.
export function handleGameModeNodeClick(params) {
  if (!isGameModeActive()) return;
  const route = State.game.clickRouter;
  if (typeof route === "function") route(params);
}
