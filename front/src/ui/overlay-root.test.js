// ════════════════════════════════════════════════════════════════════════════
// overlay-root.test.js — [SF-WEB-41] Единая система слоёв/z-index + overlay-root.
//
// Покрывает четыре свойства новой системы стекинга:
//   1. дропдаун автокомплита рендерится в #overlay-root (не обрезается своим
//      контейнером с overflow) и возвращается на место при закрытии;
//   2. z-index берётся из токенов --z-* в index.html, а не из magic-чисел;
//   3. открытие эксклюзивного слоя закрывает прочие (общий слой-менеджер);
//   4. нет двух полос стекинга на одном z без явного порядка (шкала строго
//      возрастает и различна).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  overlayRoot, anchorDropdown, openDropdown, closeDropdown, _resetOverlayRoot
} from "./overlay-root.js";

const _here = dirname(fileURLToPath(import.meta.url));
const stylesDir = resolve(_here, "../styles");

// [fix] SF-WEB-40 (this ticket's own stated dependency) already extracted
// every rule out of index.html's inline <style> into src/styles/*.css
// *before* SF-WEB-41 landed — index.html has had no :root/selector CSS to
// read since that ticket. Reading HTML here always found `:root {`, the
// `.ac-dropdown {`, etc. nowhere, and every assertion in this describe
// silently checked the empty string instead of the real rules — a
// regression the CI run after commit caught (4 failures: "--z-canvas:
// expected undefined", ".ac-dropdown ... to match ..." not matching, etc.),
// even though the actual --z-*/overlay-root implementation in
// src/styles/tokens.css + surfaces/*.css is correct. Fixed by resolving
// index.css's own @import list (the real, load-bearing bundle order — see
// that file's header comment) and reading the concatenated source, the same
// CSS esbuild would bundle, instead of the now CSS-less HTML document.
function loadBundledCssSource() {
  const entry = readFileSync(resolve(stylesDir, "index.css"), "utf8");
  const files = [...entry.matchAll(/@import\s+"\.\/([^"]+)";/g)].map(m => m[1]);
  return files.map(f => readFileSync(resolve(stylesDir, f), "utf8")).join("\n");
}
const CSS = loadBundledCssSource();

beforeEach(() => {
  document.body.innerHTML = "";
  _resetOverlayRoot();
});

