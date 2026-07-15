/**
 * E2E regression for FEA-1901 follow-up: expanding the desktop Labs nav section
 * must survive the same full renderer reload primitive users trigger with
 * Cmd+R/Ctrl+R.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { DESKTOP_LABS_NAV_SECTION_STORAGE_KEY } from "../../src/renderer/components/layout/sidebar-persistence";
import { launchDesktopApp } from "./helpers/desktop-app";

test.describe("Labs nav reload persistence", () => {
  test("keeps Labs expanded after a full desktop renderer reload", async () => {
    const { app, page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-labs-reload-e2e-",
    });

    try {
      const labsToggle = page.getByRole("button", { name: "Labs" });
      await expect(labsToggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("link", { name: "Insights" })).toHaveCount(0);

      await labsToggle.click();

      await expect(labsToggle).toHaveAttribute("aria-expanded", "true");
      await expect(page.getByRole("link", { name: "Insights" })).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            (key) => window.localStorage.getItem(key),
            DESKTOP_LABS_NAV_SECTION_STORAGE_KEY
          )
        )
        .toBe("true");

      await Promise.all([
        page.waitForEvent("framenavigated"),
        app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.webContents.reload();
        }),
      ]);
      await page.waitForLoadState("domcontentloaded");

      await expect(page.getByRole("button", { name: "Labs" })).toHaveAttribute(
        "aria-expanded",
        "true"
      );
      await expect(page.getByRole("link", { name: "Insights" })).toBeVisible();
      const persistedAfterReload = await page.evaluate(
        (key) => window.localStorage.getItem(key),
        DESKTOP_LABS_NAV_SECTION_STORAGE_KEY
      );
      expect(persistedAfterReload).toBe("true");
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
