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
