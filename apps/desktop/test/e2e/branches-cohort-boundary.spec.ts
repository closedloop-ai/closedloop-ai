/**
 * ISS-5554 / ISS-6061 launched-Electron proof: the real SQLite → main-process
 * cohort projection → IPC → preload → renderer chain remains exact at 100 and
 * 101 filtered Branch IDs. Canonical activity controls newest/tie/unavailable
 * ordering despite poisoned Session timestamps, while distinctive event-time
 * spend proves the renderer consumes the exact producer cohort.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { encodeBranchId } from "@repo/api/src/types/branch.ts";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity.ts";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link.ts";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity.ts";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import { startFakeGitHubAuthorityServer } from "./helpers/fake-github-authority-server";
import {
  seedSessionActivitySegments,
  seedSessionTokenEvents,
  waitForActivitySegmentsSchema,
  waitForActivityTokenEventsSchema,
} from "./helpers/seed-activity-segments";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const CORE_REPOSITORY = "acme/cohort-core";
const EXTRA_REPOSITORY = "acme/cohort-extra";
const EXCLUDED_REPOSITORY = "acme/cohort-excluded";
const CORE_SIZE = 100;
const EXACT_SIZE = 101;
const PRODUCER_SPEND_USD = 7;
const PRODUCER_SPEND_LABEL = `$${PRODUCER_SPEND_USD.toFixed(2)}`;
const CARD_SELECTOR = '[data-slot="card"]:visible';
const CARD_VALUE_SELECTOR = '[data-slot="card-title"]';
const PAGINATION_STATUS_PATTERN = /\bof\s+\d+/;
const REPOSITORY_FACET_PATTERN = /^Repository/;
const EXTRA_REPOSITORY_OPTION_PATTERN = /^cohort-extra\s+1$/;
const SEEDED_BRANCH_NAME_PATTERN = /^feature\/cohort-/;

test("real Desktop IPC keeps canonical cards exact from 100 to 101 filtered branches", async () => {
  test.setTimeout(300_000);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-cohort-boundary-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-cohort-boundary-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-cohort-boundary-udd-")
  );
  const authorityServer = await startFakeGitHubAuthorityServer([
    CORE_REPOSITORY,
    EXTRA_REPOSITORY,
  ]);
  const env = {
    CLAUDE_HOME: claudeHome,
    CODEX_HOME: codexHome,
    ...authorityServer.env,
  };

  try {
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await Promise.all([
        waitForBranchesSchema(userDataDir),
        waitForActivitySegmentsSchema(userDataDir),
        waitForActivityTokenEventsSchema(userDataDir),
      ]);
    } finally {
      await first.cleanup();
    }

    await seedBoundaryCorpus(userDataDir);

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      // The initial deep-linked Repository facet selects exactly 100 rows.
      // No API interception or renderer mock is installed: the cards below can
      // settle only through the production local cohort IPC handler.
      await gotoHash(page, "/branches?repo=acme%2Fcohort-core");
      await expect(
        page.locator("header").getByText("Branches", { exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await page.locator('[aria-label="All time"]:visible').click();
      await expect(paginationStatus(page)).toHaveText(`1–20 of ${CORE_SIZE}`, {
        timeout: 30_000,
      });
      await expect(summaryCardValue(page, "Active branches")).toHaveText(
        String(CORE_SIZE),
        { timeout: 30_000 }
      );
      await assertExactPreloadCohort(page, coreBranchIds());
      await assertRenderedProducerSpend(page);
      await expectVisibleBranchOrder(page, [
        "feature/cohort-core-000",
        "feature/cohort-core-001",
        "feature/cohort-core-002",
      ]);

      // Add the one adjacent repository through the real shared facet control.
      // Repository is a multi-select, so the existing 100 remain selected and
      // the exact pre-pagination cohort crosses the old boundary to 101.
      await page.getByRole("button", { name: "Filter", exact: true }).click();
      await page
        .getByRole("menuitem", { name: REPOSITORY_FACET_PATTERN })
        .click();
      await page
        .getByRole("menuitem", { name: EXTRA_REPOSITORY_OPTION_PATTERN })
        .click();
      await page.keyboard.press("Escape");

      await expect(paginationStatus(page)).toHaveText(`1–20 of ${EXACT_SIZE}`, {
        timeout: 30_000,
      });
      await expect(summaryCardValue(page, "Active branches")).toHaveText(
        String(EXACT_SIZE),
        { timeout: 30_000 }
      );
      await assertExactPreloadCohort(page, exactBranchIds());
      await assertRenderedProducerSpend(page);

      await page.getByLabel("Go to next page").click();
      await expect(paginationStatus(page)).toHaveText(`21–40 of ${EXACT_SIZE}`);
      await expect(summaryCardValue(page, "Active branches")).toHaveText(
        String(EXACT_SIZE)
      );
      await assertRenderedProducerSpend(page);
      for (let pageNumber = 3; pageNumber <= 6; pageNumber += 1) {
        await page.getByLabel("Go to next page").click();
        const firstRow = (pageNumber - 1) * 20 + 1;
        const lastRow = Math.min(pageNumber * 20, EXACT_SIZE);
        await expect(paginationStatus(page)).toHaveText(
          `${firstRow}–${lastRow} of ${EXACT_SIZE}`
        );
      }
      const unavailableRow = page
        .getByRole("region", { name: "Branches" })
        .getByRole("row")
        .filter({ hasText: "feature/cohort-extra" });
      await expect(unavailableRow).toBeVisible();
      await expect(unavailableRow).toContainText("Unavailable");
      await page.screenshot({
        fullPage: true,
        path: test.info().outputPath("branches-cohort-boundary-desktop.png"),
      });
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

async function seedBoundaryCorpus(userDataDir: string): Promise<void> {
  const nowMs = Date.now();
  const poisonedSessionAt = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
  const segment = {
    confidence: 1,
    endMs: nowMs + 60 * 60 * 1000,
    phase: "implement",
    startMs: nowMs - 48 * 60 * 60 * 1000,
  } as const;
  for (let index = 0; index < CORE_SIZE; index += 1) {
    const sessionId = `cohort-core-session-${String(index).padStart(3, "0")}`;
    await seedNoPullRequestBranch(
      userDataDir,
      {
        activityAt: poisonedSessionAt,
        branchName: `feature/cohort-core-${String(index).padStart(3, "0")}`,
        canonicalActivityEvidenceJson: canonicalActivityEvidence(index, nowMs),
        costUsd: 1,
        repoFullName: CORE_REPOSITORY,
        sessionId,
      },
      { branchRelation: ArtifactRefRelation.Created }
    );
    await seedSessionActivitySegments(userDataDir, sessionId, [segment]);
    if (index === 0) {
      await seedSessionTokenEvents(userDataDir, sessionId, [
        {
          costUsd: PRODUCER_SPEND_USD,
          createdAt: canonicalActivityAt(index, nowMs),
          inputTokens: 1,
        },
      ]);
    }
  }
  await seedNoPullRequestBranch(
    userDataDir,
    {
      activityAt: poisonedSessionAt,
      branchName: "feature/cohort-extra",
      costUsd: 1,
      repoFullName: EXTRA_REPOSITORY,
      sessionId: "cohort-extra-session",
    },
    { branchRelation: ArtifactRefRelation.Created }
  );
  await seedSessionActivitySegments(userDataDir, "cohort-extra-session", [
    segment,
  ]);
  await seedNoPullRequestBranch(userDataDir, {
    activityAt: poisonedSessionAt,
    branchName: "feature/cohort-excluded",
    costUsd: 1,
    repoFullName: EXCLUDED_REPOSITORY,
    sessionId: "cohort-excluded-session",
  });
}

function canonicalActivityEvidence(index: number, nowMs: number): string {
  const completeness = BranchActivityEvidenceCompleteness.Complete;
  return JSON.stringify({
    monitoredSessionActivity: {
      completeness,
      events: [
        {
          completeness,
          kind: MonitoredSessionActivityEventKind.AgentAction,
          occurredAt: canonicalActivityAt(index, nowMs),
          sourceEventId: `cohort-canonical-${String(index).padStart(3, "0")}`,
        },
      ],
    },
  });
}

function canonicalActivityAt(index: number, nowMs: number): string {
  const stableOrderIndex = index < 2 ? 0 : index - 1;
  return new Date(
    nowMs - (stableOrderIndex + 1) * 24 * 60 * 60 * 1000
  ).toISOString();
}

async function assertRenderedProducerSpend(
  page: Parameters<typeof gotoHash>[0]
): Promise<void> {
  const value = summaryCardValue(page, "AI spend");
  await expect(value).toHaveText(PRODUCER_SPEND_LABEL, { timeout: 30_000 });
  await expect(
    page.getByText("Couldn't load the summary metrics.", { exact: true })
  ).toHaveCount(0);
}

async function assertExactPreloadCohort(
  page: Parameters<typeof gotoHash>[0],
  branchIds: string[]
): Promise<void> {
  const sortedBranchIds = [...branchIds].sort();
  const response = await page.evaluate((ids) => {
    const desktopApi: CohortAnalyticsDesktopApi = Reflect.get(
      new Object(globalThis.window),
      "desktopApi"
    );
    const cohortAnalytics = desktopApi.branchesApi.cohortAnalytics;
    if (!cohortAnalytics) {
      return null;
    }
    return cohortAnalytics({ branchIds: ids });
  }, sortedBranchIds);

  expect(response?.matchedBranchIds).toEqual(sortedBranchIds);
  expect(response?.canonicalMetrics.cohortSize).toBe(branchIds.length);
  expect(response?.canonicalMetrics.aiSpendUsd.current).toMatchObject({
    value: PRODUCER_SPEND_USD,
  });
}

async function expectVisibleBranchOrder(
  page: Parameters<typeof gotoHash>[0],
  expectedNames: readonly string[]
): Promise<void> {
  const visibleNames = await page
    .getByRole("region", { name: "Branches" })
    .locator('a[href^="#/branches/"]')
    .filter({ hasText: SEEDED_BRANCH_NAME_PATTERN })
    .allTextContents();
  expect(visibleNames.slice(0, expectedNames.length)).toEqual(expectedNames);
}

function coreBranchIds(): string[] {
  return Array.from({ length: CORE_SIZE }, (_, index) =>
    encodeBranchId({
      branchName: `feature/cohort-core-${String(index).padStart(3, "0")}`,
      repoFullName: CORE_REPOSITORY,
    })
  );
}

function exactBranchIds(): string[] {
  return [
    ...coreBranchIds(),
    encodeBranchId({
      branchName: "feature/cohort-extra",
      repoFullName: EXTRA_REPOSITORY,
    }),
  ];
}

function summaryCardValue(page: Parameters<typeof gotoHash>[0], label: string) {
  return page
    .locator(CARD_SELECTOR)
    .filter({ hasText: label })
    .locator(CARD_VALUE_SELECTOR);
}

function paginationStatus(page: Parameters<typeof gotoHash>[0]) {
  return page
    .locator('p[role="status"]')
    .filter({ hasText: PAGINATION_STATUS_PATTERN });
}

type CohortAnalyticsDesktopApi = {
  branchesApi: {
    cohortAnalytics?: (request: { branchIds: string[] }) => Promise<{
      matchedBranchIds: string[];
      canonicalMetrics: {
        aiSpendUsd: { current: { value?: number } };
        cohortSize: number;
      };
    } | null>;
  };
};
