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
});
