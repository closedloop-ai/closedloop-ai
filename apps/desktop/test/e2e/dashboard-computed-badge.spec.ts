/**
 * E2E acceptance check: the Desktop Dashboard no longer shows the
 * "Computed on this device" badge beside the time-range controls.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";

const REMOVED_COMPUTED_BADGE_TEXT = "Computed on this device";
const ANALYZING_LOCALLY_TEXT = /Analyzing locally/;

test.describe("Dashboard computed badge", () => {
  test("does not render the removed local-compute badge", async () => {
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-badge-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-badge-codex-")
    );
    let cleanup: (() => Promise<void>) | undefined;

    try {
      const launched = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix: "desktop-dashboard-badge-e2e-",
      });
      cleanup = launched.cleanup;
      const { page, pageErrors } = launched;

      await gotoNav(page, "dashboard");

      await expect(
        page.getByRole("heading", {
          exact: true,
          level: 1,
          name: "Welcome to Closedloop",
        })
      ).toBeVisible({ timeout: 15_000 });

      const dateRange = page.getByRole("group", { name: "Date range" });
      await expect(dateRange).toBeVisible({ timeout: 15_000 });
      await expect(
        dateRange.getByRole("radio", {
          exact: true,
          name: "Last 90 days",
        })
      ).toBeVisible();

      await expect(page.getByText("No agent sessions yet")).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(ANALYZING_LOCALLY_TEXT)).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(
        REMOVED_COMPUTED_BADGE_TEXT
      );
      expect(pageErrors).toEqual([]);
    } finally {
      try {
        await cleanup?.();
      } finally {
        fs.rmSync(claudeHome, { recursive: true, force: true });
        fs.rmSync(codexHome, { recursive: true, force: true });
      }
    }
  });
});
