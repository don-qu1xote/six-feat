import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MOTION,
  VIS_EASING,
  prefersReducedMotion,
  visAnimation,
  scaledDuration,
  State,
} from "./state.js";

const BUCKETS = {
  fast: 120,
  base: 150,
  med: 200,
  slow: 280,
  slower: 320,
  xslow: 380,
  flight: 420,
  camera: 500,
  xxslow: 600,
  loop: 800,
};

afterEach(() => {
  for (const key of Object.keys(BUCKETS)) {
    document.documentElement.style.removeProperty(`--duration-${key}`);
  }
  vi.unstubAllGlobals();
  State.network = null;
});

describe("MOTION", () => {
  it("falls back to the documented default for every bucket while the token is unset", () => {
    expect({ ...MOTION }).toMatchObject(BUCKETS);
  });

  it("re-reads the custom property on every access, in ms or bare seconds", () => {
    document.documentElement.style.setProperty("--duration-base", "999ms");
    expect(MOTION.base).toBe(999);

    document.documentElement.style.setProperty("--duration-base", "111ms");
    expect(MOTION.base).toBe(111);

    document.documentElement.style.setProperty("--duration-slow", ".5s");
    expect(MOTION.slow).toBe(500);
  });
});

describe("visAnimation", () => {
  it("hands vis.js a duration and the one shared easing, or false under reduced motion", () => {
    expect(VIS_EASING).toBe("easeInOutQuad");

    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
    expect(visAnimation(MOTION.camera)).toEqual({ duration: 500, easingFunction: VIS_EASING });

    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(prefersReducedMotion()).toBe(true);
    expect(visAnimation(MOTION.camera)).toBe(false);
  });

  it("carries the same zoom scaling that scaledDuration applies", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    State.network = { getScale: () => 3 };

    expect(visAnimation(MOTION.camera)).toEqual({
      duration: scaledDuration(MOTION.camera),
      easingFunction: VIS_EASING,
    });
  });
});

describe("scaledDuration (zoom-aware)", () => {
  it("stretches when zoomed in, shrinks when zoomed out, and stays clamped either way", () => {
    State.network = { getScale: () => 3 };
    expect(scaledDuration(MOTION.camera)).toBeGreaterThan(MOTION.camera);

    State.network = { getScale: () => 0.35 };
    expect(scaledDuration(MOTION.camera)).toBeLessThan(MOTION.camera);

    State.network = { getScale: () => 100 };
    expect(scaledDuration(MOTION.camera)).toBeLessThanOrEqual(MOTION.camera * 2);

    State.network = { getScale: () => 0.0001 };
    expect(scaledDuration(MOTION.camera)).toBeGreaterThanOrEqual(MOTION.camera * 0.6);
  });

  it("returns the duration untouched at baseline, with no network, or with a broken getScale", () => {
    State.network = null;
    expect(scaledDuration(MOTION.camera)).toBe(MOTION.camera);

    State.network = { getScale: () => 1 };
    expect(scaledDuration(MOTION.camera)).toBe(MOTION.camera);

    State.network = { getScale: () => NaN };
    expect(scaledDuration(MOTION.camera)).toBe(MOTION.camera);
  });
});
