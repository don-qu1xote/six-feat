// ════════════════════════════════════════════════════════════════════════════
// state/motion.test.js — SF-WEB-47 (motion): MOTION/VIS_EASING/
// prefersReducedMotion/visAnimation — the JS half of the converged motion
// system (styles/tokens.css is the CSS half). Same
// document.documentElement.style.setProperty pattern helpers.test.js
// already uses for COLOR's theme-dependent test, since MOTION is a live
// getter onto the same kind of CSS custom property.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, afterEach } from "vitest";
import { MOTION, VIS_EASING, prefersReducedMotion, visAnimation, scaledDuration, State } from "./state.js";

afterEach(() => {
  for (const key of ["fast", "base", "med", "slow", "slower", "xslow", "flight", "camera", "xxslow", "loop"]) {
    document.documentElement.style.removeProperty(`--duration-${key}`);
  }
  vi.unstubAllGlobals();
  State.network = null;
});

describe("MOTION", () => {
  it("reads each bucket live from its --duration-* custom property", () => {
    document.documentElement.style.setProperty("--duration-base", "999ms");
    expect(MOTION.base).toBe(999);
    document.documentElement.style.setProperty("--duration-base", "111ms");
    expect(MOTION.base).toBe(111); // re-reads on every access, not cached at import time
  });

  it("tolerates a bare-seconds value (Ns, not just Nms)", () => {
    document.documentElement.style.setProperty("--duration-slow", ".5s");
    expect(MOTION.slow).toBe(500);
  });

  it("falls back to the documented default when the token is unset", () => {
    expect(MOTION.fast).toBe(120);
    expect(MOTION.base).toBe(150);
    expect(MOTION.med).toBe(200);
    expect(MOTION.slow).toBe(280);
    expect(MOTION.slower).toBe(320);
    expect(MOTION.xslow).toBe(380);
    expect(MOTION.flight).toBe(420);
    expect(MOTION.camera).toBe(500);
    expect(MOTION.xxslow).toBe(600);
    expect(MOTION.loop).toBe(800);
  });
});

describe("VIS_EASING", () => {
  it("is the single vis.js easingFunction keyword every network.fit/focus/moveTo call now shares", () => {
    expect(VIS_EASING).toBe("easeInOutQuad");
  });
});

describe("prefersReducedMotion", () => {
  it("reflects window.matchMedia('(prefers-reduced-motion: reduce)').matches", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(prefersReducedMotion()).toBe(true);

    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("visAnimation", () => {
  it("returns {duration, easingFunction} from the given MOTION value normally", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    expect(visAnimation(MOTION.camera)).toEqual({ duration: 500, easingFunction: "easeInOutQuad" });
  });

  it("returns false (vis.js's own 'skip the animation' value) under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(visAnimation(MOTION.camera)).toBe(false);
  });
});

// [SF-WEB-53] Duration scales with the current network zoom (getScale()) —
// more "cropped" (zoomed-in) views get longer/smoother durations, more
// zoomed-out views stay short/snappy, since a given graph-space movement
// covers proportionally more/fewer screen pixels per frame.
describe("scaledDuration (zoom-aware)", () => {
  it("leaves duration unchanged with no network mounted (baseline scale)", () => {
    State.network = null;
    expect(scaledDuration(MOTION.camera)).toBe(MOTION.camera);
  });

  it("leaves duration unchanged at the baseline scale (1x)", () => {
    State.network = { getScale: () => 1 };
    expect(scaledDuration(MOTION.camera)).toBe(MOTION.camera);
  });

  it("lengthens the duration when zoomed in (scale > 1)", () => {
    State.network = { getScale: () => 3 };
    expect(scaledDuration(MOTION.camera)).toBeGreaterThan(MOTION.camera);
  });

  it("shortens the duration when zoomed out (scale < 1)", () => {
    State.network = { getScale: () => 0.35 };
    expect(scaledDuration(MOTION.camera)).toBeLessThan(MOTION.camera);
  });

  it("clamps the multiplier so extreme scales don't blow past sane bounds", () => {
    State.network = { getScale: () => 100 };
    expect(scaledDuration(MOTION.camera)).toBeLessThanOrEqual(MOTION.camera * 2);
    State.network = { getScale: () => 0.0001 };
    expect(scaledDuration(MOTION.camera)).toBeGreaterThanOrEqual(MOTION.camera * 0.6);
  });

  it("tolerates a broken/non-finite getScale by falling back to baseline", () => {
    State.network = { getScale: () => NaN };
    expect(scaledDuration(MOTION.camera)).toBe(MOTION.camera);
  });

  it("visAnimation()'s duration reflects the same zoom scaling as scaledDuration", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    State.network = { getScale: () => 3 };
    expect(visAnimation(MOTION.camera)).toEqual({
      duration: scaledDuration(MOTION.camera),
      easingFunction: "easeInOutQuad",
    });
  });
});
