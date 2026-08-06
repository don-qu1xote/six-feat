import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const html = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.html"),
  "utf8",
);

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe("[SF-WEB-14] no duplicate global entry points on the canvas", () => {
  it("has no separate rail buttons for the three object-action-bar actions", () => {
    expect(countOccurrences(html, 'id="obj-action-expand"')).toBe(1);
    expect(countOccurrences(html, 'id="obj-action-focus"')).toBe(1);
    expect(countOccurrences(html, 'id="obj-action-genius"')).toBe(1);
    expect(html).not.toContain('id="obj-action-pin"');
  });

  it("has exactly one #btn-fit-view — moved into the zoom cluster, not duplicated", () => {
    expect(countOccurrences(html, 'id="btn-fit-view"')).toBe(1);
  });

  it("has no rail role-filter buttons left — only the canvas segment's", () => {
    expect(html).not.toContain('id="filter-featured"');
    expect(html).not.toContain('id="filter-producer"');
    expect(html).not.toContain('id="filter-writer"');
    expect(countOccurrences(html, 'id="canvas-filter-featured"')).toBe(1);
    expect(countOccurrences(html, 'id="canvas-filter-producer"')).toBe(1);
    expect(countOccurrences(html, 'id="canvas-filter-writer"')).toBe(1);
  });

  it("still has the zoom-in/zoom-out/focus-seed buttons the cluster reuses fitView/zoomIn/zoomOut/focusSeed with", () => {
    expect(countOccurrences(html, 'id="btn-zoom-in"')).toBe(1);
    expect(countOccurrences(html, 'id="btn-zoom-out"')).toBe(1);
    expect(countOccurrences(html, 'id="btn-focus-seed"')).toBe(1);
  });
});

describe("[SF-WEB-27] object action bar merged into the sidebar body", () => {
  it("has no standalone sidebar-genius-btn element left — Genius is one of the object action bar's own buttons now", () => {
    expect(html).not.toContain('id="sidebar-genius-btn"');
    expect(html).not.toContain('class="sidebar-genius-btn"');
  });

  it("no longer floats #object-action-bar above the companion panel — it's nested inside .sidebar-body, after #companion-panel opens", () => {
    const companionPanelIdx = html.indexOf('id="companion-panel"');
    const actionBarIdx = html.indexOf('id="object-action-bar"');
    expect(companionPanelIdx).toBeGreaterThan(-1);
    expect(actionBarIdx).toBeGreaterThan(companionPanelIdx);
  });

  it("renders exactly one action row containing Genius for node context", () => {
    expect(countOccurrences(html, 'id="object-action-bar"')).toBe(1);
    expect(countOccurrences(html, 'id="obj-action-genius"')).toBe(1);
    const barStart = html.indexOf('id="object-action-bar"');
    const barEnd = html.indexOf("</div>", html.indexOf('id="obj-action-genius"'));
    const barBlock = html.slice(barStart, barEnd);
    expect(barBlock).toContain('id="obj-action-genius"');
  });
});

describe("[SF-WEB-31] landing redesign keeps every entry point, just reorganized", () => {
  it("keeps a brand h1 on the landing modal", () => {
    expect(html).toContain("<h1>");
  });

  it("collapses role filters into a native <details> disclosure instead of an always-visible row", () => {
    expect(html).toContain('<details class="include-roles-row">');
    expect(html).toContain('class="include-roles-summary"');
  });

  it("keeps every role-filter button (same ids, same wiring) inside the disclosure", () => {
    expect(countOccurrences(html, 'id="hero-filter-featured"')).toBe(1);
    expect(countOccurrences(html, 'id="hero-filter-producer"')).toBe(1);
    expect(countOccurrences(html, 'id="hero-filter-writer"')).toBe(1);
  });

  it("keeps the Explore/Connect switch and the Connect panel — not removed, just already secondary", () => {
    expect(countOccurrences(html, 'id="hero-mode-switch"')).toBe(1);
    expect(countOccurrences(html, 'id="hero-mode-panel-connect"')).toBe(1);
  });

  it("keeps the chips row and the auth bar", () => {
    expect(countOccurrences(html, 'id="chips"')).toBe(1);
    expect(countOccurrences(html, 'id="auth-bar"')).toBe(1);
  });
});

describe("[SF-WEB-31 follow-up] landing drops explanatory prose for a logo mark", () => {
  it("has no instructional subtitle paragraph on the landing hero", () => {
    expect(html).not.toContain("Search an artist to map who they've made songs with");
  });

  it("trims the auth hint down to the sign-in action, dropping the trailing explanatory clause", () => {
    expect(html).not.toContain("account to start exploring");
    expect(html).toContain(">Sign in with<");
    expect(html).toContain('href="/auth/yandex/login"');
  });
});

describe("[SF-WEB-31 follow-up 2] landing wordmark replaces the eyebrow+slogan", () => {
  it("has no separate eyebrow tag or dot-mark icon", () => {
    expect(html).not.toContain('class="eyebrow"');
    expect(html).not.toContain('class="hero-logo"');
  });

  it("has no leftover slogan copy", () => {
    expect(html).not.toContain("Trace the people behind the");
    expect(html).not.toContain("genius collaboration atlas");
  });

  it("shows the service name as the h1, in the same gradient treatment the slogan used", () => {
    expect(html).toContain('<h1><span class="grad">Six Feet</span></h1>');
  });
});

describe("[SF-WEB-50] landing folded into Observatory", () => {
  it("pairs the wordmark with exactly one short thesis line, not a return to the old explanatory paragraph", () => {
    expect(html).toContain('<div class="hero-header">');
    expect(html).toMatch(/<p class="hero-tagline"[^>]*>[^<]{1,60}<\/p>/);
    expect(html).not.toContain("Search an artist to map who they've made songs with");
    expect(html).not.toContain("Trace the people behind the");
  });

  it("keeps every landing entry point present: search field, Explore/Connect switch, role filters, chips, auth", () => {
    expect(html).toContain('id="hero-input"');
    expect(html).toContain('id="hero-mode-switch"');
    expect(html).toContain('id="hero-mode-tab-explore"');
    expect(html).toContain('id="hero-mode-tab-connect"');
    expect(html).toContain('id="hero-filter-featured"');
    expect(html).toContain('id="hero-filter-producer"');
    expect(html).toContain('id="hero-filter-writer"');
    expect(html).toContain('id="chips"');
    expect(html).toContain('id="auth-bar"');
  });

  it("still renders the dandelion/starfield decorator mount behind the landing", () => {
    expect(html).toContain('id="canvas-decorator"');
    expect(html.indexOf('id="canvas-decorator"')).toBeLessThan(html.indexOf('id="search-modal"'));
  });
});
