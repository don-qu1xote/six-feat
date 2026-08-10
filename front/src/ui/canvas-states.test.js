import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderEmptyState,
  renderLoadingState,
  renderErrorState,
  clearCanvasState,
} from "./canvas-states.js";

let container;

beforeEach(() => {
  container = document.createElement("div");
  container.className = "ui-state-slot";
});

describe("renderEmptyState", () => {
  it("renders an onboarding card, by default without an action button", () => {
    renderEmptyState(container);

    expect(container.querySelector(".ui-panel.ui-state-card")).toBeTruthy();
    expect(container.querySelector(".ui-state-title").textContent).toMatch(/artist/i);
    expect(container.querySelector(".ui-state-action")).toBeNull();
    expect(container.classList.contains("ui-state--empty")).toBe(true);
    expect(container.classList.contains("show")).toBe(true);
    expect(container.classList.contains("ui-state-slot")).toBe(true);
  });

  it("takes custom copy and calls exactly the caller's handler — no action of its own", () => {
    const onAction = vi.fn();
    renderEmptyState(container, {
      title: "Custom title",
      body: "Custom body",
      actionLabel: "Go",
      onAction,
    });

    expect(container.querySelector(".ui-state-title").textContent).toBe("Custom title");
    expect(container.querySelector(".ui-state-body").textContent).toBe("Custom body");

    const button = container.querySelector(".ui-state-action");
    expect(button.textContent).toBe("Go");
    button.click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe("renderLoadingState", () => {
  it("reuses the canvas spinner markup and shows the message, defaulting when none is given", () => {
    renderLoadingState(container, "Finding path…");
    expect(container.querySelector(".spinner")).toBeTruthy();
    expect(container.textContent).toContain("Finding path…");
    expect(container.classList.contains("ui-state--loading")).toBe(true);
    expect(container.classList.contains("ui-state-slot")).toBe(true);

    renderLoadingState(container);
    expect(container.textContent).toContain("Loading…");
  });
});

describe("renderErrorState", () => {
  it("shows the message in a card and calls exactly the caller's retry", () => {
    const retry = vi.fn();
    renderErrorState(container, "Network error", retry);

    expect(container.querySelector(".ui-panel.ui-state-card")).toBeTruthy();
    expect(container.querySelector(".ui-state-body").textContent).toBe("Network error");
    expect(container.classList.contains("ui-state--error")).toBe(true);

    const button = container.querySelector(".ui-state-action");
    expect(button.textContent).toBe("Retry");
    button.click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("drops the button when there is nothing to retry — a hint, not an action", () => {
    renderErrorState(container, "Ambiguous name — pick from suggestions", null);

    expect(container.querySelector(".ui-state-action")).toBeNull();
  });
});

describe("state switching on one container", () => {
  it("keeps only the current modifier class, and clears back to the bare base class", () => {
    renderEmptyState(container);
    expect(container.classList.contains("ui-state--empty")).toBe(true);

    renderLoadingState(container, "x");
    expect(container.classList.contains("ui-state--empty")).toBe(false);
    expect(container.classList.contains("ui-state--loading")).toBe(true);

    renderErrorState(container, "x", null);
    expect(container.classList.contains("ui-state--loading")).toBe(false);
    expect(container.classList.contains("ui-state--error")).toBe(true);

    clearCanvasState(container);
    expect(container.innerHTML).toBe("");
    expect(container.classList.contains("show")).toBe(false);
    expect(container.classList.contains("ui-state--error")).toBe(false);
    expect(container.classList.contains("ui-state-slot")).toBe(true);
  });

  it("treats a missing container as a no-op instead of throwing", () => {
    expect(() => renderEmptyState(null)).not.toThrow();
    expect(() => clearCanvasState(null)).not.toThrow();
  });
});
