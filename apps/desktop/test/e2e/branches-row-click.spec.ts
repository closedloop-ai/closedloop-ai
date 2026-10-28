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
import { BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY } from "@repo/api/src/types/branches-linked-session-chips-flag.ts";
import {
  breadcrumbParentLink,
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
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
// FEA-4259: the Linked Sessions count links to the branch detail's Sessions &
// timeline tab, so its hash carries `?tab=sessions-timeline`.
const BRANCH_SESSIONS_HASH = /^#\/branches\/.+\?tab=sessions-timeline$/;
const SESSIONS_TAB_NAME = /sessions & timeline/i;
// The seeded branch links exactly one session, so the count chip's accessible
// name is the singular form.
const LINKED_SESSION_COUNT_NAME = "1 linked session";
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
        env: {
          CLAUDE_HOME: claudeHome,
          CODEX_HOME: codexHome,
        },
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
        env: {
          CLAUDE_HOME: claudeHome,
          CODEX_HOME: codexHome,
        },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "branches");
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByText("Active branches", { exact: true })
        ).toBeVisible({
          timeout: 30_000,
        });

        // The seeded activity is fixed in the past for deterministic fixtures.
        // Widen the list window so the row is present regardless of run date.
        await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);

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
        const backLink = breadcrumbParentLink(page, "Branches");
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

  // FEA-4259: the two unit tests cover each half of the linked-session-count
  // deep-link in isolation (the branches-table renders the count as a link to
  // `?tab=sessions-timeline`; the branch-detail view seeds/syncs the Sessions
  // tab from that query). This E2E stitches the two halves plus the Desktop
  // query handoff end to end so a regression in the wiring — the count href, the
  // hash-preserved query, or the tab seed — reddens here even if each unit test
  // stays green (whitlockk review request).
  test("clicking the linked-session count opens the branch detail on the Sessions tab", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-session-count-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-session-count-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-branch-session-count-udd-")
    );

    try {
      // Launch 1: create + migrate the SQLite schema, then close before seed.
      const firstLaunch = await launchDesktopApp({
        env: {
          CLAUDE_HOME: claudeHome,
          CODEX_HOME: codexHome,
        },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await firstLaunch.cleanup();
      }

      // One local branch with one linked session → the Linked Sessions count
      // renders 1 and links to the branch detail's Sessions tab.
      await seedNoPullRequestBranch(userDataDir, SEED);

      // Launch 2: the real Branches source reads the seeded local branch.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        beforeLaunch: (launchUserDataDir) => {
          seedDesktopFeatureFlags(launchUserDataDir, {
            [BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY]: true,
          });
        },
        env: {
          CLAUDE_HOME: claudeHome,
          CODEX_HOME: codexHome,
        },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "branches");
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          page.getByText("Active branches", { exact: true })
        ).toBeVisible({
          timeout: 30_000,
        });

        // The seeded activity is fixed in the past for deterministic fixtures.
        // Widen the list window so the row is present regardless of run date.
        await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);

        // Wait for the seeded row to be present via its branch-name link, then
        // click the Linked Sessions count chip (an accessible-named link).
        const branchLink = page
          .locator('a[href^="#/branches/"]')
          .filter({ hasText: SEED.branchName });
        await expect(branchLink).toBeVisible({ timeout: 30_000 });

        const sessionCountLink = page.getByRole("link", {
          name: LINKED_SESSION_COUNT_NAME,
        });
        await expect(sessionCountLink).toBeVisible({ timeout: 30_000 });
        // The count link carries the Sessions-tab query in its own href.
        await expect(sessionCountLink).toHaveAttribute(
          "href",
          BRANCH_SESSIONS_HASH
        );
        // Local SQLite cannot provide canonical membership summaries, so the
        // flag-on V2 surface must retain this count instead of inventing a chip.
        //
        // `:visible` is load-bearing, and `main` would not have been: the
        // desktop shell keeps every visited route MOUNTED and hides it with
        // `display:none`, inside the same `<main>`. `toHaveCount` does not
        // filter on visibility, so the page-wide locator was also matching the
        // Dashboard's Recent Sessions card in the hidden sibling route — a card
        // no reader of this screen can see.
        //
        // It read zero only because the Dashboard happened to be held in its
        // Loading state by pending analytics, rendering no rows at all.
        // ISS-11204 deliberately stopped doing that: a dashboard with rows
        // reaches Ready while analytics are still arriving. So the old locator
        // was passing for a reason that had nothing to do with this surface.
        // "Does the Branches row invent a chip" is a question about what is on
        // screen, and this now asks exactly that.
        await expect(
          page.locator('a[href^="#/sessions/"]:visible')
        ).toHaveCount(0);
        await sessionCountLink.click();

        // The hash navigated to the branch detail route WITH the Sessions-tab
        // query preserved (the Desktop adapter keeps `?tab=` on the hash).
        await expect
          .poll(() => page.evaluate(() => window.location.hash), {
            timeout: 15_000,
          })
          .toMatch(BRANCH_SESSIONS_HASH);

        // Detail mounted on the Sessions & timeline tab (aria-selected), not the
        // default Branch details tab — the count and the Name link resolve to
        // the same branch, and the query seeded the tab.
        const sessionsTab = page.getByRole("tab", { name: SESSIONS_TAB_NAME });
        await expect(sessionsTab).toHaveAttribute("aria-selected", "true", {
          timeout: 30_000,
        });
        await expect(
          page.getByRole("tab", { name: "Branch details" })
        ).toHaveAttribute("aria-selected", "false");

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
