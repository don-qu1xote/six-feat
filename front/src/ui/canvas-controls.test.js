// ════════════════════════════════════════════════════════════════════════════
// ui/canvas-controls.test.js — SF-WEB-05: updateScanStatus reflects the
//                                inline data-completeness indicator through a
//                                sequence of mock /api/v1/status/stream
//                                events (partial → background scan → full).
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach } from "vitest";
import { els } from "../dom/dom.js";
import { updateScanStatus } from "./canvas-controls.js";

beforeEach(() => {
  els.scanStatusBadge = document.createElement("span");
  els.scanStatusBadge.hidden = true;
  els.scanStatusText  = document.createElement("span");
  els.scanStatusBadge.appendChild(els.scanStatusText);
});

describe("updateScanStatus", () => {
  it("shows a 'Partial' badge when depth is Foreground and no background scan is running", () => {
    updateScanStatus({ depth: 1, song_count: 12, enriching: false });

    expect(els.scanStatusBadge.hidden).toBe(false);
    expect(els.scanStatusText.textContent).toBe("Partial");
    expect(els.scanStatusBadge.classList.contains("scan-status-badge--enriching")).toBe(false);
  });

  it("shows a 'Scanning…' badge while background enrichment is running", () => {
    updateScanStatus({ depth: 1, song_count: 12, enriching: true });

    expect(els.scanStatusBadge.hidden).toBe(false);
    expect(els.scanStatusText.textContent).toBe("Scanning…");
    expect(els.scanStatusBadge.classList.contains("scan-status-badge--enriching")).toBe(true);
  });

  it("hides the badge once depth reaches Full (2) — data is complete", () => {
    updateScanStatus({ depth: 1, song_count: 12, enriching: true });
    expect(els.scanStatusBadge.hidden).toBe(false);

    updateScanStatus({ depth: 2, song_count: 40, enriching: false });
    expect(els.scanStatusBadge.hidden).toBe(true);
  });

  it("reflects a full partial→scanning→full event sequence", () => {
    const events = [
      { depth: 1, song_count: 10, enriching: false },
      { depth: 1, song_count: 10, enriching: true },
      { depth: 1, song_count: 25, enriching: true },
      { depth: 2, song_count: 40, enriching: false },
    ];
    const observed = events.map(e => {
      updateScanStatus(e);
      return els.scanStatusBadge.hidden ? "hidden" : els.scanStatusText.textContent;
    });
    expect(observed).toEqual(["Partial", "Scanning…", "Scanning…", "hidden"]);
  });

  it("is a no-op when the badge element isn't present on the page", () => {
    els.scanStatusBadge = null;
    expect(() => updateScanStatus({ depth: 1, enriching: true })).not.toThrow();
  });
});
