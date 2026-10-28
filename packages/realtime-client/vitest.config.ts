import { pinnedReporters, resolveLaneWorkers } from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // ISS-11211 AC 6: the SDK passes its suites under Node, which is how the
    // desktop main process hosts it.
    environment: "node",
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
  },
});
