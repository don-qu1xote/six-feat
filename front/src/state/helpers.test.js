import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  escapeHtml,
  initialOf,
  debounce,
  lerp,
  roleStyle,
  brighten,
  placeholderFor,
  isGeniusDefaultAvatar,
} from "./helpers.js";
import { State, COLOR } from "./state.js";

describe("string helpers", () => {
  it("escapeHtml neutralises every special character and stringifies anything else", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });

  it("initialOf takes the first letter or digit, uppercased, and gives up with '?'", () => {
    expect(initialOf("radiohead")).toBe("R");
    expect(initialOf("  Muse")).toBe("M");
    expect(initialOf("21 savage")).toBe("2");
    expect(initialOf("Éric")).toBe("É");
    for (const noLetters of ["", "   ", "!!!"]) expect(initialOf(noLetters)).toBe("?");
  });
});

describe("lerp", () => {
  it("interpolates between the ends and keeps going past them", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 1)).toBe(10);
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

  it("fires once, after the wait, with the last call's arguments", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced("first");
    vi.advanceTimersByTime(200);
    debounced("second");
    vi.advanceTimersByTime(200);
    debounced("third", "extra");

    vi.advanceTimersByTime(299);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("third", "extra");
  });

  it("gives each debounced function its own timer", () => {
    const fnA = vi.fn();
    const fnB = vi.fn();
    debounce(fnA, 100)();
    debounce(fnB, 100)();

    vi.advanceTimersByTime(100);

    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });
});

describe("role derivation is gone from the client", () => {
  it("exports no re-derivation helpers, but keeps the documented duplication", async () => {
    const helpers = await import("./helpers.js");

    expect(helpers.dominantRoleFromCollabs).toBeUndefined();
    expect(helpers.allRolesFromCollabs).toBeUndefined();
    expect(helpers.sortByPopularity).toBeUndefined();

    expect(typeof helpers.isGeniusDefaultAvatar).toBe("function");
  });
});

describe("colour helpers", () => {
  it("roleStyle answers for a known role and falls back to primary for anything else", () => {
    expect(roleStyle("featured").color).toBeTruthy();
    expect(roleStyle("unknown-role")).toBe(roleStyle("primary"));
  });

  it("brighten returns a 6-digit hex for any input form and defaults to a fixed bump", () => {
    for (const input of ["#000000", "#ffffff", "#0f0"]) {
      expect(brighten(input, 50)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(brighten("#000000", 50)).not.toBe("#000000");
    expect(brighten("#334455")).toBe(brighten("#334455", 18));
  });
});

describe("placeholderFor", () => {
  it("draws the artist's initial with the accent that matches seed or not", () => {
    const uri = placeholderFor("Radiohead", false);
    expect(uri).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(uri)).toContain(">R</text>");

    expect(decodeURIComponent(placeholderFor("Drake", true))).toContain(COLOR.signal);
    expect(decodeURIComponent(placeholderFor("Drake", false))).toContain(COLOR.pulse);
  });

  it("caches by initial and seed flag, not by name", () => {
    expect(placeholderFor("Radiohead", false)).toBe(placeholderFor("Rihanna", false));
    expect(placeholderFor("Radiohead", true)).not.toBe(placeholderFor("Radiohead", false));
  });

  it("[SF-WEB-16] re-reads the panel colour per theme instead of serving the other theme's SVG", () => {
    const originalTheme = State.theme;
    try {
      document.documentElement.style.setProperty("--panel", "#141A28");
      State.theme = "dark";
      const darkSvg = decodeURIComponent(placeholderFor("Theme Test Artist", false));

      document.documentElement.style.setProperty("--panel", "#FFFFFF");
      State.theme = "light";
      const lightSvg = decodeURIComponent(placeholderFor("Theme Test Artist", false));

      expect(darkSvg).toContain("fill='#141A28'");
      expect(lightSvg).toContain("fill='#FFFFFF'");
    } finally {
      document.documentElement.style.removeProperty("--panel");
      State.theme = originalTheme;
    }
  });
});

describe("isGeniusDefaultAvatar", () => {
  it("matches Genius's placeholder path whatever the query string, and nothing else", () => {
    expect(
      isGeniusDefaultAvatar("https://assets.genius.com/images/default_cover_image.png?1783625229"),
    ).toBe(true);
    expect(isGeniusDefaultAvatar("https://assets.genius.com/images/default_cover_image.png")).toBe(
      true,
    );

    expect(
      isGeniusDefaultAvatar("https://images.genius.com/1234567890abcdef.1000x1000x1.jpg"),
    ).toBe(false);
    for (const notAUrl of ["", undefined, null]) expect(isGeniusDefaultAvatar(notAUrl)).toBe(false);
  });
});
