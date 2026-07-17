// ════════════════════════════════════════════════════════════════════════════
// canvas-declutter.test.js — [SF-WEB-14] asserts index.html itself has no
//                             duplicate global buttons for the four
//                             mini-actions (expand/focus/genius/pin) or for
//                             fit-view/role-filters, which moved into the
//                             new canvas-zoom-cluster/role-filter-segment.
//
// This reads the real index.html as text rather than mocking DOM state —
// unlike sidebar.js's own tests (which assign detached elements straight to
// els.*, bypassing the markup entirely), "no duplicate button exists in the
// page" is a statement about the markup itself, not about sidebar.js's
// logic, so it needs the actual file.
// ════════════════════════════════════════════════════════════════════════════
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
    // These three ids only exist inside .object-action-bar. [SF-WEB-47]
    // The fourth (pin) is gone entirely — it only existed to gate
    // Compare's old pinned-pair selection.
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
    const actionBarIdx      = html.indexOf('id="object-action-bar"');
    expect(companionPanelIdx).toBeGreaterThan(-1);
    expect(actionBarIdx).toBeGreaterThan(companionPanelIdx);
  });

  it("renders exactly one action row containing Genius for node context", () => {
    expect(countOccurrences(html, 'id="object-action-bar"')).toBe(1);
    expect(countOccurrences(html, 'id="obj-action-genius"')).toBe(1);
    // The single object-action-bar block must be the one containing it.
    // Genius is the last of the three buttons (see [SF-WEB-47] above — the
    // old fourth button, pin, is gone), so anchor the block's end there.
    const barStart = html.indexOf('id="object-action-bar"');
    const barEnd    = html.indexOf("</div>", html.indexOf('id="obj-action-genius"'));
    const barBlock  = html.slice(barStart, barEnd);
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
    expect(html).toContain('href="/auth/login"');
  });
});

// [SF-WEB-31 follow-up 2] Google/Yandex reference: one wordmark, no
// separate eyebrow tag or slogan — the service name itself, same font/size
// the old three-line slogan used, is the whole landing logo.
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