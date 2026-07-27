// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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
const html = readFileSync(resolve(here, "../../index.html"), "utf8");

describe("Connect panel redesign — matches Explore's scale, no boxed card", () => {
  it("hero-mode-panel-connect no longer carries the bento-tile card classes", () => {
    const tag = html.match(/<div class="([^"]*)"\s+id="hero-mode-panel-connect"/);
    expect(tag, "hero-mode-panel-connect element not found").toBeTruthy();
    expect(tag[1]).not.toMatch(/\bbento-tile\b/);
  });

  it("the Connect fields match .search input's scale (--text-base / --space-4 --space-5)", () => {
    const connectField = rule(css, ".hero-connect-fields .path-input");
    const exploreField = rule(css, ".search input");
    expect(connectField, ".hero-connect-fields .path-input rule missing").toBeTruthy();
    expect(exploreField, ".search input rule missing").toBeTruthy();
    for (const token of ["font-size:var(--text-base)", "padding:var(--space-4)var(--space-5)"]) {
      expect(connectField.replace(/\s+/g, ""), token).toContain(token);
      expect(exploreField.replace(/\s+/g, ""), token).toContain(token);
    }
  });

  it("the Connect field's focus glow uses the theme-aware --signal-rgb triplet, not a hardcoded literal", () => {
    const focus = rule(css, ".hero-connect-fields .path-input:focus");
    expect(focus, ".hero-connect-fields .path-input:focus rule missing").toBeTruthy();
    expect(focus).toMatch(/rgba\(var\(--signal-rgb\)/);
    expect(focus).not.toMatch(/rgba\(\s*94,\s*230,\s*197/);
  });
});
