// hash-build.mjs — postprocess esbuild's dist/ bundles:
//   1. computes sha256 of each bundled asset (script.js, style.css)
//   2. renames each to <name>.<hash8>.<ext>
//   3. writes dist/manifest.json: { "script": "...", "style": "..." }
//
// Kept as a separate, framework-free Node script (no extra deps) so it runs
// identically in local dev (`npm run build`) and in the Docker js-builder
// stage.
//
// [SF-WEB-40] Extended to also hash dist/style.css (the bundled design
// system, src/styles/index.css → esbuild). Same content-addressing scheme
// as the JS bundle, so a changed stylesheet gets a new URL and is picked up
// on a normal refresh (index.html references /style.css, rewritten to the
// hashed URL by handler-index, exactly like /script.js).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dirname, "..", "dist");

// Each entry: manifest key + the un-hashed filename esbuild emits into dist/.
const assets = [
  { key: "script", file: "script.js" },
  { key: "style", file: "style.css" },
];

const manifest = {};

for (const { key, file } of assets) {
  const srcPath = join(distDir, file);
  if (!existsSync(srcPath)) {
    console.error(`[hash-build] expected ${file} in dist/ — did the build step run?`);
    process.exit(1);
  }
  const dot = file.lastIndexOf(".");
  const base = file.slice(0, dot);
  const ext = file.slice(dot); // includes the leading "."

  const content = readFileSync(srcPath);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
  const hashedName = `${base}.${hash}${ext}`;

  renameSync(srcPath, join(distDir, hashedName));
  manifest[key] = hashedName;
  console.log(`[hash-build] ${hashedName} (sha256:${hash})`);
}

writeFileSync(join(distDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
