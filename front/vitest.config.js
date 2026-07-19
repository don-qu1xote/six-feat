import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.js", "scripts/**/*.test.js"],
    globals: false,
    // [deps] vitest 4 tightened restoreMocks: it restores spies but no longer
    // clears plain vi.fn() call history between tests (vitest 2 did). Several
    // suites assert call counts on module-level vi.fn() mocks and relied on
    // that implicit clearing, so make it explicit — clearMocks runs
    // .mockClear() before every test, isolating call history regardless of
    // vitest's version-specific restoreMocks semantics.
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.js"],
      exclude: ["src/**/*.test.js"],
      // Soft threshold to start with, just below current levels — ratchet
      // up as coverage improves. Guards against regressions, not a target.
      thresholds: {
        lines: 35,
        statements: 35,
        functions: 20,
        branches: 60,
      },
    },
  },
});
