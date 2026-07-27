import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderEmptyState,
  renderLoadingState,
  renderErrorState,
  clearCanvasState,
} from "./canvas-states.js";

describe("renderEmptyState", () => {
  let container;

  beforeEach(() => {
    container = document.createElement("div");
    container.className = "ui-state-slot";
  });

  it("renders a .ui-panel card with default onboarding copy", () => {
    renderEmptyState(container);
    const card = container.querySelector(".ui-panel.ui-state-card");
    expect(card).toBeTruthy();
    expect(container.querySelector(".ui-state-title").textContent).toMatch(/artist/i);
  });

  it("marks the container as empty/show and preserves its own base class", () => {
    renderEmptyState(container);
    expect(container.classList.contains("ui-state--empty")).toBe(true);
    expect(container.classList.contains("show")).toBe(true);
    expect(container.classList.contains("ui-state-slot")).toBe(true);
  });

  it("accepts custom title/body/action label", () => {
    renderEmptyState(container, {
      title: "Custom title",
      body: "Custom body",
      actionLabel: "Go",
      onAction: vi.fn(),
    });
    expect(container.querySelector(".ui-state-title").textContent).toBe("Custom title");
    expect(container.querySelector(".ui-state-body").textContent).toBe("Custom body");
    expect(container.querySelector(".ui-state-action").textContent).toBe("Go");
  });

  it("clicking the action button calls exactly the caller-supplied handler (e.g. openSearchModal) — no handler of its own", () => {
    const onAction = vi.fn();
    renderEmptyState(container, { onAction });

    container.querySelector(".ui-state-action").click();

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("omits the action button entirely when no onAction is given", () => {
    renderEmptyState(container);
    expect(container.querySelector(".ui-state-action")).toBeNull();
  });

  it("does nothing (no throw) when container is null", () => {
    expect(() => renderEmptyState(null)).not.toThrow();
  });
});

describe("renderLoadingState", () => {
  let container;

  beforeEach(() => {
    container = document.createElement("div");
    container.className = "path-result";
  });

  it("renders the same .spinner markup the canvas-wide loading overlay uses, plus a message", () => {
    renderLoadingState(container, "Finding path…");
    expect(container.querySelector(".spinner")).toBeTruthy();
    expect(container.textContent).toContain("Finding path…");
  });

  it("falls back to a default message when none is given", () => {
    renderLoadingState(container);
    expect(container.textContent).toContain("Loading…");
  });

  it("marks the container as loading/show and preserves its own base class", () => {
    renderLoadingState(container, "x");
    expect(container.classList.contains("ui-state--loading")).toBe(true);
    expect(container.classList.contains("path-result")).toBe(true);
  });
});

describe("renderErrorState", () => {
  let container;

  beforeEach(() => {
    container = document.createElement("div");
    container.className = "path-result";
  });

  it("renders the message inside a .ui-panel card", () => {
    renderErrorState(container, "Something broke", vi.fn());
    expect(container.querySelector(".ui-panel.ui-state-card")).toBeTruthy();
    expect(container.querySelector(".ui-state-body").textContent).toBe("Something broke");
  });

  it("clicking Retry calls exactly the caller-supplied retry function — no request logic of its own", () => {
    const retry = vi.fn();
    renderErrorState(container, "Network error", retry);

    const btn = container.querySelector(".ui-state-action");
    expect(btn.textContent).toBe("Retry");
    btn.click();

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("omits the retry button when no retry function is given (a non-actionable hint)", () => {
    renderErrorState(container, "Ambiguous name — pick from suggestions", null);
    expect(container.querySelector(".ui-state-action")).toBeNull();
  });

  it("marks the container as error/show and preserves its own base class", () => {
    renderErrorState(container, "x", null);
    expect(container.classList.contains("ui-state--error")).toBe(true);
    expect(container.classList.contains("path-result")).toBe(true);
  });
});

describe("clearCanvasState", () => {
  it("empties the container and removes every state modifier class, keeping the base class", () => {
    const container = document.createElement("div");
    container.className = "ui-state-slot";
    renderErrorState(container, "x", vi.fn());

    clearCanvasState(container);

    expect(container.innerHTML).toBe("");
    expect(container.classList.contains("show")).toBe(false);
    expect(container.classList.contains("ui-state--error")).toBe(false);
    expect(container.classList.contains("ui-state-slot")).toBe(true);
  });

  it("does nothing (no throw) when container is null", () => {
    expect(() => clearCanvasState(null)).not.toThrow();
  });
});

describe("switching between states on the same container leaves no stale modifier classes", () => {
  it("empty -> loading -> error only ever has the current state's modifier class", () => {
    const container = document.createElement("div");
    container.className = "ui-state-slot";

    renderEmptyState(container);
    expect(container.classList.contains("ui-state--empty")).toBe(true);

    renderLoadingState(container, "x");
    expect(container.classList.contains("ui-state--empty")).toBe(false);
    expect(container.classList.contains("ui-state--loading")).toBe(true);

    renderErrorState(container, "x", null);
    expect(container.classList.contains("ui-state--loading")).toBe(false);
    expect(container.classList.contains("ui-state--error")).toBe(true);
  });
});
