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
      expect(flat, `${selector} should use var(--glass-fill)`).toContain(
        "background:var(--glass-fill)",
      );
      expect(flat, `${selector} should compose --elevation-2 with --glass-glow`).toMatch(
        /box-shadow:var\(--elevation-2\),var\(--glass-glow\)/,
      );
      expect(flat, `${selector} should blur with var(--blur-scrim)`).toContain(
        "backdrop-filter:blur(var(--blur-scrim))",
      );
      expect(flat, `${selector} should round with var(--r-lg)`).toContain(
        "border-radius:var(--r-lg)",
      );
    }
  });

  it("the docked search field matches .path-input's field recipe (padding/radius/font-size/transition)", () => {
    const dockedInput = rule(css, ".search-modal.docked .search input");
    const pathInput = rule(css, ".path-input");
    expect(dockedInput, ".search-modal.docked .search input rule missing").toBeTruthy();
    expect(pathInput, ".path-input rule missing").toBeTruthy();
    for (const token of [
      "padding:var(--space-2)var(--space-3)",
      "border-radius:var(--r-sm)",
      "font-size:var(--text-sm)",
    ]) {
      expect(dockedInput.replace(/\s+/g, ""), token).toContain(token);
      expect(pathInput.replace(/\s+/g, ""), token).toContain(token);
    }
    expect(dockedInput).toMatch(
      /transition:\s*border-color\s*var\(--duration-base\)\s*var\(--ease-standard\)/,
    );
    expect(pathInput).toMatch(
      /transition:\s*border-color\s*var\(--duration-base\)\s*var\(--ease-standard\)/,
    );
  });

  it("the docked search button matches .dock-btn's hover/active tokens, not its own literal", () => {
    const dockedButtonHover = rule(css, ".search-modal.docked .search button:hover");
    const dockBtnHover = rule(css, ".dock-btn:hover");
    expect(
      dockedButtonHover,
      ".search-modal.docked .search button:hover rule missing",
    ).toBeTruthy();
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
