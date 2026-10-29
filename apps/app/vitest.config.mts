import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
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
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    envPrefix: "NEXT_PUBLIC_",
    // Vitest's default include matches `*.spec.ts`, which would collect the
    // Playwright end-to-end specs under `e2e/` and crash on `test.describe()`
    // ("Playwright Test did not expect test.describe() to be called here").
    // Those run under `playwright test` in the e2e job, not vitest — exclude
    // the directory here while preserving vitest's default excludes.
    //
    // DO NOT ADD AN `include` HERE (ISS-10196). Its ABSENCE is load-bearing:
    // vitest's default include is the only thing that collects
    // `__tests__/compatibility/**`, so those suites run on this lane and
    // nowhere else. `apps/app`'s `test:compatibility` script reaches no CI lane
    // by name — it is an alias for running them alone — so narrowing this to an
    // explicit include would silently stop running them, with every coverage
    // gate still green. That is exactly ISS-10184, where `apps/api`'s
    // compatibility tier sat unexecuted and accumulated 9 failures. If you need
    // an include, wire `test:compatibility` into a lane in the SAME change and
    // delete this package's TIER_EXEMPTIONS entry in
    // scripts/lint/test-tier-reachability.ts.
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
      "@repo/cost": path.resolve(
        import.meta.dirname,
        "../../packages/cost/src"
      ),
      "@repo/document-schema": path.resolve(
        import.meta.dirname,
        "../../packages/document-schema/src"
      ),
      "@repo/design-system": path.resolve(
        import.meta.dirname,
        "../../packages/design-system"
      ),
      "@closedloop-ai/design-system": path.resolve(
        import.meta.dirname,
        "../../packages/design-system"
      ),
      "@repo/loops-api": path.resolve(
        import.meta.dirname,
        "../../packages/loops-api/src"
      ),
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../../packages/loops-api/src"
      ),
      "@repo/realtime-contract": path.resolve(
        import.meta.dirname,
        "../../packages/realtime-contract/src"
      ),
      "@repo/realtime-client": path.resolve(
        import.meta.dirname,
        "../../packages/realtime-client/src"
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
        "../../packages/typescript-config/vitest-server-only-stub.ts"
      ),
      // Mock @clerk/nextjs — not resolvable in jsdom test environment.
      // SUBPATHS FIRST: the bare key below is a prefix alias, so a subpath left
      // unlisted rewrites into the bare mock's path and fails to resolve.
      "@clerk/nextjs/errors": path.resolve(
        import.meta.dirname,
        "./vitest-mocks/clerk-nextjs-errors.ts"
      ),
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
