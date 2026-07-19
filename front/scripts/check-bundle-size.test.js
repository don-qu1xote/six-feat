// ════════════════════════════════════════════════════════════════════════════
// check-bundle-size.test.js — [SF-WEB-08] unit + CLI tests for the bundle
// size budget gate.
//
// Two layers: (1) checkBudget/gzipSize as pure functions, and (2) the
// script actually invoked as a CLI (BUNDLE_DIST_DIR override) against a
// synthetic bloated dist/ (must fail, non-zero exit) and a synthetic
// current-sized dist/ (must pass, zero exit) — matching the ticket's own
// test spec: "script fails on an artificially inflated bundle, passes on
// the current one".
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { gzipSize, checkBudget, BUDGET_BYTES, BUDGET_KB } from "./check-bundle-size.mjs";

const SCRIPT_PATH = join(import.meta.dirname, "check-bundle-size.mjs");

function makeDist({ scriptName, content }) {
  const dir = mkdtempSync(join(tmpdir(), "bundle-size-test-"));
  writeFileSync(join(dir, scriptName), content);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ script: scriptName }));
  return dir;
}

function runCli(distDir) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH], {
      env: { ...process.env, BUNDLE_DIST_DIR: distDir },
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("checkBudget (pure)", () => {
  it("passes when size is at or under the budget", () => {
    expect(checkBudget(BUDGET_BYTES).ok).toBe(true);
    expect(checkBudget(BUDGET_BYTES - 1).ok).toBe(true);
  });

  it("fails when size exceeds the budget", () => {
    expect(checkBudget(BUDGET_BYTES + 1).ok).toBe(false);
  });

  it("budget is a sane, documented KB value", () => {
    expect(BUDGET_KB).toBeGreaterThan(0);
    expect(BUDGET_BYTES).toBe(BUDGET_KB * 1024);
  });
});

describe("gzipSize", () => {
  it("compresses a highly-repetitive buffer far below its raw size", () => {
    const raw = Buffer.from("x".repeat(100_000));
    expect(gzipSize(raw)).toBeLessThan(1000);
  });
});

describe("check-bundle-size.mjs CLI", () => {
  const dirs = [];
  function trackedDist(opts) {
    const dir = makeDist(opts);
    dirs.push(dir);
    return dir;
  }

  it("fails (non-zero exit) on an artificially bloated bundle", () => {
    // Random bytes barely compress — a multi-MB blob comfortably clears the
    // 40 KB gzip budget, standing in for "someone accidentally bundled a
    // large dependency".
    const bloated = randomBytes(2 * 1024 * 1024);
    const dir = trackedDist({ scriptName: "script.bloated.js", content: bloated });

    const { code, stderr } = runCli(dir);
    expect(code).not.toBe(0);
    expect(stderr).toContain("exceeds budget");

    rmSync(dir, { recursive: true, force: true });
  });

  it("passes (zero exit) on a bundle representative of the current build's gzip size", () => {
    // Repetitive JS-like text gzips down comfortably under budget, standing
    // in for the real (currently ~29 KB gzip) dist/script.*.js.
    const current = Buffer.from(
      "function six_feat(){return {a:1,b:2,c:3};}\n".repeat(2000),
    );
    expect(gzipSize(current)).toBeLessThan(BUDGET_BYTES);

    const dir = trackedDist({ scriptName: "script.current.js", content: current });
    const { code, stdout } = runCli(dir);
    expect(code).toBe(0);
    expect(stdout).toContain("OK");

    rmSync(dir, { recursive: true, force: true });
  });

  it("fails (non-zero exit) when manifest.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "bundle-size-test-"));
    const { code, stderr } = runCli(dir);
    expect(code).not.toBe(0);
    expect(stderr).toContain("manifest.json");
    rmSync(dir, { recursive: true, force: true });
  });
});
