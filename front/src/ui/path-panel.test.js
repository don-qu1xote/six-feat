import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./modals.js", () => ({
  isPathPanelOpen: vi.fn(() => false),
  openPathPanel: vi.fn(),
  closePathPanel: vi.fn(),
}));
vi.mock("./toast.js", () => ({ showToast: vi.fn() }));
vi.mock("./path-result.js", () => ({ runServerPath: vi.fn() }));
vi.mock("../api/analytics-client.js", () => ({ clearPathHighlight: vi.fn() }));

import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { setupPathPanel, setupHeroPathFinder } from "./path-panel.js";

beforeEach(() => {
  document.body.innerHTML = `
    <div id="path-panel">
      <div class="path-panel-fields">
        <input id="path-from-input" />
        <div id="path-from-ac"></div>
        <input id="path-to-input" />
        <div id="path-to-ac"></div>
        <button id="btn-swap-path"></button>
      </div>
      <div class="path-actions">
        <button id="btn-run-path"></button>
        <button id="btn-clear-path"></button>
      </div>
      <div id="hop-chain"></div>
    </div>
    <button id="btn-find-path"></button>
    <button id="path-panel-close"></button>
  `;
  els.pathPanel = document.getElementById("path-panel");
  els.pathPanelClose = document.getElementById("path-panel-close");
  els.pathFromInput = document.getElementById("path-from-input");
  els.pathToInput = document.getElementById("path-to-input");
  els.btnSwapPath = document.getElementById("btn-swap-path");
  els.btnRunPath = document.getElementById("btn-run-path");
  els.btnClearPath = document.getElementById("btn-clear-path");
  els.btnFindPath = document.getElementById("btn-find-path");
  els.hopChain = document.getElementById("hop-chain");
  State.graphNodes = [];
  setupPathPanel();
});

describe("btn-swap-path", () => {
  it("swaps the From/To field values", () => {
    els.pathFromInput.value = "Drake";
    els.pathToInput.value = "Future";

    els.btnSwapPath.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(els.pathFromInput.value).toBe("Future");
    expect(els.pathToInput.value).toBe("Drake");
  });

  it("swapping twice restores the original values", () => {
    els.pathFromInput.value = "Drake";
    els.pathToInput.value = "Future";

    els.btnSwapPath.dispatchEvent(new window.Event("click", { bubbles: true }));
    els.btnSwapPath.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(els.pathFromInput.value).toBe("Drake");
    expect(els.pathToInput.value).toBe("Future");
  });

  it("swaps the underlying selected-node ids alongside the field text", async () => {
    const { runServerPath } = await import("./path-result.js");
    State.graphNodes = [
      { id: 11, name: "Drake" },
      { id: 22, name: "Future" },
    ];
    els.pathFromInput.value = "Drake";
    els.pathToInput.value = "Future";
    els.pathFromInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    els.pathToInput.dispatchEvent(new window.Event("input", { bubbles: true }));

    els.btnSwapPath.dispatchEvent(new window.Event("click", { bubbles: true }));
    els.btnRunPath.dispatchEvent(new window.Event("click", { bubbles: true }));
    await Promise.resolve();

    expect(runServerPath).toHaveBeenCalledWith("Future", "Drake", expect.anything());
  });
});

describe("setupPathPanel — panel toggle and run", () => {
  it("opens the panel when it is closed", async () => {
    const { isPathPanelOpen, openPathPanel, closePathPanel } = await import("./modals.js");
    isPathPanelOpen.mockReturnValue(false);

    els.btnFindPath.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(openPathPanel).toHaveBeenCalled();
    expect(closePathPanel).not.toHaveBeenCalled();
  });

  it("closes the panel when it is already open", async () => {
    const { isPathPanelOpen, openPathPanel, closePathPanel } = await import("./modals.js");
    isPathPanelOpen.mockReturnValue(true);

    els.btnFindPath.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(closePathPanel).toHaveBeenCalled();
    expect(openPathPanel).not.toHaveBeenCalled();
  });

  it("closes the panel from its own close button", async () => {
    const { closePathPanel } = await import("./modals.js");
    els.pathPanelClose.dispatchEvent(new window.Event("click", { bubbles: true }));
    expect(closePathPanel).toHaveBeenCalled();
  });

  it("refuses to search with only one endpoint filled", async () => {
    const { showToast } = await import("./toast.js");
    const { runServerPath } = await import("./path-result.js");
    els.pathFromInput.value = "Drake";
    els.pathToInput.value = "   ";

    els.btnRunPath.dispatchEvent(new window.Event("click", { bubbles: true }));
    await Promise.resolve();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/both artist names/i));
    expect(runServerPath).not.toHaveBeenCalled();
  });

  it("searches by typed name when no node was picked from the list", async () => {
    const { runServerPath } = await import("./path-result.js");
    els.pathFromInput.value = "  Drake  ";
    els.pathToInput.value = "Future";

    els.btnRunPath.dispatchEvent(new window.Event("click", { bubbles: true }));
    await Promise.resolve();

    expect(runServerPath).toHaveBeenCalledWith(
      "Drake",
      "Future",
      expect.objectContaining({ loadingMessage: expect.stringContaining("Drake") }),
    );
  });

  it("clears the rendered hop chain and the graph highlight", async () => {
    const { clearPathHighlight } = await import("../api/analytics-client.js");
    els.hopChain.innerHTML = "<li>Drake</li>";

    els.btnClearPath.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(clearPathHighlight).toHaveBeenCalled();
    expect(els.hopChain.innerHTML).toBe("");
  });
});

