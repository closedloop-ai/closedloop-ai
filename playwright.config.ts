// Load env vars before any imports so DEVOPS_CLOSEDLOOP_APP_PWD and CLERK_TESTING_TOKEN
// are available to the test runner process (Playwright does not auto-load .env.local unlike Next.js)
import { config } from "dotenv";

config({ path: "./apps/app/.env.local" });

import { defineConfig, devices } from "@playwright/test";

// WARNING: test-results/ may contain session screenshots from authenticated pages — do not upload to public artifact stores

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  outputDir: "test-results",
  globalSetup: "./e2e/global.setup.ts",
  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://localhost:3000",
  },
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      // retries: 0 is mandatory to prevent Clerk account lockout from consecutive login failures
      retries: 0,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/user.json",
      },
      dependencies: ["setup"],
      // retries: 0 — auth.spec.ts performs real password sign-in under this project;
      // retrying on failure would resubmit credentials and risk locking the shared Clerk account.
      retries: 0,
    },
  ],
});
