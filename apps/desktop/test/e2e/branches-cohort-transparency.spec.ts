import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity.ts";
import { BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY } from "@repo/api/src/types/branches-cohort-transparency-flag.ts";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity.ts";
import {
  DesktopDateRangeLabel,
  gotoNav,
  launchDesktopApp,
  seedDesktopFeatureFlags,
  selectDesktopDateRange,
} from "./helpers/desktop-app";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const REPOSITORY = "acme/cohort-transparency";
/**
 * ISS-8909: one row past a FULL page, where a page is the shared
 * `DEFAULT_TABLE_PAGE_SIZE` of 25 now that the v1 Branches host's fixed page of
 * 20 is retired. The claim is unchanged — the cohort spans two pages and the
 * last row on each carries an unavailable Last-active — but 21 rows no longer
 * spans two pages at all, so the corpus is re-based rather than the assertion
 * weakened.
 */
const BRANCH_COUNT = 26;
const CARD_SELECTOR = '[data-slot="card"]:visible';
const CARD_VALUE_SELECTOR = '[data-slot="card-title"]';
/** `MetricCard`'s dash for a card that keeps its own Unavailable caption. */
const UNAVAILABLE_VALUE_TEXT = "—";

test("real Desktop IPC retains unavailable Last-active rows without the page warning", async () => {
  test.setTimeout(300_000);
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-7090-claude-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "iss-7090-codex-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iss-7090-udd-"));
  const env = {
    CLAUDE_HOME: claudeHome,
    CODEX_HOME: codexHome,
  };

  try {
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedCohort(userDataDir);
    const launched = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
      beforeLaunch: (dir) =>
        seedDesktopFeatureFlags(dir, {
          [BRANCHES_COHORT_TRANSPARENCY_FLAG_KEY]: true,
        }),
    });
    try {
      await gotoNav(launched.page, "branches");
      await selectDesktopDateRange(
        launched.page,
        DesktopDateRangeLabel.Last7Days
      );
      await expect(
        launched.page.getByText("1–25 of 26", { exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        launched.page.getByText(
          "Last active breakdown is incomplete for Last 7 days",
          { exact: true }
        )
      ).toHaveCount(0);
      await expect(
        launched.page.getByText("26 Branches in Last 7 days", { exact: true })
      ).toHaveCount(0);
      await expect(
        summaryCardValue(launched.page, "Active branches")
      ).toHaveText(UNAVAILABLE_VALUE_TEXT);
      await expect(
        visibleBranchName(launched.page, "feature/iss-7090-24")
      ).toBeVisible();
      await expect(
        branchRow(launched.page, "feature/iss-7090-24")
      ).toContainText("Unavailable");
      await expect(
        visibleBranchName(launched.page, "feature/iss-7090-25")
      ).not.toBeVisible();
      await launched.page
        .locator('[data-slot="pagination-link"][aria-label="Go to next page"]')
        .click();
      await expect(
        visibleBranchName(launched.page, "feature/iss-7090-25")
      ).toBeVisible();
      await expect(
        branchRow(launched.page, "feature/iss-7090-25")
      ).toContainText("Unavailable");
      await expect(
        launched.page.getByText("26–26 of 26", { exact: true })
      ).toBeVisible();
      expect(launched.pageErrors).toEqual([]);
    } finally {
      await launched.cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

async function seedCohort(userDataDir: string) {
  const now = Date.now();
  const recent = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const future = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  for (let index = 0; index < BRANCH_COUNT; index += 1) {
    const activityAt = index >= BRANCH_COUNT - 2 ? future : recent;
    await seedNoPullRequestBranch(userDataDir, {
      repoFullName: REPOSITORY,
      branchName: `feature/iss-7090-${index}`,
      sessionId: `iss-7090-session-${index}`,
      activityAt,
      canonicalActivityEvidenceJson: canonicalActivityEvidence(
        activityAt,
        index
      ),
    });
  }
}

function canonicalActivityEvidence(occurredAt: string, index: number): string {
  const completeness = BranchActivityEvidenceCompleteness.Complete;
  return JSON.stringify({
    monitoredSessionActivity: {
      completeness,
      events: [
        {
          completeness,
          kind: MonitoredSessionActivityEventKind.AgentAction,
          occurredAt,
          sourceEventId: `iss-7090-canonical-${index}`,
        },
      ],
    },
  });
}

function summaryCardValue(page: Page, label: string) {
  return page
    .locator(CARD_SELECTOR)
    .filter({ hasText: label })
    .locator(CARD_VALUE_SELECTOR);
}

function branchRow(page: Page, branchName: string) {
  return page.getByRole("row").filter({ hasText: branchName });
}

/**
 * The branch name as the Branches table shows it, and only there.
 *
 * Visited views stay mounted-but-hidden, and Dashboard — the canonical landing,
 * so always the first view mounted — renders a Recent Sessions grid whose
 * "Linked branches" cell prints these same names in the same
 * `span.truncate.font-mono`. Unscoped, the presence assertions are a strict-mode
 * violation against that hidden copy, and the absence assertion would be
 * satisfied by it for the wrong reason. A hidden view can never match
 * `visible=true`, so paging a branch into view is still the only thing that can
 * flip this one.
 */
function visibleBranchName(page: Page, branchName: string) {
  return page.getByText(branchName, { exact: true }).locator("visible=true");
}
