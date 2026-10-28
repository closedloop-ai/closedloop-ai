/**
 * ISS-10930: the Desktop Dashboard header reads the web-master prototype's
 * title and description, the same copy the web dashboard renders.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { DATE_RANGE_FILTER_ARIA_LABEL } from "@repo/app/shared/components/date-range-filter-labels.ts";
import {
  DASHBOARD_DESCRIPTION,
  DASHBOARD_HEADING,
} from "./helpers/dashboard-header-copy";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";

test.describe("Dashboard header copy", () => {
  test("renders the prototype title with its description beneath it", async () => {
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-header-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-dashboard-header-codex-")
    );
    let cleanup: (() => Promise<void>) | undefined;

    try {
      const launched = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataPrefix: "desktop-dashboard-header-e2e-",
      });
      cleanup = launched.cleanup;
      const { page, pageErrors } = launched;

      await gotoNav(page, "dashboard");
      // `DashboardFallback` renders the same title and description while the
      // lazy page chunk loads. ISS-10929 retired the Tour control this used to
      // wait on; the range filter is the header's remaining control and it
      // still mounts only with the loaded page, so the header read below is
      // the page's and not the fallback's. `radiogroup`, not `group`: Radix's
      // ToggleGroup announces the former for `type="single"`, which is what
      // `dashboard-computed-badge.spec.ts` already locates this control by.
      await expect(
        page.getByRole("radiogroup", { name: DATE_RANGE_FILTER_ARIA_LABEL })
      ).toBeVisible({ timeout: 15_000 });

      const heading = page.getByRole("heading", {
        exact: true,
        level: 1,
        name: DASHBOARD_HEADING,
      });
      await expect(heading).toBeVisible({ timeout: 15_000 });
      // Scoped to the heading's own block so a match elsewhere on the page
      // cannot stand in for the description under the H1.
      await expect(
        heading.locator("xpath=..").getByText(DASHBOARD_DESCRIPTION, {
          exact: true,
        })
      ).toBeVisible();
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
