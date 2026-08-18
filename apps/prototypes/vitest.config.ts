import path from "node:path";
import { defineConfig } from "vitest/config";

// Prototypes are presentational and their logic is mostly eye-checkable, so the
// default here is still node-environment `.test.ts` (pure model/reducer tests),
// kept dependency-light. A `.test.tsx` file opts INTO jsdom + testing-library
// per-file with `// @vitest-environment jsdom` — used for a flow whose wiring
// (a timer, a save control, a phase transition) can't be proven by a pure
// reducer test. The dom polyfills below only apply when a jsdom file runs; the
// catalog-imports gate still runs first via the test script.
export default defineConfig({
  // Mirrors the `@/*` path mapping in tsconfig.json so a test can reach shared
  // sandbox modules (`@/lib/...`) the same way the pages do.
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      // Resolve @repo/design-system subpaths (e.g. `/lib/utils`) to source so a
      // jsdom `.test.tsx` can render real catalog components — vite can't follow
      // the package's own subpath specifiers without this (mirrors the desktop
      // renderer vitest config).
      "@repo/design-system": path.resolve(
        import.meta.dirname,
        "../../packages/design-system"
      ),
    },
  },
  esbuild: {
    // The sandbox tsconfig uses the automatic JSX runtime; match it so `.test.tsx`
    // files transform without importing React.
    jsx: "automatic",
  },
  test: {
    // globals also enables @testing-library/react auto-cleanup between tests.
    globals: true,
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**"],
    // Guarded jsdom polyfills (see the setup file); no-ops under node.
    setupFiles: ["./vitest.setup.dom.ts"],
  },
});
