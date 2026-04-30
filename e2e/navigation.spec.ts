import { expect, test } from "./test";

test("my-tasks page loads and shows sidebar", async ({ page }) => {
  await page.goto("/my-tasks");
  // Verify sidebar is visible with workspace links
  await expect(page.getByText("My Tasks").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Your Teams")).toBeVisible();
});

test("loops page renders without errors", async ({ page }) => {
  await page.goto("/loops");
  // "Loops" appears in sidebar nav
  await expect(page.getByText("Loops").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("inbox page renders without errors", async ({ page }) => {
  await page.goto("/inbox");
  await expect(page.getByText("Notifications").first()).toBeVisible({
    timeout: 15_000,
  });
});

test("settings page renders tabs", async ({ page }) => {
  await page.goto("/settings");
  // Settings has a tab bar — look for any tab
  await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 15_000 });
});
