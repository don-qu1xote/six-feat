#!/usr/bin/env node

import { gzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const distDir = process.env.BUNDLE_DIST_DIR || join(import.meta.dirname, "..", "dist");






export const BUDGET_KB = 68;
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

  const sizeKb = (sizeBytes / 1024).toFixed(1);
  const budgetKb = (budgetBytes / 1024).toFixed(1);

  if (!ok) {
    console.error(
      `[check-bundle-size] ${script}: ${sizeKb} KB gzip exceeds budget of ${budgetKb} KB.`,
    );
    process.exit(1);
  }
  console.log(`[check-bundle-size] ${script}: ${sizeKb} KB gzip (budget ${budgetKb} KB) — OK`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
