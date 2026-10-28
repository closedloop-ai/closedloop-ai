/**
 * E2E test: the desktop Branches Status column header keeps its accessible
 * contract (ISS-11837) and the local source serves no Tags column (ISS-12456).
 *
 * It no longer pins Status row ordering (ISS-9666): that needs a cohort with
 * more than one derived status, and the local store holds no PR state, merge
 * instant or draft flag to derive one from (ISS-12709).
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  BRANCH_TAGS_COLUMN_ID,
  branchColumnLabel,
} from "@repo/app/branches/lib/branch-column-view-model.ts";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
} from "./helpers/desktop-app";
import { sortColumnByOptionsMenu } from "./helpers/grid-column-sort";
import {
  seedBranchWithUnobservedPullRequest,
  type UnobservedPrBranchSeed,
} from "./helpers/seed-branch-unobserved-pr-fixture";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

const REPOSITORY = "closedloop-e2e/status-sort";
const STATUS_HEADER = "Status";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The geometry's own id for the Repository column, which exports no constant. */
const REPO_COLUMN_ID = "repo";
const REPO_LABEL = branchColumnLabel(REPO_COLUMN_ID);
const TAGS_LABEL = branchColumnLabel(BRANCH_TAGS_COLUMN_ID);
const OPTIONS_BUTTON = "Options";

const SEEDS: readonly Omit<UnobservedPrBranchSeed, "repoFullName">[] = [
  seed("c-second", 3),
  seed("b-first", 2),
];

test.describe("Branches Status header (ISS-11837)", () => {
  test("the Status header keeps its accessible contract and Tags is absent", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-status-sort-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-status-sort-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-status-sort-udd-")
    );
    const env = {
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
    };

    try {
      // Launch 1: create + migrate the SQLite schema, then close before seed.
      const firstLaunch = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await firstLaunch.cleanup();
      }

      for (const branchSeed of SEEDS) {
        await seedBranchWithUnobservedPullRequest(userDataDir, {
          ...branchSeed,
          repoFullName: REPOSITORY,
        });
      }

      // Launch 2: the real Branches IPC source reads the seeded local corpus.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoNav(page, "branches");
        await expect(
          page.locator("header").getByText("Branches", { exact: true })
        ).toBeVisible({ timeout: 30_000 });

        await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);

        const names = page.locator('a[href^="#/branches/"]:not([href*="?"])');
        await expect(names).toHaveCount(SEEDS.length, { timeout: 30_000 });

        await sortColumnByOptionsMenu(page, page, STATUS_HEADER, "ascending");

        // ISS-11837: the Status header renders the column-options button, and
        // Chromium used to fold that button's name and the resize handle's
        // into the header's own, so an exact-name lookup found nothing. The
        // header is now named "Status" alone, the button keeps its own name,
        // and the draggable label shows the grab cursor, not the pointer.
        const statusHeader = page
          .getByRole("columnheader", { exact: true, name: STATUS_HEADER })
          .locator("visible=true");
        await expect(statusHeader).toHaveCount(1);
        await expect(statusHeader).toHaveAccessibleName(STATUS_HEADER);
        await expect(statusHeader).toHaveAttribute("aria-sort", "ascending");
        await expect(
          statusHeader.getByRole("button", {
            exact: true,
            name: `${STATUS_HEADER} column options`,
          })
        ).toHaveCount(1);
        await expect(statusHeader).toHaveAttribute("draggable", "true");
        await expect(
          statusHeader.getByText(STATUS_HEADER, { exact: true })
        ).toHaveCSS("cursor", "grab");

        // ISS-12456: the launched local SQLite source serves no `tags`, so the
        // Branches host opts out of the Tags column entirely — no header, no
        // cells, no column-options button, no Columns-picker entry. This
        // replaces the ISS-11837 Tags-menu assertions this spec used to make,
        // which named a button local mode no longer draws.
        //
        // Repository is the positive control on every query family below: it is
        // a column the local source DOES serve, so a zero count for Tags cannot
        // be a selector that never resolved.
        await expect(
          page.locator(
            `[role="columnheader"][data-column-id="${REPO_COLUMN_ID}"]`
          )
        ).not.toHaveCount(0);
        await expect(
          page.locator(
            `[role="columnheader"][data-column-id="${BRANCH_TAGS_COLUMN_ID}"]`
          )
        ).toHaveCount(0);
        // Cells as well as the header: a column dropped from the specs renders
        // neither, and the data rows carry the same `data-column-id`.
        await expect(
          page.locator(`[data-column-id="${BRANCH_TAGS_COLUMN_ID}"]`)
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            exact: true,
            name: `${REPO_LABEL} column options`,
          })
        ).not.toHaveCount(0);
        await expect(
          page.getByRole("button", {
            exact: true,
            name: `${TAGS_LABEL} column options`,
          })
        ).toHaveCount(0);

        await page
          .getByRole("button", { exact: true, name: OPTIONS_BUTTON })
          .locator("visible=true")
          .first()
          .click();
        const optionsMenu = page.getByRole("menu");
        await expect(
          optionsMenu.getByRole("menuitem", { exact: true, name: REPO_LABEL })
        ).not.toHaveCount(0);
        await expect(
          optionsMenu.getByRole("menuitem", { exact: true, name: TAGS_LABEL })
        ).toHaveCount(0);
        await page.keyboard.press("Escape");

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

function seed(
  suffix: string,
  prNumber: number
): Omit<UnobservedPrBranchSeed, "repoFullName"> {
  return {
    activityAt: new Date(Date.now() - DAY_MS).toISOString(),
    branchName: `iss-9666-${suffix}`,
    prNumber,
    sessionId: `iss-9666-status-sort-${suffix}`,
  };
}
