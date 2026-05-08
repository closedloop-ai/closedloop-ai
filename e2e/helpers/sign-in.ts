import type { Page } from "@playwright/test";
import { gotoAuthenticatedApp, waitForClerkUser } from "./app-bootstrap";
import { getClerkBearerToken } from "./clerk-token";
import { ensureWizardCompleted } from "./onboarding";

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

  // Persist `wizardCompletedAt` server-side BEFORE OnboardingGuard's first
  // /onboarding query runs. On a fresh preview deployment that query is slow
  // (cold start + parallel count queries), and a slow first call hangs
  // waitForAuthenticatedEntry until it times out. Calling complete-wizard
  // here both warms the route and pins wizardCompleted=true persistently, so
  // OnboardingGuard renders children quickly on every subsequent navigation.
  await waitForClerkUser(page);
  const token = await getClerkBearerToken(page);
  await ensureWizardCompleted(page.request, token);

  await gotoAuthenticatedApp(page);
}
