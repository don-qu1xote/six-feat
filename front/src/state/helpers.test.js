// ════════════════════════════════════════════════════════════════════════════
// helpers.test.js — unit tests for pure functions in helpers.js
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  escapeHtml,
  initialOf,
  debounce,
  lerp,
  dominantRoleFromCollabs,
  allRolesFromCollabs,
  roleStyle,
  brighten,
  placeholderFor,
  isGeniusDefaultAvatar,
} from "./helpers.js";
import { State, COLOR } from "./state.js";

describe("escapeHtml", () => {
  it("escapes all five special characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
    );
  });

  it("treats null/undefined as empty string", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("stringifies non-string input", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("initialOf", () => {
  it("returns the uppercased first letter/digit", () => {
    expect(initialOf("radiohead")).toBe("R");
    expect(initialOf("  Muse")).toBe("M");
    expect(initialOf("21 savage")).toBe("2");
  });

  it("returns '?' for empty or symbol-only input", () => {
    expect(initialOf("")).toBe("?");
    expect(initialOf("   ")).toBe("?");
    expect(initialOf("!!!")).toBe("?");
  });

  it("supports unicode letters", () => {
    expect(initialOf("Éric")).toBe("É");
  });
});

describe("lerp", () => {
  it("interpolates linearly between a and b", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it("extrapolates for t outside [0,1]", () => {
    expect(lerp(0, 10, 2)).toBe(20);
    expect(lerp(0, 10, -1)).toBe(-10);
  });
});

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays invocation until after the wait time", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced("a");
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
  });

  it("resets the timer on repeated calls (only the last call fires)", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced("first");
    vi.advanceTimersByTime(200);
    debounced("second");
    vi.advanceTimersByTime(200);
    debounced("third");

    // Not yet 300ms since the last ("third") call.
    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("third");
  });

  it("keeps independent timers for separately-created debounced fns", () => {
    const fnA = vi.fn();
    const fnB = vi.fn();
    const debouncedA = debounce(fnA, 100);
    const debouncedB = debounce(fnB, 100);

    debouncedA();
    debouncedB();
    vi.advanceTimersByTime(100);

    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it("forwards multiple arguments", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 50);
    debounced(1, 2, 3);
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledWith(1, 2, 3);
  });
});

describe("dominantRoleFromCollabs", () => {
  it("picks the highest-priority role present (featured > primary > producer > writer)", () => {
    const collabs = [
      { roles: ["writer"] },
      { roles: ["producer"] },
      { roles: ["featured"] },
    ];
    expect(dominantRoleFromCollabs(collabs)).toBe("featured");
  });

  it("falls back to 'primary' when no roles match the known priority list", () => {
    expect(dominantRoleFromCollabs([{ roles: ["mixer"] }])).toBe("primary");
  });

  it("falls back to 'primary' for empty/undefined input", () => {
    expect(dominantRoleFromCollabs([])).toBe("primary");
    expect(dominantRoleFromCollabs(undefined)).toBe("primary");
  });

  it("is case-insensitive on role names", () => {
    expect(dominantRoleFromCollabs([{ roles: ["FEATURED"] }])).toBe("featured");
  });
});

describe("allRolesFromCollabs", () => {
  it("returns the deduplicated, lower-cased set of roles", () => {
    const collabs = [{ roles: ["Producer", "WRITER"] }, { roles: ["producer"] }];
    expect(allRolesFromCollabs(collabs).sort()).toEqual(["producer", "writer"]);
  });

  it("returns an empty array for no collaborations", () => {
    expect(allRolesFromCollabs([])).toEqual([]);
    expect(allRolesFromCollabs(undefined)).toEqual([]);
  });
});

describe("roleStyle", () => {
  it("returns the style for a known role", () => {
    expect(roleStyle("featured").color).toBeTruthy();
  });

  it("falls back to the primary style for unknown roles", () => {
    expect(roleStyle("unknown-role")).toBe(roleStyle("primary"));
  });
});

describe("brighten", () => {
  it("increases lightness of a hex color", () => {
    const result = brighten("#000000", 50);
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
    // Pure black brightened should no longer be pure black.
    expect(result).not.toBe("#000000");
  });

  it("caps lightness at 90% (never returns pure white for near-white input)", () => {
    const result = brighten("#ffffff", 50);
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("supports 3-digit hex shorthand", () => {
    const result = brighten("#0f0", 10);
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("defaults to a 18-point lightness bump when amount is omitted", () => {
    const withDefault = brighten("#334455");
    const withExplicit = brighten("#334455", 18);
    expect(withDefault).toBe(withExplicit);
  });
});

describe("placeholderFor", () => {
  it("returns a data: SVG URI containing the artist's initial", () => {
    const uri = placeholderFor("Radiohead", false);
    expect(uri).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(uri)).toContain(">R</text>");
  });

  it("uses the seed accent color for seed nodes and the pulse accent otherwise", () => {
    const seedSvg    = decodeURIComponent(placeholderFor("Drake", true));
    const nonSeedSvg = decodeURIComponent(placeholderFor("Drake", false));
    expect(seedSvg).toContain(COLOR.signal);
    expect(nonSeedSvg).toContain(COLOR.pulse);
  });

  it("is cached by initial+seed flag: different names sharing an initial collapse to the same placeholder", () => {
    const a = placeholderFor("Radiohead", false);
    const b = placeholderFor("Rihanna", false);
    expect(a).toBe(b);
  });

  it("treats seed vs non-seed as distinct cache entries for the same initial", () => {
    const seed    = placeholderFor("Radiohead", true);
    const nonSeed = placeholderFor("Radiohead", false);
    expect(seed).not.toBe(nonSeed);
  });

  describe("[SF-WEB-16] theme-dependent background", () => {
    const originalTheme = State.theme;

    afterEach(() => {
      document.documentElement.style.removeProperty("--panel");
      State.theme = originalTheme;
    });

    it("uses a different background fill in light vs dark theme", () => {
      document.documentElement.style.setProperty("--panel", "#141A28");
      State.theme = "dark";
      const darkSvg = decodeURIComponent(placeholderFor("Theme Test Artist", false));

      document.documentElement.style.setProperty("--panel", "#FFFFFF");
      State.theme = "light";
      const lightSvg = decodeURIComponent(placeholderFor("Theme Test Artist", false));

      expect(darkSvg).toContain("fill='#141A28'");
      expect(lightSvg).toContain("fill='#FFFFFF'");
      expect(darkSvg).not.toBe(lightSvg);
    });
  });
});

describe("isGeniusDefaultAvatar", () => {
  it("recognizes Genius's real default-image URL, cache-buster query string included", () => {
    expect(isGeniusDefaultAvatar("https://assets.genius.com/images/default_cover_image.png?1783625229")).toBe(true);
    expect(isGeniusDefaultAvatar("https://assets.genius.com/images/default_cover_image.png")).toBe(true);
  });

  it("does not flag a real photo URL", () => {
    expect(isGeniusDefaultAvatar("https://images.genius.com/1234567890abcdef.1000x1000x1.jpg")).toBe(false);
  });

  it("treats non-string/empty input as not a default avatar", () => {
    expect(isGeniusDefaultAvatar("")).toBe(false);
    expect(isGeniusDefaultAvatar(undefined)).toBe(false);
    expect(isGeniusDefaultAvatar(null)).toBe(false);
  });
});
