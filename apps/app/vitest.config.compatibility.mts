import path from "node:path";
import { pinnedReporters } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";
import { sharedPlatformAliases } from "./vitest-shared-aliases";

export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    environment: "jsdom",
    globals: true,
    include: ["__tests__/compatibility/**/*.test.ts"],
    testTimeout: 15_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./"),
      // shared-platform + loops-api subpath aliases must precede the catch-all
      // `@repo`: both are source-consumed (resolve to `.../src/*`), so the
      // generic `@repo` → `packages` mapping would drop the `/src` and fail.
      ...sharedPlatformAliases,
      "@repo/cost": path.resolve(
        import.meta.dirname,
        "../../packages/cost/src"
      ),
      "@repo/document-schema": path.resolve(
        import.meta.dirname,
        "../../packages/document-schema/src"
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
      "@repo": path.resolve(import.meta.dirname, "../../packages"),
    },
  },
});
