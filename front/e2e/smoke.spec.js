import { test, expect } from "@playwright/test";

const SEED_ARTIST = process.env.E2E_SEED_ARTIST || "Aurora Vale";
const TARGET_ARTIST = process.env.E2E_TARGET_ARTIST || "Kessler Vane";

test("search artist → graph → node click → sidebar, then path search → hop-chain", async ({
  page,
}) => {
  const unpkgRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "unpkg.com") {
      unpkgRequests.push(request.url());
    }
  });

  await page.goto("/");

  await expect(page.locator("#hero-input")).toBeVisible();

  await page.locator("#hero-input").fill(SEED_ARTIST);
  await page.locator('#hero-form button[type="submit"]').click();

  const graphNodeButtons = page.locator("#graph-a11y-node-list button[data-node-id]");
  await expect(graphNodeButtons).toHaveCount(2);

  expect(unpkgRequests).toEqual([]);

  await graphNodeButtons.first().dispatchEvent("click");

  await expect(page.locator("#artist-sidebar")).toHaveClass(/show/);
  await expect(page.locator("#sidebar-name")).not.toHaveText("—");

  await page.locator("#btn-find-path").click();

  await page.locator("#path-from-input").fill(SEED_ARTIST);
  await page.locator("#path-to-input").fill(TARGET_ARTIST);
  await page.locator("#btn-run-path").click();

  const hopRows = page.locator("#hop-chain .hop-row");
  await expect(hopRows).toHaveCount(2);
  await expect(hopRows.first()).toContainText(SEED_ARTIST);
  await expect(hopRows.last()).toContainText(TARGET_ARTIST);
});
