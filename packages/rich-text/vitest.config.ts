import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const directoryName = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@repo/design-system": resolve(directoryName, "../design-system"),
    },
  },
  test: {
    globals: true,
    environment: "node",
  },
});
