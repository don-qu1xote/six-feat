import { test, expect } from "@playwright/test";

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
