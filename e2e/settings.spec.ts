import { ensureAuthenticatedShellReady } from "./helpers/app-bootstrap";
import { expect, test } from "./test";

test("settings page has multiple tabs", async ({ page }) => {
  await page.goto("/settings");
  await ensureAuthenticatedShellReady(page);
  const tabs = page.getByRole("tab");
  await expect(tabs.first()).toBeVisible({ timeout: 30_000 });
  const count = await tabs.count();
  expect(count).toBeGreaterThan(1);
});
