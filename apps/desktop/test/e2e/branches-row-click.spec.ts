/**
 * E2E flow (FEA-2939): clicking a Branches row navigates to the branch detail
 * view. No spec exercised branch row click → detail navigation.
 *
 * Each Branches row renders its branch name as an anchor to
 * `#/branches/<encoded-id>` (see branches-table.tsx / branch-hrefs.ts). This
 * seeds one local branch (no pull_request needed) via the DB-direct path, boots
 * the app, clicks the row's branch-name link, and asserts the detail route
 * mounted:
 *   - the hash navigated to `#/branches/…`, and
 *   - the Topbar breadcrumb gained a linked "Branches" parent (on the list,
 *     "Branches" is the current-page span, not a link) whose href is the
 *     branches list route — the same detail-mount signal the shared breadcrumb
 *     model produces.
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
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const SEED = {
  repoFullName: "acme/frontend",
  branchName: "fea-2939-branch-row-click",
  sessionId: "fea-2939-branch-row-click-session",
  activityAt: "2026-05-20T12:00:00.000Z",
} as const;

// The detail route hash and the breadcrumb parent-link href.
const BRANCH_DETAIL_HASH = /^#\/branches\/.+/;
const BRANCHES_LIST_HREF = /\/branches$/;

test.describe("Branches row click → detail (FEA-2939)", () => {
  test("clicking a branch row opens its detail view", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-row-click-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-row-click-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-row-click-udd-")
    );

    try {
      // Launch 1: create + migrate the SQLite schema, then close before seed.
      const firstLaunch = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await firstLaunch.cleanup();
      }

      await seedNoPullRequestBranch(userDataDir, SEED);

      // Launch 2: the real Branches source reads the seeded local branch.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "branches");
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText("AI spend", { exact: true })).toBeVisible({
          timeout: 30_000,
        });

        // The seeded activity is fixed in the past for deterministic fixtures.
        // Widen the list window so the row is present regardless of run date.
        await page.locator('[aria-label="All time"]:visible').click();

        const branchLink = page
          .locator('a[href^="#/branches/"]')
          .filter({ hasText: SEED.branchName });
        await expect(branchLink).toBeVisible({ timeout: 30_000 });

        // Click the row's branch-name link to open the detail view.
        await branchLink.click();

        // The hash navigated to the branch detail route.
        await expect
          .poll(() => page.evaluate(() => window.location.hash), {
            timeout: 15_000,
          })
          .toMatch(BRANCH_DETAIL_HASH);

        // Detail mounted: the Topbar breadcrumb now has a "Branches" parent LINK
        // (absent on the list, where "Branches" is the current-page span).
        const breadcrumb = page.getByRole("navigation", { name: "Breadcrumb" });
        const backLink = breadcrumb.getByRole("link", { name: "Branches" });
        await expect(backLink).toBeVisible({ timeout: 30_000 });

        // Its parent link targets the branches list route.
        await expect(backLink).toHaveAttribute("href", BRANCHES_LIST_HREF);

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
