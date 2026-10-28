import path from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedReporters, resolveLaneWorkers } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "server-only": path.resolve(
        __dirname,
        "../typescript-config/vitest-server-only-stub.ts"
      ),
    },
  },
});
