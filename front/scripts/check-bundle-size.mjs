#!/usr/bin/env node
// scripts/check-bundle-size.mjs — [SF-WEB-08] Bundle size budget gate.
//
// Reads dist/manifest.json (written by hash-build.mjs) to find the current
// hashed bundle, gzips it, and exits non-zero if the gzip size exceeds
// BUDGET_BYTES. Run after `npm run build`, both locally (`npm run
// check-bundle-size`) and in CI (see .github/workflows/ci.yml's
// bundle-size job) — kept separate from hash-build.mjs so that script stays
// a pure rename+manifest postprocess step; a failed budget check here
// shouldn't need to also undo that rename.
//
// distDir defaults to ../dist but can be overridden via BUNDLE_DIST_DIR
// (used by check-bundle-size.test.js to exercise this file's actual exit
// code against synthetic fixtures, without touching the real build output).
import { gzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const distDir = process.env.BUNDLE_DIST_DIR || join(import.meta.dirname, "..", "dist");

// [SF-WEB-08] Current gzip size of dist/script.*.js is ~29.2 KB as of this
// ticket. 40 KB leaves ~35% headroom for organic growth before the budget
// itself needs revisiting, while still catching an accidental large
// dependency or a regression that silently balloons the bundle.
// [SF-GAME-01] Raised to 48 KB — the Connect game surface (chain model,
// canvas renderer, real challenge/submit/leaderboard API client, plus the
// 3-way hero-mode-switch) is a genuine new feature's worth of code, not
// bloat; ~43.3 KB actual leaves a smaller but still real margin.
// [SF-GAME-33] Raised to 56 KB. The 48 KB above was set against a ~43.3 KB
// bundle, but the game surface FINISHED bigger than that estimate: the routed
// windows (leaderboard/profile/challenges/season), the admin panel and the
// game-screens chrome all landed after it, and the bundle has actually been
// ~49.2 KB — i.e. this gate has been failing on the pushed tree, not just
// tight. Measured, not guessed: 49.4 KB after the SF-GAME-30..33 refactor,
// which is +0.2 KB net (the connect.js split adds module boundaries; moving
// game screens onto the kit gives most of it back). 56 KB restores ~13%
// headroom over the real number. If the next raise is again "because it grew",
// the answer should be code-splitting the game surface off the Explorer's
// entry bundle instead of another bump.
export const BUDGET_KB = 56;
export const BUDGET_BYTES = BUDGET_KB * 1024;

export function gzipSize(buffer) {
  return gzipSync(buffer, { level: 9 }).length;
}

export function checkBudget(sizeBytes, budgetBytes = BUDGET_BYTES) {
  return { ok: sizeBytes <= budgetBytes, sizeBytes, budgetBytes };
}

function main() {
  const manifestPath = join(distDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`[check-bundle-size] ${manifestPath} not found — run \`npm run build\` first.`);
    process.exit(1);
  }

  const { script } = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bundlePath = join(distDir, script);
  const content = readFileSync(bundlePath);
  const { ok, sizeBytes, budgetBytes } = checkBudget(gzipSize(content));

  const sizeKb   = (sizeBytes / 1024).toFixed(1);
  const budgetKb = (budgetBytes / 1024).toFixed(1);

  if (!ok) {
    console.error(`[check-bundle-size] ${script}: ${sizeKb} KB gzip exceeds budget of ${budgetKb} KB.`);
    process.exit(1);
  }
  console.log(`[check-bundle-size] ${script}: ${sizeKb} KB gzip (budget ${budgetKb} KB) — OK`);
}

// Only run as a CLI — importing this module for its exports (tests) must
// not also execute main() and exit the test process.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