describe("[SF-WEB-41] overlay-root portal — дропдаун не обрезается контейнером", () => {
  function makeAnchoredDropdown() {
    // Контейнер с overflow:hidden — ровно та ситуация, где дропдаун раньше
    // резался краем докнутой карточки.
    const container = document.createElement("div");
    container.style.overflow = "hidden";
    const input = document.createElement("input");
    const dd = document.createElement("div");
    dd.className = "ac-dropdown";
    const sibling = document.createElement("span");
    container.append(input, dd, sibling);
    document.body.append(container);
    anchorDropdown(dd, input);
    return { container, input, dd, sibling };
  }

  it("открытый дропдаун живёт в #overlay-root, а не внутри своего контейнера", () => {
    const { container, dd } = makeAnchoredDropdown();
    expect(dd.parentElement).toBe(container);

    openDropdown(dd);

    expect(dd.parentElement).toBe(overlayRoot());
    expect(overlayRoot().parentElement).toBe(document.body);
    expect(dd.classList.contains("open")).toBe(true);
    // #overlay-root — последний ребёнок body: стекается над остальным деревом
    // без запредельного z-index.
    expect(document.body.lastElementChild).toBe(overlayRoot());
  });

  it("закрытие возвращает дропдаун ровно на исходное место в DOM", () => {
    const { container, dd, sibling } = makeAnchoredDropdown();
    openDropdown(dd);
    expect(dd.parentElement).toBe(overlayRoot());

    closeDropdown(dd);

    expect(dd.parentElement).toBe(container);
    expect(dd.nextElementSibling).toBe(sibling); // порядок среди соседей сохранён
    expect(dd.classList.contains("open")).toBe(false);
  });

  it("позиционируется от якоря фиксированными координатами (anchored positioning)", () => {
    const { input, dd } = makeAnchoredDropdown();
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(
      { bottom: 120, left: 40, width: 300, top: 100, right: 340, height: 20, x: 40, y: 100 }
    );
    openDropdown(dd);
    expect(dd.style.position).toBe("fixed");
    expect(dd.style.top).toBe("128px");   // bottom(120) + gap(8)
    expect(dd.style.left).toBe("40px");
    expect(dd.style.minWidth).toBe("300px");
  });

  // [SF-WEB-59] "большие подсказки делают что правая граница улетает
  // куда-то вправо и её не видно" — a dropdown anchored to an input near
  // the RIGHT edge of the viewport (docked search / node-search overlay,
  // both top:…;right:…) growing wide (width:max-content, up to 400px) used
  // to overflow past window.innerWidth with left always pinned to the
  // anchor's own left edge, regardless of how wide the dropdown ended up.
  it("pulls the dropdown back inside the viewport when it would overflow the right edge", () => {
    const { input, dd } = makeAnchoredDropdown();
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(
      { bottom: 60, left: 900, width: 380, top: 40, right: 1280, height: 20, x: 900, y: 40 }
    );
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    // Dropdown renders wide (its own max-width, e.g. long suggestion text) —
    // 900 + 400 = 1300, well past the 1024px viewport.
    vi.spyOn(dd, "getBoundingClientRect").mockReturnValue(
      { width: 400, left: 900, right: 1300, top: 68, bottom: 200, height: 132, x: 900, y: 68 }
    );

    openDropdown(dd);

    const left = parseFloat(dd.style.left);
    expect(left).toBeLessThan(900);  // pulled back from the anchor's own left edge
    expect(left + 400).toBeLessThanOrEqual(1024);  // fits inside the viewport
  });

  it("leaves left untouched when the dropdown comfortably fits in the viewport", () => {
    const { input, dd } = makeAnchoredDropdown();
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(
      { bottom: 60, left: 40, width: 300, top: 40, right: 340, height: 20, x: 40, y: 40 }
    );
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    vi.spyOn(dd, "getBoundingClientRect").mockReturnValue(
      { width: 300, left: 40, right: 340, top: 68, bottom: 200, height: 132, x: 40, y: 68 }
    );

    openDropdown(dd);
    expect(dd.style.left).toBe("40px");
  });

  it("без зарегистрированного якоря деградирует до показа на месте (без портала)", () => {
    const dd = document.createElement("div");
    document.body.append(dd);
    openDropdown(dd); // якорь не задан
    expect(dd.classList.contains("open")).toBe(true);
    expect(dd.parentElement).toBe(document.body); // не унесён в overlay-root
  });

  // [SF-WEB-60] "не получится переиспользовать с главной страницы" —
  // .path-panel/.search-modal.docked used to get a compact .ac-dropdown
  // via plain CSS descendant selectors (companion.css), which stopped
  // matching the instant portalToOverlayRoot moves the dropdown OUT of
  // that ancestor (i.e. exactly when the style needs to apply) — the
  // dropdown silently rendered at full "home page" size in the narrow
  // docked/graph context instead. .ac-dropdown--compact is set on the
  // dropdown itself (survives the portal) — openDropdown re-derives it
  // from the ANCHOR's context (never moved) on every open.
  describe("SF-WEB-60 — compact class survives the portal", () => {
    it("adds .ac-dropdown--compact when the anchor lives inside .search-modal.docked", () => {
      const modal = document.createElement("div");
      modal.className = "search-modal docked";
      const input = document.createElement("input");
      const dd = document.createElement("div");
      dd.className = "ac-dropdown";
      modal.append(input, dd);
      document.body.append(modal);
      anchorDropdown(dd, input);

      openDropdown(dd);
      expect(dd.classList.contains("ac-dropdown--compact")).toBe(true);
    });

    it("adds .ac-dropdown--compact when the anchor lives inside .path-panel", () => {
      const panel = document.createElement("div");
      panel.className = "path-panel";
      const input = document.createElement("input");
      const dd = document.createElement("div");
      dd.className = "ac-dropdown";
      panel.append(input, dd);
      document.body.append(panel);
      anchorDropdown(dd, input);

      openDropdown(dd);
      expect(dd.classList.contains("ac-dropdown--compact")).toBe(true);
    });

    it("does NOT add .ac-dropdown--compact for the plain (non-docked) hero context", () => {
      const { input, dd } = makeAnchoredDropdown();  // plain <div> container, no docked/path-panel ancestor
      openDropdown(dd);
      expect(dd.classList.contains("ac-dropdown--compact")).toBe(false);
      void input;
    });

    it("re-derives the compact class on every open — #search-modal toggles .docked at runtime, same DOM node either way", () => {
      const modal = document.createElement("div");
      modal.className = "search-modal";  // NOT docked yet — full hero mode
      const input = document.createElement("input");
      const dd = document.createElement("div");
      dd.className = "ac-dropdown";
      modal.append(input, dd);
      document.body.append(modal);
      anchorDropdown(dd, input);

      openDropdown(dd);
      expect(dd.classList.contains("ac-dropdown--compact")).toBe(false);
      closeDropdown(dd);

      modal.classList.add("docked");  // page navigates to the graph — same modal, now docked
      openDropdown(dd);
      expect(dd.classList.contains("ac-dropdown--compact")).toBe(true);
    });
  });
});

