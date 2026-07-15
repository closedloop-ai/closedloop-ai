import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import { sharedPlatformAliases } from "./vitest-shared-aliases";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const appRoot = path.resolve(__dirname, "./");

/**
 * Vite plugin: resolve `@/` bare specifiers inside Next.js dynamic-segment
 * route files (paths containing `[`). These files are resolved via absolute
 * path, so Vite's normal alias substitution would not fire for their imports.
 * We intercept them here and rewrite `@/foo` → `<appRoot>/foo`.
 */
function bracketRouteAliasPlugin(): Plugin {
  return {
    name: "bracket-route-alias",
    resolveId(source, importer) {
      if (!importer?.includes("[")) {
        return null;
      }
      if (!source.startsWith("@/")) {
        return null;
      }
      const resolved = path.resolve(appRoot, source.slice(2));
      return resolved;
    },
  };
}

export default defineConfig({
  plugins: [react(), bracketRouteAliasPlugin()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    envPrefix: "NEXT_PUBLIC_",
    // Vitest's default include matches `*.spec.ts`, which would collect the
    // Playwright end-to-end specs under `e2e/` and crash on `test.describe()`
    // ("Playwright Test did not expect test.describe() to be called here").
    // Those run under `playwright test` in the e2e job, not vitest — exclude
    // the directory here while preserving vitest's default excludes.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./"),
      // shared-platform and loops-api subpath aliases must precede the catch-all
      // `@repo`: these packages are source-consumed (resolve to `.../src/*`), so
      // the generic `@repo` → `packages` mapping would drop the `/src` and fail.
      // Vite matches aliases in declaration order.
      ...sharedPlatformAliases,
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../../packages/loops-api/src"
      ),
      "@repo": path.resolve(import.meta.dirname, "../../packages"),
      // Mock heavy/browser-dependent editor dependencies at the bundler level
      // so they never load sandpack/stitches/CSSOM in jsdom
      "@mdxeditor/editor/style.css": path.resolve(
        import.meta.dirname,
        "./__tests__/__mocks__/mdxeditor-style.ts"
      ),
      "@mdxeditor/editor": path.resolve(
        import.meta.dirname,
        "./__tests__/__mocks__/mdxeditor.ts"
      ),
      "@lexical/rich-text": path.resolve(
        import.meta.dirname,
        "./__tests__/__mocks__/lexical-rich-text.ts"
      ),
      "@lexical/list": path.resolve(
        import.meta.dirname,
        "./__tests__/__mocks__/lexical-list.ts"
      ),
      lexical: path.resolve(
        import.meta.dirname,
        "./__tests__/__mocks__/lexical.ts"
      ),
      "server-only": path.resolve(
        import.meta.dirname,
        "./vitest-mocks/server-only.ts"
      ),
      // Mock @clerk/nextjs — not resolvable in jsdom test environment
      "@clerk/nextjs/server": path.resolve(
        import.meta.dirname,
        "./vitest-mocks/clerk-nextjs-server.ts"
      ),
      "@clerk/nextjs": path.resolve(
        import.meta.dirname,
        "./vitest-mocks/clerk-nextjs.ts"
      ),
      "@posthog/next": path.resolve(
        import.meta.dirname,
        "./vitest-mocks/posthog-next.tsx"
      ),
    },
  },
});
