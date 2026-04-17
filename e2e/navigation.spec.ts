import { expect, test } from "@playwright/test";

test("loops page renders without errors", async ({ page }) => {
  await page.goto("/loops");
  await expect(page.getByRole("heading", { name: "Loops" })).toBeVisible();
});

test("inbox page renders without errors", async ({ page }) => {
  await page.goto("/inbox");
  await expect(
    page.getByRole("heading", { name: "Notifications" })
  ).toBeVisible();
});
