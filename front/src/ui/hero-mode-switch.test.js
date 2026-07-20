// ════════════════════════════════════════════════════════════════════════════
// hero-mode-switch.test.js — [SF-GAME landing entry] coverage for the
// landing hero-mode-switch's third "Game" tab (setupHeroModeSwitch,
// path-panel.js): unlike Explore/Connect it navigates straight to #/game
// instead of toggling a local .hero-mode-panel.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./router.js", () => ({ navigateToSurface: vi.fn(), SURFACE_GAME: "game" }));

import { els } from "../dom/dom.js";
import { setupHeroModeSwitch } from "./path-panel.js";
import { navigateToSurface } from "./router.js";

beforeEach(() => {
  navigateToSurface.mockClear();
  document.body.innerHTML = `
    <div class="hero-mode-switch" id="hero-mode-switch" data-mode="explore">
      <div class="hero-mode-switch-pair">
        <button id="hero-mode-tab-explore" aria-selected="true" tabindex="0"></button>
        <button id="hero-mode-tab-connect" aria-selected="false" tabindex="-1"></button>
      </div>
      <button id="hero-mode-tab-game" aria-selected="false" tabindex="0"></button>
    </div>
    <div id="hero-mode-panel-explore" class="is-active"></div>
    <div id="hero-mode-panel-connect"></div>
    <input id="hero-input" /><input id="hero-path-from-input" />
  `;
  els.heroModeSwitch       = document.getElementById("hero-mode-switch");
  els.heroModeTabExplore   = document.getElementById("hero-mode-tab-explore");
  els.heroModeTabConnect   = document.getElementById("hero-mode-tab-connect");
  els.heroModeTabGame      = document.getElementById("hero-mode-tab-game");
  els.heroModePanelExplore = document.getElementById("hero-mode-panel-explore");
  els.heroModePanelConnect = document.getElementById("hero-mode-panel-connect");
  els.heroInput            = document.getElementById("hero-input");
  els.heroPathFromInput    = document.getElementById("hero-path-from-input");
  setupHeroModeSwitch();
});

describe("hero-mode-switch Game tab", () => {
  it("navigates to the game surface instead of toggling a local panel", () => {
    els.heroModeTabGame.click();
    expect(navigateToSurface).toHaveBeenCalledWith("game");
  });

  it("leaves the Explore/Connect selection state untouched", () => {
    els.heroModeTabGame.click();
    expect(els.heroModeTabExplore.getAttribute("aria-selected")).toBe("true");
    expect(els.heroModePanelExplore.classList.contains("is-active")).toBe(true);
  });
});

describe("hero-mode-switch Explore/Connect (still 2-state, unaffected by the Game tab)", () => {
  it("Connect tab still activates its panel normally", () => {
    els.heroModeTabConnect.click();
    expect(els.heroModeSwitch.dataset.mode).toBe("connect");
    expect(els.heroModePanelConnect.classList.contains("is-active")).toBe(true);
  });
});
