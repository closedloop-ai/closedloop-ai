import { performSignIn, requireEnvVar, TEST_EMAIL } from "./helpers/sign-in";
import { expect, test } from "./test";

const POST_LOGIN_URL = /\/(my-tasks|onboarding)/;

test("new user onboarding — login and reach authenticated page", async ({
  page,
}) => {
  const password = requireEnvVar("DEVOPS_CLOSEDLOOP_APP_PWD");

  await page.context().clearCookies();
  // Navigate to the app origin before clearing localStorage (not accessible on about:blank)
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());

  await performSignIn(page, TEST_EMAIL, password);

  await expect(page).toHaveURL(POST_LOGIN_URL);
  await expect(page.getByLabel("Email address")).not.toBeVisible();
});
