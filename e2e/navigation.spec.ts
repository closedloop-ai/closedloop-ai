import { expect, test } from "@playwright/test";

// Authenticated pages are wrapped in OnboardingGuard which returns null until
// the onboarding status query resolves. Give assertions enough time for that
// roundtrip on the remote environment.
const PAGE_TIMEOUT = 15_000;

test("loops page renders without errors", async ({ page }) => {
  await page.goto("/loops");
  await expect(page.getByRole("heading", { name: "Loops" })).toBeVisible({
    timeout: PAGE_TIMEOUT,
  });
});

test("my tasks page renders without errors", async ({ page }) => {
  await page.goto("/my-tasks");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible({
    timeout: PAGE_TIMEOUT,
  });
});

test("inbox page renders without errors", async ({ page }) => {
  await page.goto("/inbox");
  await expect(
    page.getByRole("heading", { name: "Notifications" })
  ).toBeVisible({ timeout: PAGE_TIMEOUT });
});
