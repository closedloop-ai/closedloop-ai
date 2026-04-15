// SECURITY: This file handles authentication credentials. The storageState output
// (.auth/user.json) contains session tokens that grant full app access. Never commit
// .auth/user.json or expose it in public artifact stores. See playwright.config.ts
// for the WARNING comment on test-results/.
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

import { performSignIn, requireEnvVar, TEST_EMAIL } from "./helpers/sign-in";

setup("authenticate", async ({ page }) => {
  const password = requireEnvVar("DEVOPS_CLOSEDLOOP_APP_PWD");

  // In CI against remote environments, sign in with real credentials directly.
  // Locally, inject the Clerk testing token to bypass bot detection.
  if (!process.env.CI) {
    requireEnvVar("CLERK_TESTING_TOKEN");
    await setupClerkTestingToken({ page });
  }

  await performSignIn(page, TEST_EMAIL, password);
  await page.waitForURL("**/my-tasks");
  await page.context().storageState({ path: ".auth/user.json" });
});
