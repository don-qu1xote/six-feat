// playwright.config.js — IDEA-33 E2E smoke test config.
//
// Points at an already-running six_feat instance (real binary + real built
// front-end + mock Genius server) started by scripts/e2e_env.py — this repo
// has no "spin up the whole stack" webServer option because the stack is a
// compiled C++ binary + Postgres + a Python mock server, not something
// `npm run dev` can start on its own. See front/e2e/global-setup.js for how
// the pre-started environment's session cookie gets into the browser
// context, and .github/workflows/ci.yml's e2e-smoke job / README for how to
// run this locally.
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://127.0.0.1:18180";
const storageStatePath = process.env.E2E_STORAGE_STATE || ".e2e-storage-state.json";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.js",
  use: {
    baseURL,
    storageState: storageStatePath,
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
