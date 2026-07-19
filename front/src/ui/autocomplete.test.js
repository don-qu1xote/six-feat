// ════════════════════════════════════════════════════════════════════════════
// ui/autocomplete.test.js — [SF-WEB-59] history rows must render with the
// same .ac-avatar layout as live suggestion rows (previously history rows
// skipped the avatar entirely, reading as a visibly different, narrower
// component next to live suggestions in the same dropdown).
// ════════════════════════════════════════════════════════════════════════════
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
