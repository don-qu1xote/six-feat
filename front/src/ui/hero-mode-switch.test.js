// ════════════════════════════════════════════════════════════════════════════
// hero-mode-switch.test.js — [design: challenge setup on the landing page]
// coverage for the landing hero-mode-switch's three equal segments
// (setupHeroModeSwitch, path-panel.js): Explore/Connect/Game all crossfade
// the same shared panel cell now (IDEA-41's original two-panel convention,
// extended to three) — Game stopped being a "navigates away immediately"
// special case; only its own in-panel "Start challenge" button (game/
// connect.js) actually leaves for #/game.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./router.js", () => ({
  navigateToSurface: vi.fn(),
  onSurfaceChange: vi.fn(),
  getCurrentSurface: vi.fn(() => "graph"),
  SURFACE_GAME: "game",
}));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { setupHeroModeSwitch } from "./path-panel.js";
import { navigateToSurface, onSurfaceChange, getCurrentSurface } from "./router.js";

function fixtureHtml() {
  return `
    <div class="hero-mode-switch" id="hero-mode-switch" data-mode="explore">
      <button id="hero-mode-tab-explore" aria-selected="true" tabindex="0"></button>
      <button id="hero-mode-tab-connect" aria-selected="false" tabindex="-1"></button>
      <button id="hero-mode-tab-game" aria-selected="false" tabindex="0"></button>
    </div>
    <div id="hero-mode-panel-explore" class="is-active"></div>
    <div id="hero-mode-panel-connect"></div>
    <div id="hero-mode-panel-game"></div>
    <input id="hero-input" /><input id="hero-path-from-input" /><input id="hero-game-from-input" />
  `;
}

function bindEls() {
  els.heroModeSwitch       = document.getElementById("hero-mode-switch");
  els.heroModeTabExplore   = document.getElementById("hero-mode-tab-explore");
  els.heroModeTabConnect   = document.getElementById("hero-mode-tab-connect");
  els.heroModeTabGame      = document.getElementById("hero-mode-tab-game");
  els.heroModePanelExplore = document.getElementById("hero-mode-panel-explore");
  els.heroModePanelConnect = document.getElementById("hero-mode-panel-connect");
  els.heroModePanelGame    = document.getElementById("hero-mode-panel-game");
  els.heroInput            = document.getElementById("hero-input");
  els.heroPathFromInput    = document.getElementById("hero-path-from-input");
  els.heroGameFromInput    = document.getElementById("hero-game-from-input");
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentSurface.mockReturnValue("graph");
  // State.heroMode is a real module-level singleton, not test-scoped — a
  // prior test leaving it "game" would make the next test's Game-tab click
  // see State.heroMode already "game" and skip re-activating (the click
  // handlers guard on `!== mode` the same way Explore/Connect always did).
  State.heroMode = "explore";
  document.body.innerHTML = fixtureHtml();
  bindEls();
  setupHeroModeSwitch();
});

describe("Explore/Connect/Game all crossfade in place (extended IDEA-41)", () => {
  it("Connect tab activates its panel", () => {
    els.heroModeTabConnect.click();
    expect(els.heroModeSwitch.dataset.mode).toBe("connect");
    expect(els.heroModePanelConnect.classList.contains("is-active")).toBe(true);
    expect(els.heroModePanelExplore.classList.contains("is-active")).toBe(false);
  });

  it("Explore tab re-activates its own panel", () => {
    els.heroModeTabConnect.click();
    els.heroModeTabExplore.click();
    expect(els.heroModeSwitch.dataset.mode).toBe("explore");
    expect(els.heroModePanelExplore.classList.contains("is-active")).toBe(true);
  });
});

describe("Game — now a real in-place panel, not an immediate navigate", () => {
  it("clicking Game activates its own panel instead of navigating away", () => {
    els.heroModeTabGame.click();
    expect(navigateToSurface).not.toHaveBeenCalled();
    expect(els.heroModeSwitch.dataset.mode).toBe("game");
    expect(els.heroModePanelGame.classList.contains("is-active")).toBe(true);
  });

  it("deactivates Explore/Connect's own panels when Game is selected", () => {
    els.heroModeTabGame.click();
    expect(els.heroModePanelExplore.classList.contains("is-active")).toBe(false);
    expect(els.heroModePanelConnect.classList.contains("is-active")).toBe(false);
  });

  it("does NOT auto-focus the duel's first field (unlike Connect) — the field's own autocomplete would pop an empty 'recent searches' dropdown over the panel", () => {
    els.heroModeTabGame.click();
    expect(document.activeElement).not.toBe(els.heroGameFromInput);
  });

  it("registers a surface-change listener that marks Game selected once #/game is current", () => {
    expect(onSurfaceChange).toHaveBeenCalledTimes(1);
    const sync = onSurfaceChange.mock.calls[0][0];
    sync("game");
    expect(els.heroModeSwitch.dataset.mode).toBe("game");
    expect(els.heroModeTabGame.getAttribute("aria-selected")).toBe("true");
    expect(els.heroModeTabExplore.getAttribute("aria-selected")).toBe("false");
  });

  it("reverts to the last explore/connect mode when navigating away from #/game", () => {
    els.heroModeTabConnect.click(); // State.heroMode = "connect"
    const sync = onSurfaceChange.mock.calls[0][0];
    sync("game");
    sync("graph");
    expect(els.heroModeSwitch.dataset.mode).toBe("connect");
    expect(els.heroModeTabGame.getAttribute("aria-selected")).toBe("false");
    expect(els.heroModeTabConnect.getAttribute("aria-selected")).toBe("true");
  });

  it("reflects Game as already selected at setup time if the URL is already on #/game", () => {
    getCurrentSurface.mockReturnValue("game");
    document.body.innerHTML = fixtureHtml();
    bindEls();
    setupHeroModeSwitch();
    expect(els.heroModeSwitch.dataset.mode).toBe("game");
    expect(els.heroModeTabGame.getAttribute("aria-selected")).toBe("true");
  });
});

describe("keyboard navigation across three tabs", () => {
  it("ArrowRight from Explore moves to Connect", () => {
    els.heroModeTabExplore.focus();
    els.heroModeSwitch.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    // activate("connect")'s own ТЗ-documented behavior jumps focus into the
    // first path field, same as a mouse click on the Connect tab would.
    expect(document.activeElement).toBe(els.heroPathFromInput);
    expect(els.heroModeSwitch.dataset.mode).toBe("connect");
  });

  it("ArrowRight from Connect moves to Game and activates its panel (no navigate)", () => {
    els.heroModeTabConnect.focus();
    els.heroModeSwitch.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    // Unlike Connect, activate("game") deliberately doesn't steal focus into
    // the duel field (see the "does NOT auto-focus" test above) — the
    // keydown handler's own next.focus() leaves focus on the tab itself.
    expect(document.activeElement).toBe(els.heroModeTabGame);
    expect(els.heroModeSwitch.dataset.mode).toBe("game");
    expect(navigateToSurface).not.toHaveBeenCalled();
  });

  it("End jumps straight to Game", () => {
    els.heroModeTabExplore.focus();
    els.heroModeSwitch.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(els.heroModeTabGame);
  });

  it("Home jumps straight to Explore", () => {
    els.heroModeTabGame.focus();
    els.heroModeSwitch.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    // Same activate("explore") focus-jump as the ArrowRight case above.
    expect(document.activeElement).toBe(els.heroInput);
    expect(els.heroModeSwitch.dataset.mode).toBe("explore");
  });
});
