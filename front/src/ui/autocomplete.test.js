import { describe, it, expect, beforeEach } from "vitest";
import { State } from "../state/state.js";
import { attachGeniusAutocomplete } from "./autocomplete.js";
import { _resetOverlayRoot } from "./overlay-root.js";

beforeEach(() => {
  document.body.innerHTML = "";
  _resetOverlayRoot();
  State.history = [];
});

function makeInputAndDropdown() {
  const input = document.createElement("input");
  const dd = document.createElement("div");
  dd.className = "ac-dropdown";
  document.body.append(input, dd);
  return { input, dd };
}

describe("attachGeniusAutocomplete — history rows (SF-WEB-59)", () => {
  it("renders an .ac-avatar image for a history row, same as a live suggestion row", () => {
    State.history = ["Kendrick Lamar", "Rosalía"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});

    input.dispatchEvent(new Event("focus"));

    const historyItems = dd.querySelectorAll(".ac-history");
    expect(historyItems.length).toBe(2);
    for (const item of historyItems) {
      const avatar = item.querySelector(".ac-avatar");
      expect(avatar).not.toBeNull();
      expect(avatar.getAttribute("src")).toBeTruthy();
    }
  });

  it("history rows use the same .ac-item structure (avatar + .ac-info) live suggestion rows use", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});
    input.dispatchEvent(new Event("focus"));

    const item = dd.querySelector(".ac-history");
    expect(item.classList.contains("ac-item")).toBe(true);
    expect(item.children[0].tagName).toBe("IMG");
    expect(item.children[0].classList.contains("ac-avatar")).toBe(true);
    expect(item.querySelector(".ac-info .ac-name")).not.toBeNull();
  });
});

describe("[SF-GAME-51] attachGeniusAutocomplete — пустая история", () => {
  it("не открывает дропдаун, когда показывать нечего", () => {
    State.history = [];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});

    input.dispatchEvent(new Event("focus"));

    expect(dd.classList.contains("open")).toBe(false);
    expect(dd.textContent).not.toMatch(/no recent searches/i);
  });

  it("непустая история дропдаун по-прежнему открывает", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {});

    input.dispatchEvent(new Event("focus"));

    expect(dd.classList.contains("open")).toBe(true);
    expect(dd.querySelectorAll(".ac-history").length).toBe(1);
  });
});

describe("[SF-WEB-89] attachGeniusAutocomplete — showHistory:false", () => {
  it("doesn't open the history dropdown on focus when the field has its own chips row for that", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {}, undefined, { showHistory: false });

    input.dispatchEvent(new Event("focus"));

    expect(dd.classList.contains("open")).toBe(false);
    expect(dd.querySelectorAll(".ac-history").length).toBe(0);
  });

  it("doesn't open the history dropdown when the input is cleared back to empty", () => {
    State.history = ["Gorillaz"];
    const { input, dd } = makeInputAndDropdown();
    attachGeniusAutocomplete(input, dd, () => {}, undefined, { showHistory: false });

    input.value = "";
    input.dispatchEvent(new Event("input"));

    expect(dd.classList.contains("open")).toBe(false);
  });
});
