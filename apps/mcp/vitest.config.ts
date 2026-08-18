import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // ISS-5294: many suites here `await import("../index.js")` to reach a
    // handler, and index.ts is ~3,800 lines — its COLD Vite transform costs
    // ~4-5s. Under a full `turbo test` the workers contend and that transform
    // alone crosses vitest's 5s default, so the assertion never runs. The
    // failure is transform cost, not the code under test, and it predates this
    // ticket (`shutdown-flush.test.ts` fails this way on main). AGENTS.md
    // requires an explicit timeout rather than relying on the default; 30s
    // still catches a genuine hang, since a warm re-import is ~100-200ms.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../api"),
      "@repo/cost": path.resolve(
        import.meta.dirname,
        "../../packages/cost/src"
      ),
      "@closedloop-ai/loops-api": path.resolve(
        import.meta.dirname,
        "../../packages/loops-api/src"
      ),
    },
  },
});
