import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dirname, "..", "dist");

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
  const ext = file.slice(dot);

  const content = readFileSync(srcPath);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
  const hashedName = `${base}.${hash}${ext}`;

  renameSync(srcPath, join(distDir, hashedName));
  manifest[key] = hashedName;
  console.log(`[hash-build] ${hashedName} (sha256:${hash})`);
}

writeFileSync(join(distDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
