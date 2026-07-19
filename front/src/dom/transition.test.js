// ════════════════════════════════════════════════════════════════════════════
// dom/transition.test.js — SF-WEB-47 (motion): runHeroGraphTransition now
// shares state.js's prefersReducedMotion() instead of its own independent
// matchMedia copy. Only the reduced-motion shortcut is covered here — the
// View Transitions / FLIP-fallback paths need document.startViewTransition/
// Element.animate, neither implemented in jsdom, and aren't what this
// ticket's own test spec calls out (motion values from tokens /
// reduced-motion skips animation / onDone-once / positions==targets).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, afterEach } from "vitest";
import { runHeroGraphTransition } from "./transition.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runHeroGraphTransition — prefers-reduced-motion", () => {
  it("runs the mutation synchronously and skips any transition mechanism entirely", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const mutate = vi.fn();

    runHeroGraphTransition(mutate, "toGraph");

    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
