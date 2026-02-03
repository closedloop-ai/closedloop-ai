import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "server-only": path.resolve(
        import.meta.dirname,
        "../../apps/app/vitest-mocks/server-only.ts"
      ),
    },
  },
});
