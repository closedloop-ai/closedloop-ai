import type { Page } from "@playwright/test";

const CONTINUE_BUTTON = /continue/i;

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
