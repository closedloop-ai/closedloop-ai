import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";

import { performSignIn, requireEnvVar, TEST_EMAIL } from "./helpers/sign-in";

const MY_TASKS_URL = /my-tasks/;

test("login flow authenticates and redirects to my-tasks", async ({ page }) => {
  const password = requireEnvVar("DEVOPS_CLOSEDLOOP_APP_PWD");

  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());

  // Injects the testing token (fetched by clerkSetup in global.setup.ts) to bypass 2FA and bot detection.
  await setupClerkTestingToken({ page });

  await performSignIn(page, TEST_EMAIL, password);

  await expect(page).toHaveURL(MY_TASKS_URL);
  await expect(page.getByLabel("Email address")).not.toBeVisible();
});
