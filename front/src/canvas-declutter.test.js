// ════════════════════════════════════════════════════════════════════════════
// canvas-declutter.test.js — [SF-WEB-14] asserts index.html itself has no
//                             duplicate global buttons for the four
//                             mini-actions (expand/focus/genius/pin) or for
//                             fit-view, which moved into the new
//                             canvas-zoom-cluster. [SF-WEB-21] extends this
//                             to the command-palette pass: the rail's
//                             search/find-path/copy-link/export/clear
//                             buttons, the standalone theme-toggle, and the
//                             status row's help button are all gone too —
//                             those actions are ⌘K command-palette rows now
//                             (see ui/modals.js::_commands), not permanent
//                             canvas chrome. [SF-WEB-22] restores
//                             .role-filter-segment — SF-WEB-21 turning it
//                             into palette-only rows undid a deliberate
//                             SF-WEB-14 decision (role filters stay primary/
//                             always-visible on the canvas); the palette's
//                             own filter rows stay too, both read/write the
//                             same State.activeFilters.
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
  it("has no separate rail buttons for the four object-action-bar actions", () => {
    // These four ids only exist inside .object-action-bar.
    expect(countOccurrences(html, 'id="obj-action-expand"')).toBe(1);
    expect(countOccurrences(html, 'id="obj-action-focus"')).toBe(1);
    expect(countOccurrences(html, 'id="obj-action-genius"')).toBe(1);
    expect(countOccurrences(html, 'id="obj-action-pin"')).toBe(1);
  });

  it("has exactly one #btn-fit-view — moved into the zoom cluster, not duplicated", () => {
    expect(countOccurrences(html, 'id="btn-fit-view"')).toBe(1);
  });

  it("still has the zoom-in/zoom-out/focus-seed buttons the cluster reuses fitView/zoomIn/zoomOut/focusSeed with", () => {
    expect(countOccurrences(html, 'id="btn-zoom-in"')).toBe(1);
    expect(countOccurrences(html, 'id="btn-zoom-out"')).toBe(1);
    expect(countOccurrences(html, 'id="btn-focus-seed"')).toBe(1);
  });
});

describe("[SF-WEB-21] command palette replaces the rail's scattered buttons + theme-toggle + help-btn", () => {
  it("has no rail buttons left for search/find-on-map/find-path/copy-link/export/clear", () => {
    expect(html).not.toContain('id="btn-search-open"');
    expect(html).not.toContain('id="btn-node-search"');
    expect(html).not.toContain('id="btn-find-path"');
    expect(html).not.toContain('id="btn-copy-link"');
    expect(html).not.toContain('id="btn-export-png"');
    expect(html).not.toContain('id="btn-clear-graph"');
  });

  it("has no standalone theme-toggle button", () => {
    expect(html).not.toContain('id="theme-toggle"');
  });

  it("has no standalone help-btn — Keyboard shortcuts is a palette row now", () => {
    expect(html).not.toContain('id="help-btn"');
  });

  it("[SF-WEB-22] has exactly one canvas role-filter-segment — restored after SF-WEB-21 wrongly removed it", () => {
    expect(countOccurrences(html, 'id="role-filter-segment"')).toBe(1);
    expect(countOccurrences(html, 'id="canvas-filter-featured"')).toBe(1);
    expect(countOccurrences(html, 'id="canvas-filter-producer"')).toBe(1);
    expect(countOccurrences(html, 'id="canvas-filter-writer"')).toBe(1);
    // The hero's own toggle buttons (visible before a graph even exists)
    // are a different, still-live feature — a second, legitimate entry
    // point into the same State.activeFilters, not a duplicate of the
    // canvas segment.
    expect(countOccurrences(html, 'id="hero-filter-featured"')).toBe(1);
    expect(countOccurrences(html, 'id="hero-filter-producer"')).toBe(1);
    expect(countOccurrences(html, 'id="hero-filter-writer"')).toBe(1);
  });

  it("has exactly one command palette (#node-search-overlay), the app's single ⌘K entry point", () => {
    expect(countOccurrences(html, 'id="node-search-overlay"')).toBe(1);
  });
});