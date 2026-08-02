// front/e2e/smoke.spec.js — IDEA-33
//
// Minimal end-to-end smoke test for the flow that only ever got exercised
// manually: search an artist → graph renders → click a node → sidebar opens
// → search a path between two artists → hop-chain renders. Runs against a
// real compiled six_feat binary + real built front-end + mock Genius server
// (see scripts/e2e_env.py), authenticated via a storageState cookie minted
// in global-setup.js.
//
// The two artists (see scripts/e2e_env.py) share exactly one song, so the
// graph has exactly 2 nodes and the from/to path is a single hop.
import { test, expect } from "@playwright/test";

const SEED_ARTIST = process.env.E2E_SEED_ARTIST || "Aurora Vale";
const TARGET_ARTIST = process.env.E2E_TARGET_ARTIST || "Kessler Vane";

test("search artist → graph → node click → sidebar, then path search → hop-chain", async ({
  page,
}) => {
  // [SF-SEC-02] vis-network must be self-hosted (front/vendor/) — regression
  // test for the old CDN <script src="https://unpkg.com/..."> tag: if it
  // ever comes back, this fails instead of silently depending on unpkg.com
  // being reachable and byte-for-byte unchanged (see docs/DEVELOPMENT.md).
  const unpkgRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "unpkg.com") {
      unpkgRequests.push(request.url());
    }
  });

  await page.goto("/");

  // ── Page loads ──────────────────────────────────────────────────────────
  await expect(page.locator("#hero-input")).toBeVisible();

  // ── Search draws a graph (nodes appear) ─────────────────────────────────
  await page.locator("#hero-input").fill(SEED_ARTIST);
  await page.locator('#hero-form button[type="submit"]').click();

  const graphNodeButtons = page.locator("#graph-a11y-node-list button[data-node-id]");
  await expect(graphNodeButtons).toHaveCount(2);

  // vis-network has had its chance to load and draw the graph by now —
  // assert it never reached out to the old CDN.
  expect(unpkgRequests).toEqual([]);

  // ── Click a node → sidebar opens ────────────────────────────────────────
  // The canvas graph has no per-node DOM elements to click (vis.js draws it
  // on a <canvas>); #graph-a11y-node-list is the accessible DOM twin that
  // performs the exact same action as clicking the node on canvas (see
  // src/ui/graph-a11y-list.js's selectNode) — dispatching the click directly
  // sidesteps the list's sr-only clip-rect, which real pointer clicks can't
  // reliably target.
  await graphNodeButtons.first().dispatchEvent("click");

  await expect(page.locator("#artist-sidebar")).toHaveClass(/show/);
  await expect(page.locator("#sidebar-name")).not.toHaveText("—");

  // ── Path search between two artists shows a hop-chain ───────────────────
  // [SF-WEB-30] Docked search (#btn-search-open) now shows the Explore box
  // only — the Explore/Connect switch and #hero-mode-tab-connect are hidden
  // entirely once a graph exists (see .search-modal.docked CSS in
  // index.html), since #btn-find-path/#path-panel is the canonical
  // on-graph path-finder entry point now. #hero-path-from-input/
  // #hero-mode-tab-connect only remain reachable pre-graph, from the
  // full-screen landing modal.
  await page.locator("#btn-find-path").click();

  await page.locator("#path-from-input").fill(SEED_ARTIST);
  await page.locator("#path-to-input").fill(TARGET_ARTIST);
  await page.locator("#btn-run-path").click();

  const hopRows = page.locator("#hop-chain .hop-row");
  await expect(hopRows).toHaveCount(2);
  await expect(hopRows.first()).toContainText(SEED_ARTIST);
  await expect(hopRows.last()).toContainText(TARGET_ARTIST);
});
