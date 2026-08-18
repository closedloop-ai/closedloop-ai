/**
 * PRD-601 LIST-012 requires the exact "LOC per $" label and refuses to combine
 * lifetime LOC/cost when trustworthy event-time complete pairs are absent. This
 * launched-Desktop test proves that a nonempty seeded cohort never revives the
 * legacy lifetime ratio when those pairs are missing.
 *
 * It asserts a DIFFERENT absent-state per window, because the metric reports two
 * different claims and the difference is the point (`calculateLocPerDollar` in
 * `packages/lib/branches/branch-list-metrics.ts`):
 *
 *   - ALL TIME  → `NotApplicable` → "N/A". There is no history outside the
 *     window, so "no qualifying pair exists" is a complete statement about the
 *     cohort: the metric genuinely does not apply to it.
 *   - A BOUNDED WINDOW → `Unavailable` → the em-dash. A finite window cannot
 *     distinguish "no work happened here" from "the event-time evidence needed
 *     to place work here was never captured", so the metric fails CLOSED and
 *     says it cannot measure, rather than asserting inapplicability it has not
 *     established.
 *
 * Pinning one string across both windows (as this spec did through ISS-4472)
 * asserts the weaker contract and can only pass while the narrowed window's card
 * still shows the previous window's value — i.e. it passes on a stale read and
 * fails once the re-derivation lands. Asserting each state separately pins the
 * settled value and keeps the two claims from being collapsed into one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createBranchesListParityData } from "../../../../e2e/helpers/branches-list-parity-data";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { startFakeGitHubAuthorityServer } from "./helpers/fake-github-authority-server";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";
import {
  type SharedSessionLocPerDollarSeed,
  seedSharedSessionLocPerDollarBranches,
} from "./helpers/seed-loc-per-dollar-db";

// The canonical label — `packages/api/src/utils/loc-per-dollar.ts`. Pinned as a
// local literal rather than imported: a desktop e2e spec must never import an
// extension-less `@repo/*` TS subpath, which aborts the WHOLE Electron suite at
// load time before any test runs.
const branchesListParityData = createBranchesListParityData();
const { branches, churn, expectations, repoFullName, session } =
  branchesListParityData;
const CARD_SELECTOR = '[data-slot="card"]';
const CARD_VALUE_SELECTOR = '[data-slot="card-title"]';
const ALL_TIME_RANGE_LABEL = "All time";
const SEVEN_DAY_RANGE_LABEL = "Last 7 days";

const SEED: SharedSessionLocPerDollarSeed = {
  branches: [
    {
      branchId: branches.recent.id,
      branchName: branches.recent.name,
      mergedAt: branches.recent.activityAt,
      prNumber: branches.recent.prNumber,
    },
    {
      branchId: branches.older.id,
      branchName: branches.older.name,
      mergedAt: branches.older.activityAt,
      prNumber: branches.older.prNumber,
    },
  ],
  costUsd: session.costUsd,
  filesChanged: churn.filesChanged,
  linesAdded: churn.additions,
  linesRemoved: churn.deletions,
  repoFullName,
  sessionId: session.id,
};

test.describe("Branches LOC per $ canonical availability", () => {
  test("missing event-time complete pairs never revive the lifetime ratio", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-value-per-dollar-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-value-per-dollar-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-value-per-dollar-udd-")
    );
    const authorityServer = await startFakeGitHubAuthorityServer([
      repoFullName,
    ]);
    const env = {
      CLAUDE_HOME: claudeHome,
      CODEX_HOME: codexHome,
      ...authorityServer.env,
    };

    try {
      // Launch 1 — create + migrate the SQLite schema, confirm it landed, close.
      const first = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      await waitForBranchesSchema(userDataDir);
      await first.cleanup();

      // Seed the shared-session, two-branch corpus while the app is DOWN.
      await seedSharedSessionLocPerDollarBranches(userDataDir, SEED);

      // Launch 2 — the app's real branch-analytics projection reads the seeded
      // corpus at boot.
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

        // Both rows are visible, but their legacy lifetime values do not prove
        // canonical event-time complete pairs. Unbounded, "no qualifying pair"
        // describes the whole cohort — the metric does not apply: "N/A".
        await selectDateRange(page, ALL_TIME_RANGE_LABEL);
        await assertCanonicalBranchRow(page, branches.recent);
        await assertCanonicalBranchRow(page, branches.older);
        await expect(
          metricCardValue(page, expectations.aiSpendLabel)
        ).toHaveText(expectations.allTimeSpend, { timeout: 30_000 });
        await expect(locPerDollarValue(page)).toHaveText(
          expectations.allTimeLocPerDollar,
          { timeout: 30_000 }
        );

        // Narrow to 7 days. The table shrinks, and the card still refuses to
        // import the lifetime ratio — but it now reports the WEAKER claim it can
        // actually support. Inside a finite window the absent pair could mean no
        // work OR uncaptured evidence, so the metric fails closed to Unavailable
        // (the em-dash) instead of repeating an inapplicability verdict it can no
        // longer establish. Asserting "N/A" here would demand the card carry the
        // all-time answer into a window that cannot justify it.
        await selectDateRange(page, SEVEN_DAY_RANGE_LABEL);
        await expect(
          visibleBranchNameCells(page, branches.older.name)
        ).toHaveCount(0);
        await assertCanonicalBranchRow(page, branches.recent);
        await expect(
          metricCardValue(page, expectations.aiSpendLabel)
        ).toHaveText(expectations.boundedSpend, { timeout: 30_000 });
        await expect(locPerDollarValue(page)).toHaveText(
          expectations.boundedLocPerDollar,
          { timeout: 30_000 }
        );

        // Follow the real local list link into Branch Detail. The one $100
        // session is shared by two branches, so the renderer must receive and
        // display the SQLite projection's canonical $50 share, never raw $100.
        await page
          .getByRole("link", { name: branches.recent.name })
          .first()
          .click();
        await expect(
          page.getByRole("heading", { name: branches.recent.name })
        ).toBeVisible({ timeout: 30_000 });
        await page.getByRole("tab", { name: "Sessions & timeline" }).click();
        const timeline = page.locator("section.bq-act");
        await expect(
          timeline.getByText("$50.00", { exact: true }).first()
        ).toBeVisible();
        await expect(
          timeline.getByText("$100.00", { exact: true })
        ).toHaveCount(0);

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("value-per-dollar-card-e2e.png"),
        });

        // No uncaught renderer errors (a blanked chunk would also fail above).
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await authorityServer.close();
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});

/** Every VISIBLE rendering of a branch name, for the absence assertion. */
function visibleBranchNameCells(page: Page, branchName: string) {
  return page.getByText(branchName).locator("visible=true");
}

