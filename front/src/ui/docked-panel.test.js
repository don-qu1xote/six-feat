// ════════════════════════════════════════════════════════════════════════════
// docked-panel.test.js — [SF-WEB-24] unit tests for the shared docked-panel
//                        shell (registerDockedPanel/closeOtherDockedPanels):
//                        a single shared document click-outside-to-close
//                        listener (not one per surface), mutual exclusivity,
//                        and clicks inside a panel/on its own trigger not
//                        closing it.
//
// registerDockedPanel binds its one document-level listener at most once
// ever, module-wide, with no reset hook — so the "exactly one listener"
// assertion below MUST be the first thing in this file to ever call it;
// every other describe block's panels are registered in a shared beforeAll
// (not per-`it`), same reasoning as canvas-controls.test.js's ⌘K
// beforeAll: repeat registration would stack up duplicate stopPropagation
// listeners and, since every registered panel's isOpen()/close() is
// re-evaluated live against the SAME test doubles, cause a single "close
// the others" call to fire multiple times over.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

describe("[SF-WEB-24] a single shared document listener, not one per panel", () => {
  it("registerDockedPanel binds exactly one document click listener no matter how many panels register", async () => {
    const spy = vi.spyOn(document, "addEventListener");
    const { registerDockedPanel } = await import("./docked-panel.js");

    registerDockedPanel({ el: document.createElement("div"), trigger: null, isOpen: () => false, close: vi.fn() });
    registerDockedPanel({ el: document.createElement("div"), trigger: null, isOpen: () => false, close: vi.fn() });
    registerDockedPanel({ el: document.createElement("div"), trigger: null, isOpen: () => false, close: vi.fn() });

    const clickListenerCalls = spy.mock.calls.filter(([type]) => type === "click");
    expect(clickListenerCalls).toHaveLength(1);
  });
});

describe("[SF-WEB-24] mutual exclusivity and click-outside-to-close", () => {
  let panelA;
  let elA, elB, elC, triggerA, triggerB, triggerC;
  let closeA, closeB, closeC;
  let openA, openB, openC;

  beforeAll(async () => {
    const { registerDockedPanel } = await import("./docked-panel.js");

    elA = document.createElement("div"); elB = document.createElement("div"); elC = document.createElement("div");
    triggerA = document.createElement("button"); triggerB = document.createElement("button"); triggerC = document.createElement("button");
    document.body.append(elA, elB, elC, triggerA, triggerB, triggerC);

    closeA = vi.fn(() => { openA = false; });
    closeB = vi.fn(() => { openB = false; });
    closeC = vi.fn(() => { openC = false; });

    panelA = registerDockedPanel({ el: elA, trigger: triggerA, isOpen: () => openA, close: closeA });
    registerDockedPanel({ el: elB, trigger: triggerB, isOpen: () => openB, close: closeB });
    registerDockedPanel({ el: elC, trigger: triggerC, isOpen: () => openC, close: closeC });
  });

  beforeEach(() => {
    openA = openB = openC = false;
    closeA.mockClear(); closeB.mockClear(); closeC.mockClear();
  });

  describe("closeOtherDockedPanels", () => {
    it("closes every OTHER open panel, leaving the `except` one alone", async () => {
      const { closeOtherDockedPanels } = await import("./docked-panel.js");
      openA = true; openB = true;
      closeOtherDockedPanels(panelA);
      expect(closeA).not.toHaveBeenCalled();
      expect(closeB).toHaveBeenCalledTimes(1);
      expect(closeC).not.toHaveBeenCalled(); // was never open
    });

    it("does nothing when every other panel is already closed", async () => {
      const { closeOtherDockedPanels } = await import("./docked-panel.js");
      openA = true;
      closeOtherDockedPanels(panelA);
      expect(closeB).not.toHaveBeenCalled();
      expect(closeC).not.toHaveBeenCalled();
    });
  });

  describe("click-outside-to-close", () => {
    it("closes the open panel on a click outside both its element and its trigger", () => {
      openA = true;
      document.body.click();
      expect(closeA).toHaveBeenCalledTimes(1);
    });

    it("does not close on a click inside the panel's own element", () => {
      openA = true;
      elA.click();
      expect(closeA).not.toHaveBeenCalled();
    });

    it("does not close on a click on the panel's own trigger button", () => {
      openA = true;
      triggerA.click();
      expect(closeA).not.toHaveBeenCalled();
    });

    it("a click on one panel's trigger does not close a DIFFERENT open panel", () => {
      openB = true;
      triggerA.click();
      expect(closeB).toHaveBeenCalledTimes(1);
    });

    it("does nothing for a panel that isn't currently open", () => {
      openA = false;
      document.body.click();
      expect(closeA).not.toHaveBeenCalled();
    });

    it("closes every open panel independently on a single outside click", () => {
      openA = true; openB = true;
      document.body.click();
      expect(closeA).toHaveBeenCalledTimes(1);
      expect(closeB).toHaveBeenCalledTimes(1);
      expect(closeC).not.toHaveBeenCalled();
    });
  });
});
