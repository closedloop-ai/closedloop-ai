import { expect, test } from "@playwright/test";

test("loops page renders without errors", async ({ page }) => {
  await page.goto("/loops");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "Loops" })).toBeVisible();
});

test("my tasks page renders without errors", async ({ page }) => {
  await page.goto("/my-tasks");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "My Tasks" })).toBeVisible();
});

test("inbox page renders without errors", async ({ page }) => {
  await page.goto("/inbox");
  await page.waitForLoadState("domcontentloaded");
  await expect(
    page.getByRole("heading", { name: "Notifications" })
  ).toBeVisible();
});
