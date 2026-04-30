import { expect, test } from "./test";

test("settings page has multiple tabs", async ({ page }) => {
  await page.goto("/settings");
  // Wait for tabs to render
  const tabs = page.getByRole("tab");
  await expect(tabs.first()).toBeVisible({ timeout: 15_000 });
  // Should have more than one tab
  const count = await tabs.count();
  expect(count).toBeGreaterThan(1);
});