describe("[SF-WEB-41] z-index из токенов, а не magic-чисел", () => {
  // Разбор блока :root { ... } до первого :root[...] — все --z-* объявления.
  function zTokens() {
    const root = CSS.slice(CSS.indexOf(":root {"));
    const body = root.slice(0, root.indexOf("}"));
    const out = {};
    for (const m of body.matchAll(/--z-([\w-]+):\s*(\d+);/g)) out[m[1]] = Number(m[2]);
    return out;
  }

  it("определены все семь именованных полос шкалы", () => {
    const t = zTokens();
    for (const name of ["canvas", "graph-overlay", "panel", "docked", "dropdown", "overlay", "toast"]) {
      expect(t[name], `--z-${name}`).toBeTypeOf("number");
    }
  });

  it(".ac-dropdown и #overlay-root берут z-index из --z-dropdown", () => {
    expect(CSS).toMatch(/\.ac-dropdown\s*\{[^}]*z-index:\s*var\(--z-dropdown\)/s);
    expect(CSS).toMatch(/#overlay-root\s*\{[^}]*z-index:\s*var\(--z-dropdown\)/s);
  });

  it("ключевые слои переведены на токены, magic-чисел z-index у них не осталось", () => {
    for (const sel of [".toast", ".candidate-overlay", ".help-overlay",
                       ".search-modal", ".node-search-overlay", "#network"]) {
      const at = CSS.indexOf(sel + " ") >= 0 ? CSS.indexOf(sel + " ") : CSS.indexOf(sel + "\n");
      const block = CSS.slice(CSS.indexOf(sel), CSS.indexOf("}", CSS.indexOf(sel)));
      const zLine = block.match(/z-index:\s*([^;]+);/);
      if (zLine) expect(zLine[1], `${sel} z-index`).toContain("var(--z-");
      expect(at).toBeGreaterThan(0);
    }
  });
});

describe("[SF-WEB-41] один порядок истины: нет двух полос на одном z без явного порядка", () => {
  it("шкала строго возрастает и значения различны", () => {
    const root = CSS.slice(CSS.indexOf(":root {"));
    const body = root.slice(0, root.indexOf("}"));
    const order = ["canvas", "graph-overlay", "panel", "docked", "dropdown", "overlay", "toast"];
    const vals = order.map(n => {
      const m = body.match(new RegExp(`--z-${n}:\\s*(\\d+);`));
      return Number(m[1]);
    });
    // строго возрастает → каждая полоса выше предыдущей
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
    // все различны → двух слоёв на одном z нет
    expect(new Set(vals).size).toBe(vals.length);
  });
});

describe("[SF-WEB-41] общий слой-менеджер: эксклюзивное открытие закрывает прочие", () => {
  it("openExclusiveLayer закрывает все другие открытые слои, кроме себя", async () => {
    const { registerLayer, openExclusiveLayer } = await import("./docked-panel.js");

    let openA = true, openB = true, openC = false;
    const closeA = vi.fn(() => { openA = false; });
    const closeB = vi.fn(() => { openB = false; });
    const closeC = vi.fn(() => { openC = false; });

    const a = registerLayer({ el: document.createElement("div"), trigger: null, isOpen: () => openA, close: closeA });
    registerLayer({ el: document.createElement("div"), trigger: null, isOpen: () => openB, close: closeB });
    registerLayer({ el: document.createElement("div"), trigger: null, isOpen: () => openC, close: closeC });

    openExclusiveLayer(a);

    expect(closeA).not.toHaveBeenCalled();   // сам открываемый слой не трогаем
    expect(closeB).toHaveBeenCalledTimes(1); // прочий открытый — закрыт
    expect(closeC).not.toHaveBeenCalled();   // был закрыт — нечего закрывать
  });

  it("docked-алиасы указывают на тот же общий механизм (SF-WEB-24 совместимость)", async () => {
    const mod = await import("./docked-panel.js");
    expect(mod.registerDockedPanel).toBe(mod.registerLayer);
    expect(mod.closeOtherDockedPanels).toBe(mod.closeOtherLayers);
  });
});