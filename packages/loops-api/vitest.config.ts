import {
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

// ISS-6947: this package ran `vitest run` with no config at all, so an agent
// harness silenced it and no sweep over config FILES could see it. Reporters
// only — everything else stays on the Vitest defaults it already ran under.
export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
  },
});
