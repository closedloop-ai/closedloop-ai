import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "http://localhost",
      },
    },
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      // Resolve workspace packages from source (same alias as apps/app's
      // vitest config): @repo/design-system's exports map points at dist/,
      // which is not built in CI test runs. FEA-1512 supersedes this.
      "@repo": path.resolve(import.meta.dirname, ".."),
    },
  },
});
