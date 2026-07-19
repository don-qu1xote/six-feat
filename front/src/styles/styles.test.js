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

// [SF-WEB-47 motion] durations/easing/stagger are all defined as tokens in
// :root — the single source physics.js/render.js's MOTION getters and every
// CSS transition/animation now read from, instead of scattered literals.
describe("SF-WEB-47 motion tokens", () => {
  it("defines every duration/ease/stagger token the motion system relies on", () => {
    for (const token of [
      "--ease-standard", "--ease-out", "--ease-emphasized",
      "--duration-fast", "--duration-base", "--duration-med", "--duration-slow",
      "--duration-slower", "--duration-xslow", "--duration-flight",
      "--duration-camera", "--duration-xxslow", "--duration-loop",
      "--stagger-1", "--stagger-2", "--stagger-3",
    ]) {
      expect(css, `token ${token} missing`).toContain(token);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [SF-WEB-49] Dark + light theme parity — both a first-class palette on the
// same tokens (not light-as-a-hasty-inversion-of-dark), verified two ways:
// every color token both themes need actually gets redefined in the light
// override (not silently inherited from dark), and the text-bearing accent
// tokens (--signal/--pulse/--amber/--mist/--paper/--on-accent — all used as
// `color:` somewhere in components/*.css or surfaces/*.css, at --text-xs/sm
// sizes WCAG treats as normal text) clear the AA 4.5:1 contrast threshold
// against the surfaces they actually render on, in BOTH themes.
// ════════════════════════════════════════════════════════════════════════════
function extractVar(block, name) {
  const m = block && block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  return m ? m[1] : null;
}

function relLuminance(hex) {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// WCAG 2.x contrast ratio — (L1+0.05)/(L2+0.05), L1 the lighter of the pair.
function contrastRatio(hexA, hexB) {
  const lA = relLuminance(hexA), lB = relLuminance(hexB);
  const [lighter, darker] = lA > lB ? [lA, lB] : [lB, lA];
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_TEXT = 4.5; // WCAG AA, normal-size text

describe("[SF-WEB-49] theme tokens — dark + light both defined, not one inverted from the other", () => {
  const darkBlock  = rule(css, ":root");
  const lightBlock = rule(css, ':root[data-theme="light"]') || rule(css, ":root[data-theme=light]");

  it("both theme blocks exist in the bundle", () => {
    expect(darkBlock, ":root block missing").toBeTruthy();
    expect(lightBlock, ':root[data-theme="light"] block missing').toBeTruthy();
  });

  it("every color token the app themes redefines a real, distinct value in light — not inherited from dark", () => {
    const colorTokens = [
      "--ink", "--ink-2", "--panel", "--panel-2", "--line", "--mist", "--paper",
      "--signal", "--pulse", "--amber", "--warn", "--neon", "--primary2",
      "--on-accent", "--hero-glow", "--panel-rgb", "--ink2-rgb", "--line-rgb",
      "--panel-2-rgb", "--signal-rgb", "--pulse-rgb", "--amber-rgb", "--primary2-rgb",
    ];
    for (const token of colorTokens) {
      const inLight = lightBlock.match(new RegExp(`${token}:\\s*[^;]+;`));
      expect(inLight, `${token} not redefined in the light theme block`).toBeTruthy();
    }
  });
});

describe("[SF-WEB-49] theme contrast — text-bearing accents clear AA (4.5:1) in both themes", () => {
  const darkBlock  = rule(css, ":root");
  const lightBlock = rule(css, ':root[data-theme="light"]') || rule(css, ":root[data-theme=light]");

  function themeVars(block) {
    const v = name => extractVar(block, name);
    return {
      panel: v("--panel"), ink: v("--ink"), paper: v("--paper"), mist: v("--mist"),
      signal: v("--signal"), pulse: v("--pulse"), amber: v("--amber"), onAccent: v("--on-accent"),
    };
  }

  it("dark theme", () => {
    const t = themeVars(darkBlock);
    expect(contrastRatio(t.paper, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.mist,  t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.mist,  t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.signal, t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.signal, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.amber,  t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.pulse,  t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    // Button/toast text sitting directly on the signal/pulse accent fill.
    expect(contrastRatio(t.onAccent, t.signal)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.onAccent, t.pulse)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("light theme — same thresholds as dark, not a looser bar for the 'inverted' palette", () => {
    const t = themeVars(lightBlock);
    expect(contrastRatio(t.paper, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.mist,  t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.mist,  t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.signal, t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.signal, t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.amber,  t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.pulse,  t.panel)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.pulse,  t.ink)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.onAccent, t.signal)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(t.onAccent, t.pulse)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

// [SF-WEB-50] Landing atmosphere: the drifting starfield dots must stop
// under prefers-reduced-motion (a real user preference, not a nice-to-have)
// — the dandelion's own nodes/edges (.decor-node/.decor-edge) never had an
// `animation` in the first place, so there's nothing for that media query
// to need to override for them; only .decor-dot's own `animation: ...`
// declaration (canvas.css) needs a matching `animation: none` inside
// `@media (prefers-reduced-motion: reduce)`.
describe("[SF-WEB-50] landing decorator — reduced-motion stops the drift", () => {
  it(".decor-dot animates by default", () => {
    const block = rule(css, ".decor-dot");
    expect(block, ".decor-dot rule missing").toBeTruthy();
    expect(block).toMatch(/animation:\s*decor-drift/);
  });

  it("prefers-reduced-motion turns .decor-dot's animation off", () => {
    const mq = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(mq, "no prefers-reduced-motion: reduce block found").toBeGreaterThan(-1);
    // A generous fixed slice rather than brace-matching the media query's
    // own close — esbuild's unminified nesting/indentation isn't a format
    // worth depending on precisely, and .decor-dot's override is the very
    // next rule in this block regardless of exact whitespace.
    const mqBlock = css.slice(mq, mq + 300);
    expect(mqBlock).toMatch(/\.decor-dot\s*\{[^}]*animation:\s*none/);
  });

  it("the dandelion's own nodes/edges never declare an animation to begin with — nothing to gate", () => {
    for (const selector of [".decor-node", ".decor-edge"]) {
      const block = rule(css, selector);
      expect(block, `${selector} rule missing`).toBeTruthy();
      expect(block).not.toMatch(/animation:/);
    }
  });
});

function rule(css, selector) {
  const idx = css.indexOf(`${selector} {`);
  if (idx === -1) return null;
  const end = css.indexOf("}", idx);
  return css.slice(idx, end + 1);
}
