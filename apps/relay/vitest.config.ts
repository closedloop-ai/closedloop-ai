import {
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    // Vitest 5 defaults clearMocks to true. The gateway suites import the
    // server once in beforeAll and read its `connection` registration from
    // the socket.io mock's call history in every test (gateway-harness.ts).
    clearMocks: false,
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
