import { pinnedReporters } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

/**
 * `test:dist-token-surface` only. The suite scans `apps/desktop/dist`, which
 * `vitest.node.config.ts`'s lanes never build, so the census excludes it
 * (`EXCLUDED_TEST_FILES`) and `desktop-build` runs it after `Build desktop`.
 */
export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    environment: "node",
    include: ["test/no-token-surface-dist.test.ts"],
  },
});
