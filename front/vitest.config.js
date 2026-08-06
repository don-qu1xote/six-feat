import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.js", "scripts/**/*.test.js"],
    setupFiles: ["./test-setup.js"],
    globals: false,

    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.js"],
      exclude: ["src/**/*.test.js"],

      thresholds: {
        lines: 35,
        statements: 35,
        functions: 20,
        branches: 60,
      },
    },
  },
});
