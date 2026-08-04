import { test, expect } from "@playwright/test";

// [SF-WEB-75] Settings used to live only inside .rail, which is
// display:none on the landing page and visually covered by every game
// screen's full-bleed surface (same z-index, later in DOM order — see
// canvas-controls.css). #btn-settings-open now sits outside .rail at
// z-docked so it's reachable everywhere; .click()'s actionability check
// fails if another element intercepts the click point, which is the real
// regression this guards against (a plain `toBeVisible()` wouldn't catch
// an opaque sibling painted on top).
const SURFACES = [
  ["landing", "/"],
  ["graph", "/#/graph"],
  ["game/play", "/#/game"],
  ["game/challenges", "/#/game/challenges"],
  ["game/leaderboard", "/#/game/leaderboard"],
  ["game/season", "/#/game/season"],
  ["game/profile (Cabinet)", "/#/game/profile"],
];

for (const [label, path] of SURFACES) {
  test(`Settings is reachable and opens from ${label}`, async ({ page }) => {
    await page.goto(path);

    await page.locator("#btn-settings-open").click();

    await expect(page.locator("#settings-panel")).toHaveClass(/show/);
  });
}
