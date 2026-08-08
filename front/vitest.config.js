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

      // Норма — 80% по всем четырём метрикам. Ветки идут впритык к порогу
      // (реально ~80.3%), потому что каждый `?.` и каждый `||`-дефолт на
      // необязательных DOM-узлах считается отдельной веткой: чтобы закрыть
      // такую, тест должен пройти и с элементом на странице, и без него.
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