describe("setupHeroModeSwitch", () => {
  let onSurfaceChangeCb;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="hero-mode-switch">
        <button id="hero-mode-tab-explore"></button>
        <button id="hero-mode-tab-connect"></button>
        <button id="hero-mode-tab-game"></button>
      </div>
      <div id="hero-mode-panel-explore"></div>
      <div id="hero-mode-panel-connect"></div>
      <div id="hero-mode-panel-game"></div>
      <input id="hero-input" />
      <input id="hero-path-from-input" />`;

    vi.doMock("./router.js", () => ({
      onSurfaceChange: vi.fn((cb) => {
        onSurfaceChangeCb = cb;
      }),
      getCurrentSurface: vi.fn(() => "explore"),
      SURFACE_GAME: "game",
    }));

    const { els: e } = await import("../dom/dom.js");
    e.heroModeSwitch = document.getElementById("hero-mode-switch");
    e.heroModeTabExplore = document.getElementById("hero-mode-tab-explore");
    e.heroModeTabConnect = document.getElementById("hero-mode-tab-connect");
    e.heroModeTabGame = document.getElementById("hero-mode-tab-game");
    e.heroModePanelExplore = document.getElementById("hero-mode-panel-explore");
    e.heroModePanelConnect = document.getElementById("hero-mode-panel-connect");
    e.heroModePanelGame = document.getElementById("hero-mode-panel-game");
    e.heroInput = document.getElementById("hero-input");
    e.heroPathFromInput = document.getElementById("hero-path-from-input");

    const { State: S } = await import("../state/state.js");
    S.heroMode = "explore";

    const mod = await import("./path-panel.js");
    mod.setupHeroModeSwitch();
  });

  const tab = (id) => document.getElementById(id);
  const click = (id) => tab(id).dispatchEvent(new window.Event("click", { bubbles: true }));

  it("switches to connect mode and reveals its panel", async () => {
    click("hero-mode-tab-connect");
    const { State: S } = await import("../state/state.js");

    expect(S.heroMode).toBe("connect");
    expect(tab("hero-mode-switch").dataset.mode).toBe("connect");
    expect(tab("hero-mode-panel-connect").classList.contains("is-active")).toBe(true);
    expect(tab("hero-mode-panel-explore").classList.contains("is-active")).toBe(false);
  });

  it("marks exactly one tab selected and keeps the rest out of the tab order", () => {
    click("hero-mode-tab-connect");

    expect(tab("hero-mode-tab-connect").getAttribute("aria-selected")).toBe("true");
    expect(tab("hero-mode-tab-connect").tabIndex).toBe(0);
    expect(tab("hero-mode-tab-explore").getAttribute("aria-selected")).toBe("false");
    expect(tab("hero-mode-tab-explore").tabIndex).toBe(-1);
  });

  it("moves focus into the field the chosen mode starts with", () => {
    click("hero-mode-tab-connect");
    expect(document.activeElement).toBe(document.getElementById("hero-path-from-input"));

    click("hero-mode-tab-explore");
    expect(document.activeElement).toBe(document.getElementById("hero-input"));
  });

  it("ignores a click on the mode that is already active", async () => {
    const { State: S } = await import("../state/state.js");
    click("hero-mode-tab-explore");
    expect(S.heroMode).toBe("explore");
    expect(document.activeElement).not.toBe(document.getElementById("hero-path-from-input"));
  });

  // Стрелки не просто перемещают фокус по вкладкам, а сразу активируют режим,
  // а activate() уводит фокус в первое поле этого режима. Поэтому здесь важен
  // именно сменившийся режим, а не document.activeElement.
  it("walks the tabs with the arrow keys, wrapping at both ends", () => {
    const switchEl = tab("hero-mode-switch");
    const arrow = (key) =>
      switchEl.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    tab("hero-mode-tab-explore").focus();
    arrow("ArrowRight");
    expect(switchEl.dataset.mode).toBe("connect");

    tab("hero-mode-tab-connect").focus();
    arrow("ArrowLeft");
    expect(switchEl.dataset.mode).toBe("explore");

    tab("hero-mode-tab-explore").focus();
    arrow("ArrowLeft");
    expect(switchEl.dataset.mode).toBe("game");
  });

  it("jumps to the first and last tab with Home and End", () => {
    const switchEl = tab("hero-mode-switch");
    const press = (key) =>
      switchEl.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    tab("hero-mode-tab-connect").focus();
    press("End");
    expect(switchEl.dataset.mode).toBe("game");
    expect(document.activeElement).toBe(tab("hero-mode-tab-game"));

    press("Home");
    expect(switchEl.dataset.mode).toBe("explore");
  });

  it("leaves other keys to the browser", () => {
    const switchEl = tab("hero-mode-switch");
    tab("hero-mode-tab-explore").focus();

    switchEl.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));

    expect(document.activeElement).toBe(tab("hero-mode-tab-explore"));
  });

  it("shows the game tab as selected while the game surface is open", () => {
    onSurfaceChangeCb("game");

    expect(tab("hero-mode-switch").dataset.mode).toBe("game");
    expect(tab("hero-mode-tab-game").getAttribute("aria-selected")).toBe("true");
    expect(tab("hero-mode-tab-explore").getAttribute("aria-selected")).toBe("false");
  });

  it("restores the remembered hero mode when leaving the game surface", () => {
    click("hero-mode-tab-connect");
    onSurfaceChangeCb("game");
    onSurfaceChangeCb("explore");

    expect(tab("hero-mode-switch").dataset.mode).toBe("connect");
    expect(tab("hero-mode-tab-connect").getAttribute("aria-selected")).toBe("true");
    expect(tab("hero-mode-tab-game").getAttribute("aria-selected")).toBe("false");
  });

  it("does nothing on a page without the switch", async () => {
    document.body.innerHTML = "";
    const { els: e } = await import("../dom/dom.js");
    e.heroModeSwitch = null;
    const mod = await import("./path-panel.js");

    expect(() => mod.setupHeroModeSwitch()).not.toThrow();
  });
});

describe("setupHeroPathFinder", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="hero-path-from-input" />
      <div id="hero-path-from-ac"></div>
      <input id="hero-path-to-input" />
      <div id="hero-path-to-ac"></div>
      <button id="btn-hero-run-path"></button>
      <button id="btn-hero-swap-path"></button>
      <button id="btn-hero-clear-path"></button>
      <div id="hero-hop-chain"></div>`;
    els.heroPathFromInput = document.getElementById("hero-path-from-input");
    els.heroPathToInput = document.getElementById("hero-path-to-input");
    els.btnHeroRunPath = document.getElementById("btn-hero-run-path");
    els.btnHeroSwapPath = document.getElementById("btn-hero-swap-path");
    els.btnHeroClearPath = document.getElementById("btn-hero-clear-path");
    els.heroHopChain = document.getElementById("hero-hop-chain");
    State.graphNodes = [];
    setupHeroPathFinder();
  });

  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));

  it("does nothing on a page without the hero path finder", () => {
    els.btnHeroRunPath = null;
    expect(() => setupHeroPathFinder()).not.toThrow();
  });

  it("refuses to search until both endpoints are filled", async () => {
    const { showToast } = await import("./toast.js");
    const { runServerPath } = await import("./path-result.js");
    els.heroPathFromInput.value = "Drake";
    els.heroPathToInput.value = "";

    click(els.btnHeroRunPath);
    await Promise.resolve();

    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/both artist names/i));
    expect(runServerPath).not.toHaveBeenCalled();
  });

  it("renders the result into the hero's own hop chain", async () => {
    const { runServerPath } = await import("./path-result.js");
    els.heroPathFromInput.value = "Drake";
    els.heroPathToInput.value = "Future";

    click(els.btnHeroRunPath);
    await Promise.resolve();

    expect(runServerPath).toHaveBeenCalledWith(
      "Drake",
      "Future",
      expect.objectContaining({ chainEl: els.heroHopChain }),
    );
  });

  it("swaps both the text and the picked ids", () => {
    els.heroPathFromInput.value = "Drake";
    els.heroPathToInput.value = "Future";

    click(els.btnHeroSwapPath);

    expect(els.heroPathFromInput.value).toBe("Future");
    expect(els.heroPathToInput.value).toBe("Drake");
  });

  it("empties both fields and the chain, then returns focus to the first field", () => {
    els.heroPathFromInput.value = "Drake";
    els.heroPathToInput.value = "Future";
    els.heroHopChain.innerHTML = "<li>x</li>";

    click(els.btnHeroClearPath);

    expect(els.heroPathFromInput.value).toBe("");
    expect(els.heroPathToInput.value).toBe("");
    expect(els.heroHopChain.innerHTML).toBe("");
    expect(document.activeElement).toBe(els.heroPathFromInput);
  });
});
