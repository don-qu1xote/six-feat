// ════════════════════════════════════════════════════════════════════════════
// game-layout.test.js — [SF-GAME-40] Правила игрового коридора. Раскладка —
// чистая функция от партии, поэтому проверяются именно ИНВАРИАНТЫ (см. шапку
// game-layout.js), а не конкретные пиксели: инварианты и есть то, что делает
// граф недёргающимся, а «правильные числа» — следствие.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";

import { createConnectChain, addHop, setFocus, undoHop } from "./connect-model.js";
import { computeGameLayout, layoutBounds, COL_STEP, LANE_STEP, START_X } from "./game-layout.js";
import { MIN_SEP } from "../vis-adapter/layout.js";

// Партия: Drake → Adele, плюс произвольная цепочка хопов по текущей ветке.
function chain(...hops) {
  const g = createConnectChain("Drake", "Adele");
  hops.forEach(h => addHop(g, h));
  return g;
}

describe("коридор: X = глубина", () => {
  it("ставит старт в начало координат", () => {
    const l = computeGameLayout(chain());
    expect(l.positions.get("Drake")).toEqual({ x: START_X, y: 0 });
  });

  it("каждый хоп — ровно одна колонка вправо", () => {
    const l = computeGameLayout(chain("SZA", "Rihanna"));
    expect(l.positions.get("SZA").x).toBe(START_X + COL_STEP);
    expect(l.positions.get("Rihanna").x).toBe(START_X + 2 * COL_STEP);
  });

  it("цель стоит на PAR-й колонке, на центральной полосе", () => {
    const l = computeGameLayout(chain(), { par: 4 });
    expect(l.goal).toEqual({ x: START_X + 4 * COL_STEP, y: 0 });
  });

  it("коридор не сжимается короче PAR, даже когда ходов ещё нет", () => {
    const short = computeGameLayout(chain(), { par: 5 });
    expect(short.poles.goalX).toBe(START_X + 5 * COL_STEP);
  });
});

describe("инвариант 3: цель отъезжает только при превышении PAR", () => {
  it("держит цель на месте, пока линия не подошла к ней вплотную", () => {
    const g = createConnectChain("Drake", "Adele");
    const before = computeGameLayout(g, { par: 3 }).goal.x;
    addHop(g, "SZA");
    expect(computeGameLayout(g, { par: 3 }).goal.x).toBe(before);
  });

  it("удлиняет коридор, когда линия подошла к цели — это осмысленное движение", () => {
    const g = chain("A", "B", "C");                       // 3 хопа при PAR=2
    const l = computeGameLayout(g, { par: 2 });
    expect(l.goal.x).toBe(START_X + 5 * COL_STEP);        // maxDepth+2
  });

  // [SF-GAME-48] Ради чего запас и сделан. Раньше (maxDepth+1) полюс цели
  // вставал ровно в ту колонку, куда веером ложится фронтир: на живой странице
  // после двух ходов при PAR 3 цель оказывалась ВНУТРИ облака кандидатов.
  // Пересечения не было (солвер разводит), но «два полюса» переставали
  // читаться — цель выглядела ещё одним кандидатом.
  it("[ГАРАНТИЯ] цель остаётся полюсом: веер не доходит до её колонки", () => {
    const g = chain("A", "B");
    const wide = { loading: false, neighbours: Array.from({ length: 8 }, (_, i) => ({ id: i, name: `C${i}` })) };
    const l = computeGameLayout(g, { par: 3, frontier: wide });
    let far = -Infinity;
    l.frontier.forEach(pos => { if (pos.x > far) far = pos.x; });
    expect(l.goal.x - far).toBeGreaterThanOrEqual(MIN_SEP);
  });

  it("растёт монотонно и никогда не «дышит» обратно", () => {
    const g = createConnectChain("Drake", "Adele");
    const seen = [];
    ["A", "B", "C", "D"].forEach(h => { addHop(g, h); seen.push(computeGameLayout(g, { par: 2 }).goal.x); });
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });
});

