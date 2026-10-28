/** ISS-11915: Session last activity is the fallback when branch evidence is absent. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
  selectDesktopDateRange,
  widenToAllTime,
} from "./helpers/desktop-app";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const PAST_TURN_TIMESTAMP = new Date(
  Date.now() - 30 * 86_400_000
).toISOString();
const SEEDED_BRANCH = "barry/updatedat-regression";
const SEEDED_REPOSITORY = "acme/branch-updatedat";

test.describe("Branch Last active canonical evidence", () => {
  test("old Session-only branches are excluded from 7d and show Session activity in All time", async () => {
    test.setTimeout(120_000);
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-updatedat-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-updatedat-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-updatedat-udd-")
    );
    const env = {
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
    };

    try {
      const migrationLaunch = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await migrationLaunch.cleanup();
      }

      await seedNoPullRequestBranch(
        userDataDir,
        {
          activityAt: PAST_TURN_TIMESTAMP,
          branchName: SEEDED_BRANCH,
          repoFullName: SEEDED_REPOSITORY,
          sessionId: "branch-updatedat-e2e-session",
        },
        { sessionLastActivityAt: PAST_TURN_TIMESTAMP }
      );

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await gotoNav(page, "branches");
        // The full-width Branches view shows its title only in the Topbar
        // breadcrumb (no in-body <h1>); assert that to confirm the route mounted.
        // Scoped to <header> so it can't match the sidebar nav button.
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });

        const branchLink = page
          .locator('a[href^="#/branches/"]')
          .filter({ hasText: SEEDED_BRANCH });
        const branchRow = page.locator("div.grid.h-11").filter({
          has: branchLink,
        });
        await widenToAllTime(page);
        await expect(branchRow).toBeVisible({ timeout: 45_000 });

        const updatedLabel = branchRow.locator(
          '[data-column-id="lastActivity"]'
        );
        await expect(updatedLabel).toHaveText(
          new Date(PAST_TURN_TIMESTAMP).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          }),
          { timeout: 20_000 }
        );

        await selectDesktopDateRange(page, DesktopDateRangeLabel.Last7Days);
        await expect(branchRow).toHaveCount(0, { timeout: 45_000 });
        await widenToAllTime(page);
        await expect(branchRow).toBeVisible({ timeout: 45_000 });

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
