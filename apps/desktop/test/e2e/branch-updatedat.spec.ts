/**
 * PRD-600 COMMON-004 supersedes the old Session-end fallback: Session end and
 * scan time are not authoritative Last-active events. A Session-only branch
 * therefore stays visible but must render Last active as Unavailable.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { startFakeGitHubAuthorityServer } from "./helpers/fake-github-authority-server";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

// Dated well over a week before any plausible run date so the relative-time
// formatter renders an absolute locale date (which always contains the year)
// rather than a "just now" / "Nm ago" / "Nh ago" / "Nd ago" label.
const PAST_TURN_TIMESTAMP = "2026-05-15T12:00:00.000Z";
const SEEDED_BRANCH = "barry/updatedat-regression";
const SEEDED_REPOSITORY = "acme/branch-updatedat";
const UNAVAILABLE_LABEL = "Unavailable";

test.describe("Branch Last active canonical evidence", () => {
  test("Session end and scan time do not fabricate Last active", async () => {
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
    const authorityServer = await startFakeGitHubAuthorityServer([
      SEEDED_REPOSITORY,
    ]);
    const env = {
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
      ...authorityServer.env,
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

      // Session end and link observation exist, but neither is canonical
      // commit/PR activity. The retention anchor stays current so the old
      // Session survives the boot sweep without becoming Last-active evidence.
      await seedNoPullRequestBranch(
        userDataDir,
        {
          activityAt: PAST_TURN_TIMESTAMP,
          branchName: SEEDED_BRANCH,
          repoFullName: SEEDED_REPOSITORY,
          sessionId: "branch-updatedat-e2e-session",
        },
        { sessionLastActivityAt: new Date().toISOString() }
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

        // The seeded activity is ~35-40 days old, but the Branches list defaults
        // to a 7-day time window — widen it to "All time" so the seeded branch is
        // in range (this test asserts the Updated value, not the window itself).
        // `:visible` scopes to the Branches toolbar: keep-alive views (e.g. the
        // Sessions view) stay mounted-but-hidden and also render this control.
        await page.locator('[aria-label="All time"]:visible').click();

        const branchLink = page
          .locator('a[href^="#/branches/"]')
          .filter({ hasText: SEEDED_BRANCH });
        const branchRow = page.locator("div.grid.h-11").filter({
          has: branchLink,
        });
        await expect(branchRow).toBeVisible({ timeout: 45_000 });

        // The seeded Session has no authoritative qualifying activity atom, so
        // neither its end time nor the import scan may become Last active.
        const updatedLabel = branchRow.locator(
          '[data-column-id="lastActivity"]'
        );
        await expect(updatedLabel).toHaveText(UNAVAILABLE_LABEL, {
          timeout: 20_000,
        });

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await authorityServer.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
