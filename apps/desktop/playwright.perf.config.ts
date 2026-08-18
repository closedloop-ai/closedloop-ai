/**
 * ISS-4430 — Playwright config for the DESKTOP PROFILING WORKLOADS.
 *
 * These are RUNNERS, not tests. A workload spec drives the built Electron app
 * through a fixed route against a prepared dataset so a profiling run is
 * comparable week to week; its "assertions" exist to prove the capture pipeline
 * produced artifacts, not to gate a merge. Nothing in CI runs this config —
 * `pnpm test`, `turbo test`, and the desktop `test:node` runner never see these
 * files (see the exclusion note below).
 *
 * Run:
 *   just profile-desktop          # from the repo root, the supported entry point
 *   npx playwright test --config playwright.perf.config.ts \
 *     test/perf/sessions-workload.perf.ts    # from apps/desktop/
 *
 * Prerequisites (each spec fails fast with the exact remedy when unmet):
 *   - The app must be built: `pnpm -C apps/desktop build`
 *   - `CLOSEDLOOP_PROFILE_DIR` — absolute path to the run directory
 *   - `CLOSEDLOOP_DESKTOP_USER_DATA_DIR` — absolute path to a sandbox built by
 *     `node apps/desktop/scripts/perf-prepare-dataset.mjs`
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A profiling run is long by design: the import lane is bounded by the app's own
 * 30-minute boot-import watchdog, and the sessions lane walks eight steps over a
 * real (multi-thousand-row) population on a machine that is simultaneously
 * writing two CPU profiles. The 60s E2E default would kill the run mid-route and
 * destroy the artifacts, so the bound here is per-RUN generous; each spec then
 * narrows it to what that lane can actually justify via `test.setTimeout`.
 */
const PERF_TEST_TIMEOUT_MS = 45 * 60_000;

/**
 * Individual waits are deliberately slower than the E2E defaults: every step is
 * racing an app that is being profiled (the V8 sampler and the JSONL sinks both
 * cost real time) against a population far larger than any seeded fixture.
 */
const PERF_EXPECT_TIMEOUT_MS = 30_000;

export default defineConfig({
  // Scoped to `test/perf` and to `*.perf.ts`, which is what keeps these files
  // out of every other runner: the E2E config (`playwright.config.ts`) has
  // testDir `test/e2e` AND `testMatch: /.*\.spec\.ts/`, the root web config's
  // projects fall back to Playwright's default `**/*.@(spec|test).*` match, and
  // `scripts/run-node-tests.mjs` enumerates only top-level `test/*.test.ts`.
  // A `.perf.ts` file under `test/perf/` fails all three.
  testDir: path.join(__dirname, "test/perf"),
  timeout: PERF_TEST_TIMEOUT_MS,
  // Kept under the repo-root `.perf/` tree, which `.gitignore` refuses to track
  // — the same structural guarantee the dataset and run artifacts rely on. A
  // sibling `test-results-perf/` would be an untracked-but-committable path.
  outputDir: path.resolve(__dirname, "../../.perf/playwright-desktop"),
  // A profiling measurement is not retryable: a second attempt would append a
  // second run's marks to the same `workload-marks.jsonl` and silently double
  // the population every analyzer reads.
  retries: 0,
  // One app at a time. Two Electron instances would contend for CPU and each
  // would profile the other's noise.
  workers: 1,
  // `list` only. The HTML reporter's own write is measurable work at the end of
  // a run whose whole point is measuring work, and the report of record is
  // `.perf/runs/<stamp>-<lane>/report.md`, not Playwright's.
  reporter: [["list"]],
  expect: {
    timeout: PERF_EXPECT_TIMEOUT_MS,
  },
  // No `use.browserName` — Electron workloads launch the app themselves via
  // `launchDesktopApp` inside each spec.
  projects: [
    {
      name: "electron-perf",
      testMatch: /.*\.perf\.ts/,
    },
  ],
});
