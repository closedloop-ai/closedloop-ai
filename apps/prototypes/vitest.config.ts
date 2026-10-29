import {
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

// Prototype code carries no tests (apps/prototypes/AGENTS.md). What runs here
// is the sandbox's own Node tooling under `scripts/` (the Vercel ignore
// command, the hosted-Storybook copy, the Style Lab export/apply boundary).
export default defineConfig({
  test: {
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
    include: ["scripts/**/*.test.mjs"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
