/**
 * Playwright configuration for Electron E2E tests.
 *
 * Uses the `electron` test project type — tests launch the built Electron app
 * via `_electron.launch` instead of driving a browser. The app must be built
 * (`pnpm build`) before running E2E tests because the test points at the
 * compiled `dist/main/index.js` entry point.
 *
 * Run: npx playwright test --config apps/desktop/playwright.config.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(__dirname, "test/e2e"),
  timeout: 60_000,
  outputDir: path.join(__dirname, "test-results-e2e"),
  retries: process.env.CI ? 1 : 0,
  // ISS-5723: the suite is dominated by per-test `_electron.launch` startup, so
  // its only real lever is running launches concurrently. Bounded at 2 on
  // purpose — N concurrent Electron instances is a MEMORY question on the
  // 4-vCPU/16GB `ubuntu-latest` runner, not a CPU one, and the gateway server's
  // candidate scan (`PORT_PROBE_ORDER`) only has four ports to walk, so 4 is a
  // hard ceiling regardless. Raising this further needs a CI measurement, not a
  // local one: `desktop-e2e` needs a real display server and cannot be timed
  // off-CI.
  //
  // Safe because every per-launch resource a spec can OBSERVE is isolated: a
  // `mkdtemp` user-data dir (so SQLite, electron-store, the persistent log and
  // Electron's own single-instance lock are per test), port-0 fixture servers,
  // and — as of this change — the two fixed loopback listeners, via
  // `E2E_EPHEMERAL_LOOPBACK_PORTS_ARG`. One shared write remains and is
  // deliberately left alone: the gateway discovery file at
  // `~/.closedloop-ai/electron-port` is `$HOME`-rooted rather than user-data
  // rooted, so concurrent launches race it last-write-wins. That race predates
  // this change (a single e2e launch already overwrote an operator's file), no
  // spec reads it back, and fixing it means threading `discoveryFilePath`
  // through `DesktopGatewayServer.createDefault` — its own change.
  workers: 2,
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(__dirname, "playwright-report-e2e") }],
    // ISS-5111: a machine-readable result the CI gate asserts on INDEPENDENTLY
    // of the run step's exit code. `desktop-e2e` is a required check and was
    // observed reporting success on a run whose suite printed `1 failed` — the
    // exit code was lost in the `dbus-run-session`/`xvfb-run` wrapper chain, so
    // the gate cannot rely on that code being the only signal. Written next to
    // the html report (both are gitignored).
    [
      "json",
      {
        outputFile: path.join(
          __dirname,
          "playwright-report-e2e",
          "results.json"
        ),
      },
    ],
  ],
  expect: {
    timeout: process.env.CI ? 15_000 : 8000,
  },
  // No `use.browserName` — Electron tests set up the app instance themselves
  // via _electron.launch inside each test file.
  projects: [
    {
      name: "electron",
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
