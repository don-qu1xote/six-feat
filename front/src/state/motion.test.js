// ════════════════════════════════════════════════════════════════════════════
// state/motion.test.js — SF-WEB-47 (motion): MOTION/VIS_EASING/
// prefersReducedMotion/visAnimation — the JS half of the converged motion
// system (styles/tokens.css is the CSS half). Same
// document.documentElement.style.setProperty pattern helpers.test.js
// already uses for COLOR's theme-dependent test, since MOTION is a live
// getter onto the same kind of CSS custom property.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, afterEach } from "vitest";
import { MOTION, VIS_EASING, prefersReducedMotion, visAnimation } from "./state.js";

afterEach(() => {
  for (const key of ["fast", "base", "med", "slow", "slower", "xslow", "flight", "camera", "xxslow", "loop"]) {
    document.documentElement.style.removeProperty(`--duration-${key}`);
  }
  vi.unstubAllGlobals();
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