/**
 * The one LOC per $ summary card, located through its canonical label. `:visible`
 * scopes past the keep-alive-hidden Sessions view, which stays mounted (and
 * would otherwise collide in a page-wide match) once it has been visited.
 */
function locPerDollarValue(page: Page) {
  return metricCardValue(page, expectations.locPerDollarLabel);
}

/** One canonical summary card value, located through its shared label. */
function metricCardValue(page: Page, label: string) {
  return page
    .locator(`${CARD_SELECTOR}:visible`)
    .filter({ hasText: label })
    .first()
    .locator(CARD_VALUE_SELECTOR);
}

/** Pin the identity, PR, repository, and canonical activity visible in one row. */
async function assertCanonicalBranchRow(
  page: Page,
  branch: (typeof branches)[keyof typeof branches]
): Promise<void> {
  const row = page
    .locator("div.grid.h-11:visible")
    .filter({ hasText: branch.name })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(
    row.locator(
      `a[href="https://github.com/${repoFullName}/pull/${branch.prNumber}"]`
    )
  ).toHaveText(`${repoFullName}#${branch.prNumber}`);
  await expect(
    row.locator(`a[aria-label="${repoFullName} repository on GitHub"]`)
  ).toBeVisible();
  await expect(row).toContainText(branch.lastActiveLabel);
}

/**
 * Drive the shared date-range control (`packages/app/shared/components/
 * date-range-filter.tsx`) by the option's accessible name. `:visible` scopes to
 * the active Branches toolbar instance.
 */
async function selectDateRange(page: Page, label: string): Promise<void> {
  await page.locator(`[aria-label="${label}"]:visible`).first().click();
}
