// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function bundleCss() {
  const result = buildSync({
    entryPoints: [join(here, "index.css")],
    bundle: true,
    write: false,
  });
  return result.outputFiles[0].text;
}

function rule(css, selector) {
  const idx = css.indexOf(`${selector} {`);
  if (idx === -1) return null;
  const end = css.indexOf("}", idx);
  return css.slice(idx, end + 1);
}

const css = bundleCss();

describe("SF-WEB-42 Observatory shell — tokens", () => {
  it("defines RGB-triplet tokens for the new glass/focus-ring/tint composites", () => {
    for (const token of ["--panel-2-rgb", "--signal-rgb", "--pulse-rgb"]) {
      expect(css, `${token} missing`).toContain(token);
    }
  });

  it("light theme redefines its own triplets instead of inheriting dark's", () => {
    const lightBlockRaw =
      rule(css, ':root[data-theme="light"]') || rule(css, ":root[data-theme=light]");
    expect(lightBlockRaw, "light theme :root block not found").toBeTruthy();
    const lightBlock = lightBlockRaw.replace(/\s+/g, "");
    expect(lightBlock).toContain("--panel-2-rgb:244,246,251");
    expect(lightBlock).toContain("--signal-rgb:11,125,100");
    expect(lightBlock).toContain("--pulse-rgb:112,60,255");
  });

  it("composes glass-fill/glass-glow/focus-ring/tint tokens from the triplets, not fresh literals", () => {
    const root = rule(css, ":root");
    for (const composite of [
      "--glass-fill:rgba(var(--panel-2-rgb)",
      "--glass-glow:0 0 28px -6px rgba(var(--signal-rgb)",
      "--focus-ring:0 0 0 3px rgba(var(--signal-rgb)",
      "--focus-ring-strong:0 0 0 3px rgba(var(--signal-rgb)",
      "--hover-tint:rgba(var(--pulse-rgb)",
      "--active-tint:rgba(var(--signal-rgb)",
    ]) {
      expect(root.replace(/\s+/g, ""), `${composite} not composed from a triplet token`).toContain(
        composite.replace(/\s+/g, ""),
      );
    }
  });

  it("defines a named type-scale token per font family", () => {
    for (const token of ["--font-sans", "--font-display", "--font-mono"]) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/--font-sans:\s*"Inter"/);
    expect(css).toMatch(/--font-display:\s*"Syne"/);
    expect(css).toMatch(/--font-mono:\s*"Space Mono"/);
  });
});

describe("SF-WEB-42 Observatory shell — glass panels", () => {
  it(".ui-panel and .bento-tile use the translucent --glass-fill, not an opaque solid", () => {
    for (const selector of [".ui-panel", ".bento-tile"]) {
      const r = rule(css, selector);
      expect(r, `${selector} rule missing`).toBeTruthy();
      expect(r, `${selector} should use var(--glass-fill)`).toMatch(
        /background:\s*var\(--glass-fill\)/,
      );
      expect(r, `${selector} should not be pinned to the old opaque var(--panel-2)`).not.toMatch(
        /background:\s*var\(--panel-2\)/,
      );
    }
  });

  it("every glass panel actually carries backdrop-filter (so the translucency is visible)", () => {
    for (const selector of [".ui-panel", ".bento-tile", ".ui-segment"]) {
      const r = rule(css, selector);
      expect(r, `${selector} missing backdrop-filter`).toMatch(/backdrop-filter:\s*blur\(/);
    }
  });

  it(".ui-panel and .bento-tile pair their elevation shadow with the accent glow, not replace it", () => {
    const panel = rule(css, ".ui-panel");
    const tile = rule(css, ".bento-tile");
    expect(panel).toMatch(/box-shadow:\s*var\(--elevation-2\),\s*var\(--glass-glow\)/);
    expect(tile).toMatch(/box-shadow:\s*var\(--shadow\),\s*var\(--glass-glow\)/);
  });
});

describe("SF-WEB-42 Observatory shell — unified hover/active/focus-ring", () => {
  it(".ui-btn and .ui-chip share the same focus-ring/hover/active tokens (not independent literals)", () => {
    for (const selector of [".ui-btn", ".ui-chip"]) {
      const hover = rule(css, `${selector}:hover`);
      const focus = rule(css, `${selector}:focus-visible`);
      expect(hover, `${selector}:hover missing`).toMatch(/background:\s*var\(--hover-tint\)/);
      expect(focus, `${selector}:focus-visible missing`).toMatch(
        /box-shadow:\s*var\(--focus-ring\)/,
      );
    }
  });

  it(".ui-btn--primary gets the louder --focus-ring-strong, still token-driven", () => {
    const r = rule(css, ".ui-btn--primary:focus-visible");
    expect(r).toMatch(/box-shadow:\s*var\(--focus-ring-strong\)/);
  });

  it("no leftover hardcoded dark-theme focus/hover/active rgba literal remains on the kit", () => {
    for (const selector of [".ui-btn", ".ui-btn--primary", ".ui-chip"]) {
      for (const state of [":hover", ":focus-visible", ".active", '[aria-pressed="true"]']) {
        const r = rule(css, `${selector}${state}`);
        if (!r) continue;
        expect(
          r,
          `${selector}${state} still has a literal rgba(94,230,197,...) instead of a token`,
        ).not.toMatch(/rgba\(94,\s*230,\s*197/);
        expect(
          r,
          `${selector}${state} still has a literal rgba(185,138,255,...) instead of a token`,
        ).not.toMatch(/rgba\(185,\s*138,\s*255/);
      }
    }
  });
});

describe("SF-WEB-42 Observatory shell — canvas background stays readable", () => {
  it("body background layers grain + the deep space-ink radial glow + an ink fallback, all token-driven", () => {
    const idx = css.indexOf("feTurbulence");
    expect(idx, "no CSS-only grain (feTurbulence data URI) found on body").toBeGreaterThan(-1);
    const bg = css.slice(css.lastIndexOf("background:", idx), css.indexOf("}", idx) + 1);
    expect(bg).toContain("data:image/svg+xml");
    expect(bg).toMatch(/radial-gradient\(/);
    expect(bg).toContain("var(--hero-glow)");
    expect(bg).toContain("var(--ink)");
  });

  it("body uses the sans type-scale token, and the canvas host selector survives untouched", () => {
    expect(css).toMatch(/font-family:\s*var\(--font-sans\)/);
    expect(rule(css, ".app-canvas")).toBeTruthy();
    expect(css).toContain("#network");
  });

  it("no external asset URLs were introduced (grain is CSS-only, per the ticket)", () => {
    expect(css).not.toMatch(/url\(["']?https?:\/\//);
  });
});
