// @vitest-environment node
// ════════════════════════════════════════════════════════════════════════════
// styles.test.js — [SF-WEB-40] the design-system CSS bundle.
//
// Runs in the node environment (not the project-default jsdom): esbuild's
// buildSync relies on a native TextEncoder producing a real Uint8Array,
// which jsdom's polyfill breaks.
//
// Asserts (per the ticket's build/vitest test): the CSS actually bundles
// from src/styles/index.css, both themes are token-driven, and every
// id/class selector the JS reaches for still exists in the built output —
// this step is a pure extraction, so a missing hook here means a real
// regression (a rule dropped or renamed during the move).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
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

const css = bundleCss();

describe("SF-WEB-40 design-system CSS bundle", () => {
  it("bundles a non-empty stylesheet from src/styles/index.css", () => {
    expect(css.length).toBeGreaterThan(10000);
  });

  it("drives both themes from tokens (dark :root + light override), not hardcoded", () => {
    expect(css).toContain(":root");
    expect(css).toMatch(/\[data-theme=("?)light\1\]/);
    // A few tokens both themes redefine — proof the palette is variable-driven.
    for (const token of ["--signal", "--pulse", "--paper", "--ink", "--mist"]) {
      expect(css, `token ${token} missing`).toContain(token);
    }
  });

  it("keeps every JS-hook selector the app renders against", () => {
    const hooks = [
      // canvas / graph
      "#network", ".app-canvas", ".canvas-decorator", ".ui-state-slot",
      // search / hero
      ".search-modal", ".search-wrap", ".hero-mode-switch", ".ac-dropdown",
      ".chip", ".include-roles-row",
      // rail / controls / status
      ".rail", ".rail-btn", ".theme-toggle", ".seed-card",
      ".canvas-zoom-cluster", ".role-filter-segment", ".rate-limit-badge",
      ".scan-status-badge", ".help-overlay", ".context-panel",
      // companion panel + sections
      ".companion-panel", ".artist-sidebar", ".sidebar-body", ".path-panel",
      ".compare-panel", ".hop-chain", ".path-chain-track", ".role-chip--featured",
      // overlays
      ".candidate-overlay", ".node-search-overlay", ".overlay", ".spinner",
      ".toast", ".vis-tooltip",
      // component kit
      ".ui-btn", ".ui-chip", ".ui-pill", ".ui-segment", ".ui-panel",
      ".ui-tile", ".bento-tile",
    ];
    for (const hook of hooks) {
      expect(css, `hook selector ${hook} missing from bundle`).toContain(hook);
    }
  });

  it("keeps the state/behaviour class hooks JS toggles", () => {
    // Modifier classes added/removed by JS at runtime — their rules must survive.
    for (const cls of [
      ".search-modal.docked", ".search-modal.is-closed", ".companion-panel.show",
      ".artist-sidebar.show", ".path-panel.show", ".compare-panel.show",
      ".app-canvas.search-open", ".hero-mode-panel.is-active",
    ]) {
      expect(css, `state hook ${cls} missing`).toContain(cls);
    }
  });

  // [fix] companion.css's "1 hop from seed" / path-chain / compare-item
  // cards hardcoded rgba(20,26,40,...)/(40,48,68,...)/(94,230,197,...)/
  // (185,138,255,...) — the dark theme's own hex, pinned regardless of
  // which theme was active — instead of the theme-aware --panel-rgb/
  // --line-rgb/--signal-rgb/--pulse-rgb triplets .path-input right next to
  // them already used. Result: those cards stayed dark-styled under
  // :root[data-theme="light"]. Guards against the literals creeping back
  // (checks the raw source, not the bundle — tokens.css/button.css's own
  // prose comments mention these exact numbers when explaining past fixes,
  // which would false-positive a bundle-wide check).
  it("companion.css's path/compare cards use RGB-triplet tokens, not dark-pinned literals", () => {
    const companionSrc = readFileSync(join(here, "surfaces/companion.css"), "utf8");
    for (const literal of [
      /rgba\(\s*20,\s*26,\s*40/, /rgba\(\s*40,\s*48,\s*68/,
      /rgba\(\s*94,\s*230,\s*197/, /rgba\(\s*185,\s*138,\s*255/,
    ]) {
      expect(companionSrc, `dark-pinned literal ${literal} still present`).not.toMatch(literal);
    }
  });

  it("defines a theme-aware --line-rgb triplet, redefined per theme", () => {
    expect(css).toContain("--line-rgb");
  });

  // [fix] --on-accent (text on the signal→pulse accent gradient — the
  // primary button, hero-mode thumb, etc.) used to be a single fixed
  // near-black value shared by both themes. Light theme's --signal/--pulse
  // are darker/more saturated than dark theme's, so that near-black text
  // read as low-contrast there — light theme now overrides --on-accent to
  // a near-white value instead of inheriting the dark one.
  it("light theme overrides --on-accent instead of inheriting the dark near-black default", () => {
    const lightBlockRaw = rule(css, ':root[data-theme="light"]') || rule(css, ":root[data-theme=light]");
    expect(lightBlockRaw, "light theme :root block not found").toBeTruthy();
    expect(lightBlockRaw).toMatch(/--on-accent:\s*#[0-9a-fA-F]{6}/);
    const rootBlock = rule(css, ":root");
    const darkOnAccent  = rootBlock.match(/--on-accent:\s*(#[0-9a-fA-F]{6})/)[1];
    const lightOnAccent = lightBlockRaw.match(/--on-accent:\s*(#[0-9a-fA-F]{6})/)[1];
    expect(lightOnAccent.toLowerCase()).not.toBe(darkOnAccent.toLowerCase());
  });

  // [fix] The "Six degrees of separation" panel's search status
  // (.path-result: loading spinner, error card) used to render embedded
  // in the panel itself — reported as the search process feeling "bolted
  // into the window". runServerPath (ui/path-result.js) now shows
  // loading on the same canvas-wide overlay regular artist search uses
  // (#loading) and errors as a toast (#toast), the exact two mechanisms
  // searchArtist already relies on — so .path-result and its markup are
  // gone entirely, not just restyled.
  it(".path-result is gone — path search loading/errors go through #loading/#toast, not an embedded element", () => {
    expect(css).not.toMatch(/(?:^|\n)\.path-result\s*[.{]/);
    expect(css).not.toContain(".hero-connect-panel .path-result");
  });

  // [fix] .path-panel/.compare-panel had max-height: 60% — a bare
  // percentage of .companion-panel's own height, which is itself auto/
  // shrink-to-fit. Percentage height against an indefinite-height
  // ancestor is a circular reference the browser can't resolve in one
  // pass: measured live, .companion-panel rendered ~221px tall while
  // .path-panel's actual content only needed ~112px, leaving a ~75-100px
  // dead gap under the From/To fields (reported: "не нравится пустое
  // место"). .artist-sidebar already sidesteps this with
  // min(70vh,100%) — the 100% only matters if 70vh were somehow bigger,
  // so resolution never actually depends on the indefinite ancestor.
  // Same fix applied to both, verified live (.path-panel's rect now
  // matches .companion-panel's full content height, no gap).
  it(".path-panel/.compare-panel use min(Xvh, 100%), not a bare percentage max-height", () => {
    for (const selector of [".path-panel", ".compare-panel"]) {
      const block = rule(css, selector);
      expect(block, `${selector} rule missing`).toBeTruthy();
      expect(block, `${selector} still has a bare percentage max-height`).not.toMatch(/max-height:\s*\d+%/);
      expect(block).toMatch(/max-height:\s*min\(\d+vh,\s*100%\)/);
    }
  });

  // [fix] Rebuilt docked "Six degrees of separation" panel — was reported
  // as unchanged-looking after only the loading/error mechanism moved out
  // ("ничего не изменилось"). Picked variant B of 5 mockups: a functional
  // swap button (.path-swap-btn, actually swaps From/To — see
  // ui/path-panel.js) sits between the two fields instead of decorative
  // connector dots, the submit action (.dock-btn--primary) gets a
  // signal-coloured border so it reads as the CTA next to a demoted plain-
  // text Clear link (.path-clear-btn) — no reserved idle space anywhere,
  // the panel is exactly as tall as its fields + actions.
  it(".path-swap-btn exists and is a real (non-decorative) circular icon control", () => {
    const block = rule(css, ".path-swap-btn");
    expect(block, ".path-swap-btn rule missing").toBeTruthy();
    expect(block).toMatch(/border-radius:\s*50%/);
  });

  it(".dock-btn--primary distinguishes the submit action with a signal border, not a fill", () => {
    const block = rule(css, ".dock-btn--primary");
    expect(block, ".dock-btn--primary rule missing").toBeTruthy();
    expect(block).toMatch(/border-color:\s*rgba\(var\(--signal-rgb\)/);
    expect(block).not.toMatch(/background:\s*linear-gradient/);
  });

  it(".path-clear-btn is a plain text link, not a second bordered pill matching Find path", () => {
    const block = rule(css, ".path-clear-btn");
    expect(block, ".path-clear-btn rule missing").toBeTruthy();
    expect(block).toMatch(/border:\s*0/);
    expect(block).toMatch(/background:\s*transparent/);
  });
});

function rule(css, selector) {
  const idx = css.indexOf(`${selector} {`);
  if (idx === -1) return null;
  const end = css.indexOf("}", idx);
  return css.slice(idx, end + 1);
}
