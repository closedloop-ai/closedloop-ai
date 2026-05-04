import type { Page } from "@playwright/test";
import { gotoAuthenticatedApp } from "./app-bootstrap";

const CONTINUE_BUTTON = /continue/i;
const SIGN_IN_PATH_PREFIX = "/sign-in";

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
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  }

  const password = requireEnvVar("DEVOPS_CLOSEDLOOP_APP_PWD");

  await performSignIn(page, TEST_EMAIL, password);
  await page.waitForURL(
    (url) => !url.pathname.startsWith(SIGN_IN_PATH_PREFIX),
    { waitUntil: "domcontentloaded" }
  );

  await gotoAuthenticatedApp(page);
}
