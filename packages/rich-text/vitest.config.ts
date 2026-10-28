import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  automaticJsx,
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

const directoryName = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  oxc: automaticJsx(),
  resolve: {
    alias: {
      "@closedloop-ai/design-system": resolve(
        directoryName,
        "../design-system"
      ),
      "@repo/design-system": resolve(directoryName, "../design-system"),
    },
  },
  test: {
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
    globals: true,
    environment: "node",
  },
});
