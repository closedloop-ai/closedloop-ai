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
import {
  selectionFromEnv,
  shardFromEnv,
  workersFromEnv,
} from "./test/e2e-selection.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.join(__dirname, "test/e2e"),
  // ISS-10407 — change-scoped selection, `undefined` (the full suite) unless the
  // lane explicitly narrowed. Decided here rather than as a CLI argument because
  // the CI step runs this suite through `dbus-run-session` and `xvfb-run`, whose
  // option parsers are documented in e2e-test.yml as mangling flags they did not
  // expect. See test/e2e-selection.ts for why every ambiguous input fails open.
  grep: selectionFromEnv(),
  // ISS-9871: the post-merge lane's leg, null (the whole suite) everywhere else.
  shard: shardFromEnv(),
  timeout: 60_000,
  outputDir: path.join(__dirname, "test-results-e2e"),
  retries: process.env.CI ? 1 : 0,
  // ISS-9871: 2 stays the default. Full validation and its matching attribution
  // probe explicitly request 14; smoke and shard selection remain independent.
  // The shared test gateway assigns ephemeral ports and profile-owned discovery
  // writes, leaving production probe ports unchanged.
  workers: workersFromEnv(),
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
    // ISS-10132: the same gate needs Datadog's quarantine verdict, and the JSON
    // report above does not carry it — dd-trace suppresses a quarantined
    // failure inside the runner without rewriting `stats.unexpected` or the
    // test's `annotations`, so the gate reddened the REQUIRED `desktop-e2e`
    // context on failures the runner had already absorbed. This writes the
    // `_ddIsQuarantined` tags beside `results.json` for it to read.
    [
      path.join(__dirname, "scripts", "dd-quarantine-reporter.ts"),
      {
        outputDir: path.join(__dirname, "playwright-report-e2e"),
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
