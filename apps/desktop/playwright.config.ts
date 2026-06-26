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
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(__dirname, "playwright-report-e2e") }],
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
