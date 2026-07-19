// @vitest-environment node
// ════════════════════════════════════════════════════════════════════════════
// companion-observatory.test.js — [SF-WEB-44] Observatory pass on the
// companion panel's node/edge/path contexts.
//
// SF-WEB-44 is shell-only (the companion panel already sits in .ui-panel —
// see companion.css's own comment) plus a light re-token pass and a couple
// of small visual additions (seed-glow avatar, "constellation" glow on
// path/hop avatars and connectors) — static markup throughout (SF-WEB-12),
// no dynamic grid-tile insertion, handlers unchanged. This file asserts the
// specific things the ticket calls for: role-chip colours are token-driven
// (not the dark theme's hex hardcoded per callsite — the same bug class
// SF-WEB-42/43 already fixed elsewhere), the mini-action row is one
// .ui-segment (not four independent buttons), and the new glow rules exist
// and are token-driven, not literals.
// ════════════════════════════════════════════════════════════════════════════
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

describe("SF-WEB-44 companion panel — Observatory pass", () => {
  it("the companion panel is a .ui-panel (glass shell), not a bespoke card", () => {
    const tag = html.match(/<div class="([^"]*)"\s+id="companion-panel">/);
    expect(tag, "companion-panel element not found").toBeTruthy();
    expect(tag[1]).toMatch(/\bui-panel\b/);
  });

  it("role-chip--writer/--primary use RGB-triplet tokens, not the dark theme's hex hardcoded per callsite", () => {
    for (const selector of [".role-chip--writer", ".role-chip--primary"]) {
      const block = rule(css, selector);
      expect(block, `${selector} rule missing`).toBeTruthy();
      expect(block).not.toMatch(/rgba\(\s*255,\s*210,\s*122/);
      expect(block).not.toMatch(/rgba\(\s*143,\s*166,\s*201/);
      expect(block).toMatch(/rgba\(var\(--(amber|primary2)-rgb\)/);
    }
  });

  it("--amber-rgb/--primary2-rgb are defined and redefined per theme", () => {
    const root = rule(css, ":root");
    expect(root).toContain("--amber-rgb");
    expect(root).toContain("--primary2-rgb");
    const lightBlock = rule(css, ':root[data-theme="light"]') || rule(css, ":root[data-theme=light]");
    expect(lightBlock, "light theme :root block not found").toBeTruthy();
    expect(lightBlock).toContain("--amber-rgb");
    expect(lightBlock).toContain("--primary2-rgb");
  });

  it("the mini-action row is one .ui-segment container, not four independently-floating buttons", () => {
    expect(html).toMatch(/<div class="object-action-bar ui-segment"/);
  });

  it("the seed avatar glow (.sidebar-avatar.is-seed) is token-driven, built from --signal-rgb", () => {
    const block = rule(css, ".sidebar-avatar.is-seed");
    expect(block, ".sidebar-avatar.is-seed rule missing").toBeTruthy();
    expect(block).toMatch(/rgba\(var\(--signal-rgb\)/);
  });

  it("path/hop avatars and connectors carry the constellation glow (--signal-rgb), not a flat border only", () => {
    for (const selector of [".hop-avatar", ".path-node-avatar", ".path-edge-connector"]) {
      const block = rule(css, selector);
      expect(block, `${selector} rule missing`).toBeTruthy();
      expect(block).toMatch(/box-shadow:.*rgba\(var\(--signal-rgb\)/);
    }
  });

  it("no dynamic grid-tile insertion helper (ensureTile) is defined in the sidebar module", () => {
    // sidebar.js's own comments reference the name historically ("no more
    // ensureTile()-style DOM insertion") — that prose should stay; this
    // only checks that no such function is actually *defined* any more.
    const sidebarSrc = readFileSync(resolve(here, "../ui/sidebar.js"), "utf8");
    expect(sidebarSrc).not.toMatch(/function\s+ensureTile\b/);
    expect(sidebarSrc).not.toMatch(/\bensureTile\s*=\s*\(/);
  });
});
