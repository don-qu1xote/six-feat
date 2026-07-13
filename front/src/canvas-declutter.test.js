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