describe("инвариант 4/5: ветки — полосы, выданные при рождении", () => {
  it("держит линейную цепочку на центральной полосе", () => {
    const l = computeGameLayout(chain("SZA", "Rihanna"));
    expect(l.positions.get("SZA").y).toBe(0);
    expect(l.positions.get("Rihanna").y).toBe(0);
  });

  it("уводит вторую ветку на свою полосу, чередуясь наружу", () => {
    const g = chain("SZA");        // Drake → SZA (полоса 0)
    setFocus(g, "Drake");
    addHop(g, "Future");           // вторая ветка от Drake → новая полоса
    setFocus(g, "Drake");
    addHop(g, "Nas");              // третья ветка → полоса с другой стороны

    const l = computeGameLayout(g);
    expect(l.positions.get("SZA").y).toBe(0);
    expect(l.positions.get("Future").y).toBe(LANE_STEP);
    expect(l.positions.get("Nas").y).toBe(-LANE_STEP);
  });

  it("[ГЛАВНОЕ] появление новой ветки не сдвигает НИ ОДНОГО существующего узла", () => {
    const g = chain("SZA", "Rihanna");
    const before = computeGameLayout(g).positions;
    const snapshot = new Map([...before].map(([k, v]) => [k, { ...v }]));

    setFocus(g, "Drake");
    addHop(g, "Future");           // игрок передумал и пошёл другой веткой

    const after = computeGameLayout(g).positions;
    snapshot.forEach((pos, name) => expect(after.get(name)).toEqual(pos));
  });

  it("ветка от середины линии тоже никого не двигает", () => {
    const g = chain("SZA", "Rihanna");
    const snapshot = new Map([...computeGameLayout(g).positions].map(([k, v]) => [k, { ...v }]));
    setFocus(g, "SZA");
    addHop(g, "Future");
    const after = computeGameLayout(g).positions;
    snapshot.forEach((pos, name) => expect(after.get(name)).toEqual(pos));
  });
});

describe("инвариант 1: раскладка — чистая функция, а не накопленное состояние", () => {
  it("даёт побайтово тот же результат при повторном вызове", () => {
    const g = chain("SZA", "Rihanna");
    setFocus(g, "Drake"); addHop(g, "Future");
    const a = computeGameLayout(g, { par: 3 });
    const b = computeGameLayout(g, { par: 3 });
    expect([...b.positions]).toEqual([...a.positions]);
    expect(b.goal).toEqual(a.goal);
  });

  it("после undo оставшиеся узлы стоят там же, где стояли", () => {
    const g = chain("SZA", "Rihanna");
    const kept = { ...computeGameLayout(g).positions.get("SZA") };
    undoHop(g);
    expect(computeGameLayout(g).positions.get("SZA")).toEqual(kept);
  });

  it("смена фокуса не трогает раскладку вообще", () => {
    const g = chain("SZA");
    setFocus(g, "Drake"); addHop(g, "Future");
    const before = [...computeGameLayout(g).positions];
    setFocus(g, "SZA");
    expect([...computeGameLayout(g).positions]).toEqual(before);
  });
});

