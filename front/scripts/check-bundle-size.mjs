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
export const BUDGET_KB = 40;
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
