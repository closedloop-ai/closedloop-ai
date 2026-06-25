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
      // shared-platform subpath aliases (must precede the catch-all @repo).
      ...sharedPlatformAliases,
      "@repo": path.resolve(import.meta.dirname, "../../packages"),
    },
  },
});
