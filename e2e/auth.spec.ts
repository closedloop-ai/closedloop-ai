import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";

import { performSignIn, requireEnvVar, TEST_EMAIL } from "./helpers/sign-in";

const MY_TASKS_URL = /my-tasks/;

test("login flow authenticates and redirects to my-tasks", async ({ page }) => {
  const password = requireEnvVar("DEVOPS_CLOSEDLOOP_APP_PWD");

  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());

  // In CI against remote environments, sign in with real credentials directly.
  // Locally, inject the Clerk testing token to bypass bot detection.
  if (!process.env.CI) {
    requireEnvVar("CLERK_TESTING_TOKEN");
    await setupClerkTestingToken({ page });
  }

  await performSignIn(page, TEST_EMAIL, password);

  await expect(page).toHaveURL(MY_TASKS_URL);
  await expect(page.getByLabel("Email address")).not.toBeVisible();
});
