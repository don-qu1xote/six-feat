import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.js"],
    globals: false,
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
