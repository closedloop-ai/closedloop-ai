import { ensureAuthenticatedShellReady } from "./helpers/app-bootstrap";
import { expect, test } from "./test";

test("my-tasks page loads and shows sidebar", async ({ page }) => {
  await page.goto("/my-tasks");
  await ensureAuthenticatedShellReady(page);
  await expect(page.getByText("My Tasks").first()).toBeVisible();
  await expect(page.getByText("Your Teams")).toBeVisible();
});

test("loops page renders without errors", async ({ page }) => {
  await page.goto("/loops");
  await ensureAuthenticatedShellReady(page);
  await expect(page.getByText("Loops").first()).toBeVisible();
});

test("inbox page renders without errors", async ({ page }) => {
  await page.goto("/inbox");
  await ensureAuthenticatedShellReady(page);
  await expect(page.getByText("Notifications").first()).toBeVisible();
});

test("settings page renders tabs", async ({ page }) => {
  await page.goto("/settings");
  await ensureAuthenticatedShellReady(page);
  await expect(page.getByRole("tab").first()).toBeVisible({ timeout: 30_000 });
});
