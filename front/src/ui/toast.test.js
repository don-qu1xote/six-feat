import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { State } from "../state/state.js";
import { els } from "../dom/dom.js";
import { showToast, showRetryToast, hideToast } from "./toast.js";

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="toast"></div>`;
  els.toast = document.getElementById("toast");
  State.toastTimer = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("showToast", () => {
  it("shows the message and auto-hides after the default delay", () => {
    showToast("Saved");

    expect(els.toast.textContent).toBe("Saved");
    expect(els.toast.classList.contains("show")).toBe(true);

    vi.advanceTimersByTime(4800);
    expect(els.toast.classList.contains("show")).toBe(false);
  });

  it("respects a custom duration instead of the default", () => {
    showToast("Quick", 1000);

    vi.advanceTimersByTime(999);
    expect(els.toast.classList.contains("show")).toBe(true);

    vi.advanceTimersByTime(1);
    expect(els.toast.classList.contains("show")).toBe(false);
  });

  it("marks info toasts with a modifier class and plain ones without it", () => {
    showToast("FYI", 1000, true);
    expect(els.toast.classList.contains("toast--info")).toBe(true);

    showToast("Oops", 1000, false);
    expect(els.toast.classList.contains("toast--info")).toBe(false);
  });

  it("drops the action class left over from a retry toast", () => {
    els.toast.classList.add("has-action");
    showToast("Plain");
    expect(els.toast.classList.contains("has-action")).toBe(false);
  });

  it("restarts the timer so a second toast is not cut short by the first", () => {
    showToast("First", 2000);
    vi.advanceTimersByTime(1500);
    showToast("Second", 2000);

    vi.advanceTimersByTime(1500);
    expect(els.toast.classList.contains("show")).toBe(true);
    expect(els.toast.textContent).toBe("Second");

    vi.advanceTimersByTime(500);
    expect(els.toast.classList.contains("show")).toBe(false);
  });
});

describe("showRetryToast", () => {
  it("renders the message next to a Retry button", () => {
    showRetryToast("Request failed", vi.fn());

    const btn = els.toast.querySelector(".toast-retry-btn");
    expect(btn).not.toBeNull();
    expect(btn.type).toBe("button");
    expect(els.toast.textContent).toContain("Request failed");
    expect(els.toast.classList.contains("has-action")).toBe(true);
    expect(els.toast.classList.contains("show")).toBe(true);
  });

  it("hides the toast and runs the callback when Retry is clicked", () => {
    const retry = vi.fn();
    showRetryToast("Request failed", retry);

    els.toast.querySelector(".toast-retry-btn").click();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(els.toast.classList.contains("show")).toBe(false);
  });

  it("is never styled as an info toast, even right after one", () => {
    showToast("FYI", 1000, true);
    showRetryToast("Request failed", vi.fn());
    expect(els.toast.classList.contains("toast--info")).toBe(false);
  });

  it("auto-hides after the longer retry-specific default", () => {
    showRetryToast("Request failed", vi.fn());

    vi.advanceTimersByTime(4800);
    expect(els.toast.classList.contains("show")).toBe(true);

    vi.advanceTimersByTime(3200);
    expect(els.toast.classList.contains("show")).toBe(false);
  });
});

describe("hideToast", () => {
  it("clears every visual modifier at once", () => {
    showRetryToast("Request failed", vi.fn());
    hideToast();

    expect(els.toast.classList.contains("show")).toBe(false);
    expect(els.toast.classList.contains("has-action")).toBe(false);
    expect(els.toast.classList.contains("toast--info")).toBe(false);
  });

  it("cancels the pending timer so it cannot fire later", () => {
    showToast("Saved", 1000);
    hideToast();
    expect(State.toastTimer).toBeNull();

    els.toast.classList.add("show");
    vi.advanceTimersByTime(5000);
    expect(els.toast.classList.contains("show")).toBe(true);
  });

  it("is safe to call when nothing is showing", () => {
    expect(() => hideToast()).not.toThrow();
    expect(State.toastTimer).toBeNull();
  });
});
