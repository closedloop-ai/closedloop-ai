import path from "node:path";
import { defineConfig } from "vitest/config";
import { sharedPlatformAliases } from "./vitest-shared-aliases";

export default defineConfig({
  test: {
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
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../../packages/loops-api/src"
      ),
      "@repo": path.resolve(import.meta.dirname, "../../packages"),
    },
  },
});
