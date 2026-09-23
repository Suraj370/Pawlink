import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

// A minimal, fast config — typescript-eslint's recommended rules (no
// type-aware linting, which would need a project reference per
// workspace and meaningfully slow CI down) plus nothing else. This is a
// correctness gate for CI (see .github/workflows/ci.yml), not a style
// enforcer: no Prettier, no import-order, no stylistic rules layered on
// top. See docs/architecture.md, "CI," for why this is deliberately kept
// small rather than a full lint/format pipeline retrofitted onto an
// already-large, already-consistent codebase.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/build/**",
      "**/*.tsbuildinfo",
      "apps/web/src/routeTree.gen.ts",
      "apps/api/drizzle/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase's own established Zod policy (see
      // docs/architecture.md) already handles unknown-field rejection at
      // the schema layer; an underscore-prefixed unused parameter (e.g.
      // an intentionally-unused destructured field) is a normal,
      // readable pattern here, not something worth failing CI over.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // React-specific rules only apply to the frontend workspace.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "warn",
    },
  },
  {
    // TanStack Router's file-based routing REQUIRES every route file to
    // export both a component and a non-component `Route` object — this
    // is the framework's own convention (createFileRoute(...)), not a
    // mistake, so the rule that otherwise legitimately flags "a file
    // exports something besides a component" is inapplicable to this
    // directory specifically.
    files: ["apps/web/src/routes/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
);
