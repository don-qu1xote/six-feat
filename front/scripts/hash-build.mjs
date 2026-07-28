// hash-build.mjs — постобработка esbuild dist/ бандлов:
//   1. вычисляет sha256 каждого собранного ресурса (script.js, style.css)
//   2. переименовывает каждый в <name>.<hash8>.<ext>
//   3. записывает dist/manifest.json: { "script": "...", "style": "..." }
//
// Выделен в отдельный, независимый от фреймворка Node-скрипт (без лишних
// зависимостей), чтобы работал одинаково в локальной разработке (`npm run
// build`) и в Docker js-builder stage.
//
// Также хеширует dist/style.css (дизайн-система, src/styles/index.css →
// esbuild). Та же схема content-addressing, что и у JS-бандла: при
// изменении стилей новый URL подхватывается при обычном обновлении
// (index.html ссылается на /style.css, переписанный handler-index).
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
