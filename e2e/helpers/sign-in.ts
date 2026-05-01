import type { Page } from "@playwright/test";
import { gotoAuthenticatedApp } from "./app-bootstrap";

const CONTINUE_BUTTON = /continue/i;
const POST_LOGIN_URL = /\/(my-tasks|onboarding)/;
const SKIP_FOR_NOW = /skip for now/i;
const GET_STARTED = /get started/i;
const TEAM_NAME = /team name/i;
const CREATE_TEAM = /create team/i;
const PROJECT_NAME = /project name/i;
const CREATE_PROJECT = /create project/i;
const GO_TO_MY_TASKS = /go to my tasks/i;

export async function performSignIn(
  page: Page,
  email: string,
  password: string
): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: CONTINUE_BUTTON }).click();
  await page.locator("#password-field").fill(password);
  await page.getByRole("button", { name: CONTINUE_BUTTON }).click();
}

export const TEST_EMAIL = "devops+testing@closedloop.ai";

export function requireEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

export async function authenticateToApp(
  page: Page,
  options?: { fresh?: boolean }
) {
  if (options?.fresh) {
    await page.context().clearCookies();
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  }

  const password = requireEnvVar("DEVOPS_CLOSEDLOOP_APP_PWD");

  await performSignIn(page, TEST_EMAIL, password);
  await page.waitForURL(POST_LOGIN_URL);

  if (page.url().includes("/onboarding")) {
    const skip = page.getByRole("button", { name: SKIP_FOR_NOW });

    await page.getByRole("button", { name: GET_STARTED }).click();
    await skip.click();

    await page.getByLabel(TEAM_NAME).fill("E2E Test Team");
    await page.getByRole("button", { name: CREATE_TEAM }).click();

    await page.getByLabel(PROJECT_NAME).fill("E2E Test Project");
    await page.getByRole("button", { name: CREATE_PROJECT }).click();

    await skip.click();
    await skip.click();
    await skip.click();

    await page.getByRole("button", { name: GO_TO_MY_TASKS }).click();
    await page.waitForURL("**/my-tasks**");
  }

  await gotoAuthenticatedApp(page);
}
