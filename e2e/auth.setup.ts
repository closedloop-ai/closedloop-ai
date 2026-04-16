// SECURITY: This file handles authentication credentials. The storageState output
// (.auth/user.json) contains session tokens that grant full app access. Never commit
// .auth/user.json or expose it in public artifact stores. See playwright.config.ts
// for the WARNING comment on test-results/.
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

import { performSignIn, requireEnvVar, TEST_EMAIL } from "./helpers/sign-in";

const POST_LOGIN_URL = /\/(my-tasks|onboarding)/;
const SKIP_FOR_NOW = /skip for now/i;
const GET_STARTED = /get started/i;
const TEAM_NAME = /team name/i;
const CREATE_TEAM = /create team/i;
const PROJECT_NAME = /project name/i;
const CREATE_PROJECT = /create project/i;
const GO_TO_MY_TASKS = /go to my tasks/i;

setup("authenticate", async ({ page }) => {
  const password = requireEnvVar("DEVOPS_CLOSEDLOOP_APP_PWD");

  // Injects the testing token (fetched by clerkSetup in global.setup.ts) to bypass bot detection.
  await setupClerkTestingToken({ page });

  await performSignIn(page, TEST_EMAIL, password);

  // After sign-in, the user may land on /onboarding (new user) or /my-tasks (returning user).
  await page.waitForURL(POST_LOGIN_URL);

  // If redirected to onboarding, click through the wizard to reach /my-tasks.
  if (page.url().includes("/onboarding")) {
    const skip = page.getByRole("button", { name: SKIP_FOR_NOW });

    // Step 1: Welcome → Get Started
    await page.getByRole("button", { name: GET_STARTED }).click();

    // Step 2: Download Electron App → Skip
    await skip.click();

    // Step 3: Create Team → fill name + submit (auto-advances to next step)
    await page.getByLabel(TEAM_NAME).fill("E2E Test Team");
    await page.getByRole("button", { name: CREATE_TEAM }).click();

    // Step 4: Create Project → fill name + submit (auto-advances to next step)
    await page.getByLabel(PROJECT_NAME).fill("E2E Test Project");
    await page.getByRole("button", { name: CREATE_PROJECT }).click();

    // Step 5-7: GitHub, Anthropic Key, Integrations → Skip
    await skip.click();
    await skip.click();
    await skip.click();

    // Step 8: Complete → Go to My Tasks (navigates to /my-tasks?from=onboarding)
    await page.getByRole("button", { name: GO_TO_MY_TASKS }).click();
    await page.waitForURL("**/my-tasks**");
  }

  await page.context().storageState({ path: ".auth/user.json" });
});
