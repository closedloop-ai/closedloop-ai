import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      // `@closedloop-ai/loops-api` and `@repo/shared-platform` are source-consumed under
      // a `/src` root, so their specific aliases MUST precede the catch-all
      // `@repo` (Vite matches aliases in declaration order). Reachable
      // transitively via `@repo/api`'s type modules, which re-export from both.
      "@closedloop-ai/loops-api": path.resolve(__dirname, "../loops-api/src"),
      "@repo/shared-platform": path.resolve(
        __dirname,
        "../shared-platform/src"
      ),
      "@repo": path.resolve(__dirname, "../"),
      "server-only": path.resolve(
        __dirname,
        "../../apps/app/vitest-mocks/server-only.ts"
      ),
    },
  },
});