describe("инвариант 6: одуванчик в следующей колонке за фокусом", () => {
  const frontier = { loading: false, neighbours: [{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "C" }] };

  // [ИСПРАВЛЕНО] Раньше здесь проверялось, что кандидаты стоят в ОДНОЙ колонке
  // (x = колонка фокуса + 1). Именно это и оказалось провальным: 12 кандидатов
  // выстраивались вертикальной нитью на 1287px при коридоре в 374px, и
  // fit-камера схлопывала весь граф в полоску. Теперь веер, и проверяем то,
  // что реально важно глазу: он развёрнут ВПЕРЁД, компактен и не налезает.
  it("разворачивает веер вперёд, в сторону цели", () => {
    const l = computeGameLayout(chain("SZA"), { frontier });
    const focusPos = l.positions.get("SZA");
    // Все кандидаты правее фокуса — то есть ближе к цели, а не «вокруг».
    l.frontier.forEach(pos => expect(pos.x).toBeGreaterThan(focusPos.x));
  });

  // Одного «x больше, чем у фокуса» мало: при полуугле ±66° крайние кандидаты
  // формально были правее фокуса, но уезжали в 2.2 раза дальше ВБОК, чем
  // вперёд, и веер вставал поперёк коридора. Меряем именно это соотношение —
  // продвижение к цели против разлёта поперёк. Порог 1.0 («вперёд не меньше,
  // чем вбок») старая раскладка проваливает на любом кольце от трёх узлов.
  it("веер идёт ВДОЛЬ коридора, а не поперёк: вперёд ≥ вбок", () => {
    const wide = { loading: false, neighbours: Array.from({ length: 12 }, (_, i) => ({ id: i, name: `C${i}` })) };
    const l = computeGameLayout(chain(), { par: 4, frontier: wide });
    const focusPos = l.positions.get("Drake");
    l.frontier.forEach((pos, name) => {
      const forward = pos.x - focusPos.x;
      const lateral = Math.abs(pos.y - focusPos.y);
      expect(forward, `${name}: вперёд ${forward.toFixed(0)} < вбок ${lateral.toFixed(0)}`)
        .toBeGreaterThanOrEqual(lateral);
    });
  });

  it("держит веер компактным: footprint близок к квадрату, а не к нити", () => {
    const wide = { loading: false, neighbours: Array.from({ length: 12 }, (_, i) => ({ id: i, name: `C${i}` })) };
    const l = computeGameLayout(chain(), { par: 1, frontier: wide });
    const b = layoutBounds(l);
    // До правки здесь было 374×1287 (0.29). Порог 0.6 ловит возврат к колонке.
    expect(b.width / b.height).toBeGreaterThan(0.6);
  });

  it("[ГАРАНТИЯ] ни один кандидат не налезает на узлы партии и на соседей", () => {
    const g = chain("SZA");
    setFocus(g, "Drake"); addHop(g, "Future");   // соседняя ветка рядом с веером
    setFocus(g, "SZA");
    const wide = { loading: false, neighbours: Array.from({ length: 12 }, (_, i) => ({ id: i, name: `C${i}` })) };
    const l = computeGameLayout(g, { par: 3, frontier: wide });

    const all = [...l.positions.values(), ...l.frontier.values()];
    let worst = Infinity;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      worst = Math.min(worst, Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y));
    }
    expect(worst).toBeGreaterThanOrEqual(MIN_SEP - 1);
  });

  it("молчит, пока фронтир грузится / недоступен / пуст", () => {
    for (const f of [null, { loading: true, neighbours: [] }, { unavailable: true, neighbours: [] }, { neighbours: [] }]) {
      expect(computeGameLayout(chain("SZA"), { frontier: f }).frontier.size).toBe(0);
    }
  });

  it("кандидаты НЕ попадают в закоммиченные позиции", () => {
    const l = computeGameLayout(chain("SZA"), { frontier });
    expect(l.positions.has("A")).toBe(false);
    expect(l.frontier.has("A")).toBe(true);
  });
});

describe("устойчивость к испорченной партии", () => {
  it("переживает пустую/отсутствующую партию", () => {
    for (const g of [null, undefined, {}, { nodes: [] }]) {
      const l = computeGameLayout(g);
      expect(l.positions.size).toBe(0);
      expect(l.goal.x).toBeGreaterThan(START_X);
    }
  });

  it("не зацикливается на узле-сироте и на цикле в родителях", () => {
    const orphan = { start: "S", goal: "G", focus: "S", nodes: [{ name: "S", parent: null }, { name: "X", parent: "missing" }] };
    expect(() => computeGameLayout(orphan)).not.toThrow();

    const cyclic = { start: "S", goal: "G", focus: "S", nodes: [{ name: "A", parent: "B" }, { name: "B", parent: "A" }] };
    expect(() => computeGameLayout(cyclic)).not.toThrow();
  });
});

describe("layoutBounds", () => {
  it("всегда покрывает оба полюса, даже когда узел один", () => {
    const l = computeGameLayout(chain(), { par: 4 });
    const b = layoutBounds(l);
    expect(b.minX).toBe(START_X);
    expect(b.maxX).toBe(l.poles.goalX);
  });

  it("учитывает и ветки, и одуванчик", () => {
    const g = chain("SZA");
    setFocus(g, "Drake"); addHop(g, "Future");
    const l = computeGameLayout(g, { frontier: { neighbours: [{ id: 1, name: "A" }, { id: 2, name: "B" }] } });
    const b = layoutBounds(l);
    expect(b.height).toBeGreaterThan(0);
    expect(b.maxX).toBeGreaterThanOrEqual(l.poles.goalX);
  });
});
