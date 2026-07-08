import js from "@eslint/js";
import globals from "globals";

// Minimal, non-opinionated baseline: eslint:recommended only, so this can be
// turned on today without forcing a stylistic rewrite of the existing
// codebase. Tighten (add plugins/rules) incrementally later.
//
// Two deviations from bare eslint:recommended, both because they'd otherwise
// flag long-standing, intentional patterns already used throughout src/ —
// not because the underlying rules are wrong in general:
//   - no-empty: allowEmptyCatch — `try { ... } catch (_) {}` is used
//     deliberately across the codebase to swallow non-critical parse/DOM
//     errors (e.g. api.js's `try { body = await res.json(); } catch (_) {}`).
//   - no-unused-vars: caughtErrorsIgnorePattern "^_" — same pattern's `_`
//     catch binding is otherwise flagged as unused.
export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.es2021,
        // vis-network is loaded as a UMD <script> global in index.html
        // (unpkg.com/vis-network .../standalone/umd/vis-network.min.js),
        // not imported as a module — see vis-adapter/render.js.
        vis: "readonly",
      },
    },
    rules: {
      // Keep this warning-level so first-run CI doesn't fail on existing
      // debug/logging statements; tighten to "error" once cleaned up.
      "no-console": "off",
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/**/*.test.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
];
