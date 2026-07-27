import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

describe("[SF-WEB-24] a single shared document listener, not one per panel", () => {
  it("registerDockedPanel binds exactly one document click listener no matter how many panels register", async () => {
    const spy = vi.spyOn(document, "addEventListener");
    const { registerDockedPanel } = await import("./docked-panel.js");

    registerDockedPanel({
      el: document.createElement("div"),
      trigger: null,
      isOpen: () => false,
      close: vi.fn(),
    });
    registerDockedPanel({
      el: document.createElement("div"),
      trigger: null,
      isOpen: () => false,
      close: vi.fn(),
    });
    registerDockedPanel({
      el: document.createElement("div"),
      trigger: null,
      isOpen: () => false,
      close: vi.fn(),
    });

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

    elA = document.createElement("div");
    elB = document.createElement("div");
    elC = document.createElement("div");
    triggerA = document.createElement("button");
    triggerB = document.createElement("button");
    triggerC = document.createElement("button");
    document.body.append(elA, elB, elC, triggerA, triggerB, triggerC);

    closeA = vi.fn(() => {
      openA = false;
    });
    closeB = vi.fn(() => {
      openB = false;
    });
    closeC = vi.fn(() => {
      openC = false;
    });

    panelA = registerDockedPanel({
      el: elA,
      trigger: triggerA,
      isOpen: () => openA,
      close: closeA,
    });
    registerDockedPanel({ el: elB, trigger: triggerB, isOpen: () => openB, close: closeB });
    registerDockedPanel({ el: elC, trigger: triggerC, isOpen: () => openC, close: closeC });
  });

  beforeEach(() => {
    openA = openB = openC = false;
    closeA.mockClear();
    closeB.mockClear();
    closeC.mockClear();
  });

  describe("closeOtherDockedPanels", () => {
    it("closes every OTHER open panel, leaving the `except` one alone", async () => {
      const { closeOtherDockedPanels } = await import("./docked-panel.js");
      openA = true;
      openB = true;
      closeOtherDockedPanels(panelA);
      expect(closeA).not.toHaveBeenCalled();
      expect(closeB).toHaveBeenCalledTimes(1);
      expect(closeC).not.toHaveBeenCalled();
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
      openA = true;
      openB = true;
      document.body.click();
      expect(closeA).toHaveBeenCalledTimes(1);
      expect(closeB).toHaveBeenCalledTimes(1);
      expect(closeC).not.toHaveBeenCalled();
    });
  });
});
