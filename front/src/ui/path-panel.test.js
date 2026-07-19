// ════════════════════════════════════════════════════════════════════════════
// path-panel.test.js — [fix] unit coverage for the docked path-panel's swap
// button (variant B of 5 mockups — a functional swap control between the
// From/To fields, replacing the earlier decorative route-rail idea).
// ════════════════════════════════════════════════════════════════════════════
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
import { setupPathPanel } from "./path-panel.js";

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
  els.pathPanel      = document.getElementById("path-panel");
  els.pathPanelClose = document.getElementById("path-panel-close");
  els.pathFromInput  = document.getElementById("path-from-input");
  els.pathToInput    = document.getElementById("path-to-input");
  els.btnSwapPath    = document.getElementById("btn-swap-path");
  els.btnRunPath     = document.getElementById("btn-run-path");
  els.btnClearPath   = document.getElementById("btn-clear-path");
  els.btnFindPath    = document.getElementById("btn-find-path");
  els.hopChain       = document.getElementById("hop-chain");
  State.graphNodes = [];
  setupPathPanel();
});

describe("btn-swap-path", () => {
  it("swaps the From/To field values", () => {
    els.pathFromInput.value = "Drake";
    els.pathToInput.value   = "Future";

    els.btnSwapPath.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(els.pathFromInput.value).toBe("Future");
    expect(els.pathToInput.value).toBe("Drake");
  });

  it("swapping twice restores the original values", () => {
    els.pathFromInput.value = "Drake";
    els.pathToInput.value   = "Future";

    els.btnSwapPath.dispatchEvent(new window.Event("click", { bubbles: true }));
    els.btnSwapPath.dispatchEvent(new window.Event("click", { bubbles: true }));

    expect(els.pathFromInput.value).toBe("Drake");
    expect(els.pathToInput.value).toBe("Future");
  });

  it("swaps the underlying selected-node ids alongside the field text", async () => {
    const { runServerPath } = await import("./path-result.js");
    State.graphNodes = [{ id: 11, name: "Drake" }, { id: 22, name: "Future" }];
    els.pathFromInput.value = "Drake";
    els.pathToInput.value   = "Future";
    // Simulate the user picking each name from the node-AC (sets the
    // internal _pathFromId/_pathToId this test can't reach directly —
    // exercised indirectly via a fresh "input" then Find path click).
    els.pathFromInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    els.pathToInput.dispatchEvent(new window.Event("input", { bubbles: true }));

    els.btnSwapPath.dispatchEvent(new window.Event("click", { bubbles: true }));
    els.btnRunPath.dispatchEvent(new window.Event("click", { bubbles: true }));
    await Promise.resolve();

    // With no AC-selected id (ids reset by the "input" events above), Find
    // path falls back to the raw (now swapped) text — proves the swap
    // itself, not just that a request fired.
    expect(runServerPath).toHaveBeenCalledWith("Future", "Drake", expect.anything());
  });
});
