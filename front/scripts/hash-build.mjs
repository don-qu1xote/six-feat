// hash-build.mjs — postprocess esbuild's dist/script.js:
//   1. computes sha256 of the bundled content
//   2. renames it to dist/script.<hash8>.js
//   3. writes dist/manifest.json: { "script": "script.<hash8>.js" }
//
// Kept as a separate, framework-free Node script (no extra deps) so it runs
// identically in local dev (`npm run build`) and in the Docker js-builder
// stage.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dirname, "..", "dist");
const srcPath = join(distDir, "script.js");

const content = readFileSync(srcPath);
const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
const hashedName = `script.${hash}.js`;
const hashedPath = join(distDir, hashedName);

renameSync(srcPath, hashedPath);

writeFileSync(
  join(distDir, "manifest.json"),
  JSON.stringify({ script: hashedName }, null, 2) + "\n",
);

console.log(`[hash-build] ${hashedName} (sha256:${hash})`);
