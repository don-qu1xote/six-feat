// @vitest-environment node
// ════════════════════════════════════════════════════════════════════════════
// docked-search-shell.test.js — [SF-WEB-43] one visual shell for every search
// surface (docked search-modal, node-search-overlay, path-panel/companion-
// panel) plus hero's shared autocomplete dropdown.
//
// SF-WEB-43 is purely visual (no handlers/selectors change, docked-panel.js's
// mutual-exclusivity/outside-close mechanism is untouched — see that file's
// own docked-panel.test.js, still passing unmodified) and explicitly does
// NOT merge the three docked entry points (SF-WEB-24 stands) — each keeps
// its own width/content. What it asserts: every docked surface's shell
// (background/box-shadow/backdrop-filter/border-radius) and every result-row
// hover draw from the SAME tokens (--glass-fill/--glass-glow/--elevation-2/
// --blur-scrim/--r-lg/--signal-rgb), not four near-identical but separately
// hardcoded recipes.
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

// Unlike observatory.test.js's version, this one anchors the selector to a
// line start (not just any substring match) — a plain indexOf(".path-input
// {") also matches inside ".hero-connect-fields .path-input {", a genuinely
// different (and out of scope — hero-scale, not docked) rule that just
// happens to end with the same text. Also tolerates a multi-selector rule
// (e.g. ".ac-item:hover,\n.ac-item.ac-active {") by only requiring the
// FIRST selector in the list to open the match.
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*[,{][\\s\\S]*?\\{`));
  if (!m) return null;
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  const end = css.indexOf("}", start);
  return css.slice(start, end + 1);
}

const css = bundleCss();

describe("SF-WEB-43 docked search shell — one material, one source", () => {
  it("all three docked surfaces + hero's autocomplete dropdown share the same glass shell tokens", () => {
    const shells = {
      ".search-modal.docked .search-wrap": rule(css, ".search-modal.docked .search-wrap"),
      ".node-search-box": rule(css, ".node-search-box"),
      ".ui-panel": rule(css, ".ui-panel"),
      ".ac-dropdown": rule(css, ".ac-dropdown"),
    };
    for (const [selector, block] of Object.entries(shells)) {
      expect(block, `${selector} rule missing`).toBeTruthy();
      const flat = block.replace(/\s+/g, "");
      expect(flat, `${selector} should use var(--glass-fill)`).toContain("background:var(--glass-fill)");
      expect(flat, `${selector} should compose --elevation-2 with --glass-glow`)
        .toMatch(/box-shadow:var\(--elevation-2\),var\(--glass-glow\)/);
      expect(flat, `${selector} should blur with var(--blur-scrim)`).toContain("backdrop-filter:blur(var(--blur-scrim))");
      expect(flat, `${selector} should round with var(--r-lg)`).toContain("border-radius:var(--r-lg)");
    }
  });

  it("the docked search field matches .path-input's field recipe (padding/radius/font-size/transition)", () => {
    const dockedInput = rule(css, ".search-modal.docked .search input");
    const pathInput = rule(css, ".path-input");
    expect(dockedInput, ".search-modal.docked .search input rule missing").toBeTruthy();
    expect(pathInput, ".path-input rule missing").toBeTruthy();
    for (const token of ["padding:var(--space-2)var(--space-3)", "border-radius:var(--r-sm)", "font-size:var(--text-sm)"]) {
      expect(dockedInput.replace(/\s+/g, ""), token).toContain(token);
      expect(pathInput.replace(/\s+/g, ""), token).toContain(token);
    }
    // [SF-WEB-47 motion] Was a bare ".15s" literal — now var(--duration-base).
    expect(dockedInput).toMatch(/transition:\s*border-color\s*var\(--duration-base\)\s*var\(--ease-standard\)/);
    expect(pathInput).toMatch(/transition:\s*border-color\s*var\(--duration-base\)\s*var\(--ease-standard\)/);
  });

  it("the docked search button matches .dock-btn's hover/active tokens, not its own literal", () => {
    const dockedButtonHover = rule(css, ".search-modal.docked .search button:hover");
    const dockBtnHover = rule(css, ".dock-btn:hover");
    expect(dockedButtonHover, ".search-modal.docked .search button:hover rule missing").toBeTruthy();
    expect(dockBtnHover, ".dock-btn:hover rule missing").toBeTruthy();
    expect(dockedButtonHover).toMatch(/background:\s*var\(--hover-tint\)/);
    expect(dockBtnHover).toMatch(/background:\s*var\(--hover-tint\)/);
  });

  it("every docked/hero result-row hover uses the theme-aware --signal-rgb triplet, not a hardcoded literal", () => {
    for (const selector of [".ac-item:hover", ".ns-item:hover"]) {
      const block = rule(css, selector);
      expect(block, `${selector} rule missing`).toBeTruthy();
      expect(block).toMatch(/rgba\(var\(--signal-rgb\)/);
      expect(block).not.toMatch(/rgba\(\s*94,\s*230,\s*197/);
    }
  });
});
