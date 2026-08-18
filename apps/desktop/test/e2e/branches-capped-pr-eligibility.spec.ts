/**
 * ISS-6103 launched-app regression for capped pull-request enrichment.
 *
 * Exercises SQLite through the shipped renderer: capped 3-of-6 PR enrichment,
 * scoped fork uncertainty, and truthful Loading/Unavailable states.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { startFakeGitHubAuthorityServer } from "./helpers/fake-github-authority-server";
import {
  seedNoPullRequestBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

const CORE_REPOSITORY = "acme/iss-6103-capped-core";
const UNAVAILABLE_REPOSITORY = "acme/iss-6103-unavailable";
const DEFAULT_BRANCH = "main";
const UNKNOWN_BRANCH = "feature/iss-6103-unknown-fork";
const KNOWN_BRANCHES = Array.from(
  { length: 6 },
  (_, index) => `feature/iss-6103-known-${String(index + 1).padStart(2, "0")}`
);
const RETURNED_PR_BRANCHES = KNOWN_BRANCHES.slice(0, 3);
const DESKTOP_VIEWPORT = { height: 900, width: 1440 } as const;
const NARROW_VIEWPORT = { height: 760, width: 390 } as const;
const PAGINATION_STATUS_PATTERN = /\bof\s+\d+/;
const FALSE_EMPTY_PAGINATION_PATTERN = /0[–-]0 of 0/;
const FALSE_ZERO_METRIC_PATTERNS = [
  /^\s*\$0(?:[.,]0+)?\s*$/,
  /^\s*0(?:[.,]0+)?(?:\s*LOC\s*\/\s*\$|\s*LOC|%|$)\s*$/i,
] as const;
const PR_COVERAGE_METRIC_CARD_LABELS = [
  "AI spend",
  "LOC per $",
  "Merge rate",
  "Median PR size",
] as const;
const REPOSITORY_FACET_PATTERN = /^Repository/;
const CORE_REPOSITORY_OPTION_PATTERN = /^iss-6103-capped-core\s+6$/;
const KNOWN_BRANCH_LINK_PATTERN = /^feature\/iss-6103-known-\d{2}$/;
const ONE_HOUR_MS = 60 * 60 * 1000;

test.describe("Desktop capped PR eligibility (ISS-6103)", () => {
  test("retains the six known branches through capped hydration", async () => {
    test.setTimeout(240_000);

    const dirs = fixtureDirectories("capped");
    let authorityServer: Awaited<
      ReturnType<typeof startFakeGitHubAuthorityServer>
    > | null = null;
    let launched: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

    try {
      await initializeBranchesSchema(dirs, []);
      await seedCappedCorpus(dirs.userDataDir);

      authorityServer = await startFakeGitHubAuthorityServer(
        [CORE_REPOSITORY],
        {
          branchNamesByRepository: {
            [CORE_REPOSITORY]: [...KNOWN_BRANCHES, UNKNOWN_BRANCH],
          },
          cappedPullRequestBranchesByRepository: {
            [CORE_REPOSITORY]: RETURNED_PR_BRANCHES,
          },
          unavailablePullRequestHeadBranchesByRepository: {
            [CORE_REPOSITORY]: [UNKNOWN_BRANCH],
          },
        }
      );
      launched = await launchDesktopApp({
        env: fixtureEnv(dirs, authorityServer.env),
        keepUserDataDir: true,
        revealWindow: false,
        userDataDir: dirs.userDataDir,
      });

      await gotoNav(launched.page, "branches");
      await assertPopulatedState(
        launched.page,
        DESKTOP_VIEWPORT,
        "branches-capped-populated-desktop.png",
        true
      );
      await assertPopulatedState(
        launched.page,
        NARROW_VIEWPORT,
        "branches-capped-populated-narrow.png",
        false
      );

      const pullRequestPaths = authorityServer.requests.filter((request) =>
        request.includes("/pull-requests")
      );
      expect(pullRequestPaths.length).toBeGreaterThan(0);
      expect(new Set(pullRequestPaths)).toEqual(
        new Set([
          "/integrations/github/repositories/desktop-e2e-repository-0/pull-requests?limit=100",
        ])
      );
      expect(launched.pageErrors).toEqual([]);

      // Add a locally published same-base candidate whose returned PR reports
      // its exact fork head unavailable. Its successful push keeps it visible,
      // while PR-derived aggregate coverage remains unavailable.
      await launched.cleanup();
      launched = null;
      await seedBranch(dirs.userDataDir, {
        branchName: UNKNOWN_BRANCH,
        repoFullName: CORE_REPOSITORY,
        sessionId: "iss-6103-unknown-session",
      });
      launched = await launchDesktopApp({
        env: fixtureEnv(dirs, authorityServer.env),
        keepUserDataDir: true,
        revealWindow: false,
        userDataDir: dirs.userDataDir,
      });
      await gotoNav(launched.page, "branches");
      await assertCandidateScopedUnknownState(
        launched.page,
        DESKTOP_VIEWPORT,
        "branches-capped-candidate-unknown-desktop.png"
      );
      await assertCandidateScopedUnknownState(
        launched.page,
        NARROW_VIEWPORT,
        "branches-capped-candidate-unknown-narrow.png"
      );
      expect(launched.pageErrors).toEqual([]);
    } finally {
      await launched?.cleanup();
      await authorityServer?.close();
      removeFixtureDirectories(dirs);
    }
  });

  test("renders settled unavailable authority without an empty or zero claim", async () => {
    test.setTimeout(180_000);

    const dirs = fixtureDirectories("unavailable");
    let authorityServer: Awaited<
      ReturnType<typeof startFakeGitHubAuthorityServer>
    > | null = null;
    let launched: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

    try {
      await initializeBranchesSchema(dirs, []);
      await seedBranch(dirs.userDataDir, {
        branchName: UNKNOWN_BRANCH,
        repoFullName: UNAVAILABLE_REPOSITORY,
        sessionId: "iss-6103-unavailable-session",
      });
      authorityServer = await startFakeGitHubAuthorityServer([]);
      launched = await launchDesktopApp({
        env: fixtureEnv(dirs, authorityServer.env),
        keepUserDataDir: true,
        revealWindow: false,
        userDataDir: dirs.userDataDir,
      });

      await gotoNav(launched.page, "branches");
      await assertUnavailableState(
        launched.page,
        DESKTOP_VIEWPORT,
        "branches-capped-unavailable-desktop.png"
      );
      await assertUnavailableState(
        launched.page,
        NARROW_VIEWPORT,
        "branches-capped-unavailable-narrow.png"
      );
      expect(launched.pageErrors).toEqual([]);
    } finally {
      await launched?.cleanup();
      await authorityServer?.close();
      removeFixtureDirectories(dirs);
    }
  });
});

async function initializeBranchesSchema(
  dirs: FixtureDirectories,
  repositories: readonly string[]
): Promise<void> {
  const authorityServer = await startFakeGitHubAuthorityServer(repositories);
  let launched: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    launched = await launchDesktopApp({
      env: fixtureEnv(dirs, authorityServer.env),
      keepUserDataDir: true,
      revealWindow: false,
      userDataDir: dirs.userDataDir,
    });
    await waitForBranchesSchema(dirs.userDataDir);
  } finally {
    await launched?.cleanup();
    await authorityServer.close();
  }
}

async function seedCappedCorpus(userDataDir: string): Promise<void> {
  for (const [index, branchName] of KNOWN_BRANCHES.entries()) {
    await seedBranch(userDataDir, {
      branchName,
      repoFullName: CORE_REPOSITORY,
      sessionId: `iss-6103-known-session-${index + 1}`,
    });
  }
  await seedBranch(userDataDir, {
    branchName: DEFAULT_BRANCH,
    repoFullName: CORE_REPOSITORY,
    sessionId: "iss-6103-default-session",
  });
}

async function seedBranch(
  userDataDir: string,
  identity: {
    branchName: string;
    repoFullName: string;
    sessionId: string;
  }
): Promise<void> {
  await seedNoPullRequestBranch(userDataDir, {
    ...identity,
    activityAt: new Date(Date.now() - ONE_HOUR_MS).toISOString(),
  });
}

async function assertUnavailableState(
  page: Page,
  viewport: Readonly<{ height: number; width: number }>,
  screenshotName: string
): Promise<void> {
  await page.setViewportSize(viewport);
  await expect(
    page.getByText("Couldn't load branches", { exact: true })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText("Loading branches…", { exact: true })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await assertNoFalseEmptyOrZero(page);
  await assertCompletePageWidth(page);
  await captureStateScreenshots(page, screenshotName, true);
}

async function assertPopulatedState(
  page: Page,
  viewport: Readonly<{ height: number; width: number }>,
  screenshotName: string,
  exerciseControls: boolean
): Promise<void> {
  await page.setViewportSize(viewport);
  const table = page.getByRole("table");
  await expect(table).toBeVisible({ timeout: 30_000 });
  await expect(paginationStatus(page)).toHaveText("1–6 of 6", {
    timeout: 30_000,
  });
  await expect(summaryCardValue(page, "Active branches")).toHaveText("6", {
    timeout: 30_000,
  });
  await expect(branchLinks(table)).toHaveCount(KNOWN_BRANCHES.length);
  for (const branchName of KNOWN_BRANCHES) {
    await expect(
      table.getByRole("link", { exact: true, name: branchName })
    ).toBeVisible();
  }
  await expect(
    table.getByRole("link", { exact: true, name: DEFAULT_BRANCH })
  ).toHaveCount(0);
  await expect(
    table.getByRole("link", { exact: true, name: UNKNOWN_BRANCH })
  ).toHaveCount(0);
  await assertPullRequestCoverage(table);
  await expect(page.getByText("No branches yet", { exact: true })).toHaveCount(
    0
  );
  await expect(
    page.getByText("Couldn't load branches", { exact: true })
  ).toHaveCount(0);

  if (exerciseControls) {
    await assertSortAndFacetCohort(page, table);
  }
  await assertCompletePageWidth(page);
  await captureStateScreenshots(page, screenshotName, true);
}

async function assertCandidateScopedUnknownState(
  page: Page,
  viewport: Readonly<{ height: number; width: number }>,
  screenshotName: string
): Promise<void> {
  await page.setViewportSize(viewport);
  const table = page.getByRole("table");
  await expect(table).toBeVisible({ timeout: 30_000 });
  await expect(paginationStatus(page)).toHaveText("1–7 of 7", {
    timeout: 30_000,
  });
  await expect(branchLinks(table)).toHaveCount(KNOWN_BRANCHES.length);
  await expect(
    table.getByRole("link", { exact: true, name: UNKNOWN_BRANCH })
  ).toBeVisible();
  await expect(
    table.getByRole("link", { exact: true, name: DEFAULT_BRANCH })
  ).toHaveCount(0);
  await expect(summaryCardValue(page, "Active branches")).toHaveText("7", {
    timeout: 30_000,
  });
  await expect(summaryCard(page, "Active branches")).not.toContainText(
    "Unavailable"
  );
  for (const label of PR_COVERAGE_METRIC_CARD_LABELS) {
    await expect(summaryCardValue(page, label)).toHaveText("—", {
      timeout: 30_000,
    });
    await expect(summaryCard(page, label)).toContainText("Unavailable");
  }
  await assertPullRequestCoverage(table);
  await expect(page.getByText("No branches yet", { exact: true })).toHaveCount(
    0
  );
  await expect(
    page.getByText("Couldn't load branches", { exact: true })
  ).toHaveCount(0);
  await assertCompletePageWidth(page);
  await captureStateScreenshots(page, screenshotName, true);
}

async function assertPullRequestCoverage(
  table: ReturnType<Page["getByRole"]>
): Promise<void> {
  for (const branchName of RETURNED_PR_BRANCHES) {
    const row = table.getByRole("row").filter({ hasText: branchName });
    await expect(row.locator('a[href*="/pull/"]')).toHaveCount(1);
  }
  for (const branchName of KNOWN_BRANCHES.slice(RETURNED_PR_BRANCHES.length)) {
    const row = table.getByRole("row").filter({ hasText: branchName });
    await expect(row.locator('a[href*="/pull/"]')).toHaveCount(0);
  }
}

async function assertSortAndFacetCohort(
  page: Page,
  table: ReturnType<Page["getByRole"]>
): Promise<void> {
  const nameHeader = table.getByRole("columnheader", { name: "Name" });
  const nameSort = nameHeader.getByRole("button", {
    exact: true,
    name: "Name",
  });
  await nameSort.click();
  await expect(nameHeader).toHaveAttribute("aria-sort", "descending");
  await nameSort.click();
  await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(branchLinks(table)).toHaveText(KNOWN_BRANCHES);

  await page.getByRole("button", { exact: true, name: "Filter" }).click();
  await page.getByRole("menuitem", { name: REPOSITORY_FACET_PATTERN }).click();
  await page
    .getByRole("menuitem", { name: CORE_REPOSITORY_OPTION_PATTERN })
    .click();
  await page.keyboard.press("Escape");
  await expect(paginationStatus(page)).toHaveText("1–6 of 6");
  await expect(summaryCardValue(page, "Active branches")).toHaveText("6");
}

async function assertNoFalseEmptyOrZero(page: Page): Promise<void> {
  await expect(page.getByText("No branches yet", { exact: true })).toHaveCount(
    0
  );
  await expect(page.getByText(FALSE_EMPTY_PAGINATION_PATTERN)).toHaveCount(0);
  const cardValues = await page
    .locator('[data-slot="card-title"]:visible')
    .allTextContents();
  for (const value of cardValues) {
    expect(
      FALSE_ZERO_METRIC_PATTERNS.some((pattern) => pattern.test(value))
    ).toBe(false);
  }
}

async function assertCompletePageWidth(page: Page): Promise<void> {
  const fitsViewport = await page.evaluate(
    () => document.documentElement.scrollWidth <= globalThis.innerWidth + 1
  );
  expect(fitsViewport).toBe(true);
}

async function captureStateScreenshots(
  page: Page,
  screenshotName: string,
  includeScrollRegion: boolean
): Promise<void> {
  await page.screenshot({
    fullPage: true,
    path: test.info().outputPath(screenshotName),
  });
  if (includeScrollRegion) {
    await page.getByRole("region", { name: "Branches" }).screenshot({
      path: test
        .info()
        .outputPath(screenshotName.replace(".png", "-scroll-region.png")),
    });
  }
}

function branchLinks(table: ReturnType<Page["getByRole"]>) {
  return table.getByRole("link", { name: KNOWN_BRANCH_LINK_PATTERN });
}

function summaryCardValue(page: Page, label: string) {
  return summaryCard(page, label).locator('[data-slot="card-title"]');
}

function summaryCard(page: Page, label: string) {
  return page.locator('[data-slot="card"]:visible').filter({ hasText: label });
}

function paginationStatus(page: Page) {
  return page
    .locator('p[role="status"]:visible')
    .filter({ hasText: PAGINATION_STATUS_PATTERN });
}

function fixtureDirectories(label: string): FixtureDirectories {
  return {
    claudeHome: fs.mkdtempSync(
      path.join(os.tmpdir(), `iss-6103-${label}-claude-`)
    ),
    codexHome: fs.mkdtempSync(
      path.join(os.tmpdir(), `iss-6103-${label}-codex-`)
    ),
    userDataDir: fs.mkdtempSync(
      path.join(os.tmpdir(), `iss-6103-${label}-udd-`)
    ),
  };
}

function fixtureEnv(
  dirs: FixtureDirectories,
  serverEnv: Readonly<Record<string, string>>
): Record<string, string> {
  return {
    CLAUDE_HOME: dirs.claudeHome,
    CODEX_HOME: dirs.codexHome,
    ...serverEnv,
  };
}

function removeFixtureDirectories(dirs: FixtureDirectories): void {
  fs.rmSync(dirs.userDataDir, { force: true, recursive: true });
  fs.rmSync(dirs.claudeHome, { force: true, recursive: true });
  fs.rmSync(dirs.codexHome, { force: true, recursive: true });
}

type FixtureDirectories = {
  claudeHome: string;
  codexHome: string;
  userDataDir: string;
};
