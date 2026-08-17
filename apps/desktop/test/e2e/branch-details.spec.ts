/**
 * ISS-4473: launched-app coverage for the default-on shared Branch Details UI.
 *
 * The local-IPC lane proves the packaged renderer → preload → main → SQLite
 * path and honest degraded states. The authenticated-cloud lane separately
 * proves the signed-in shared Branch Details rendering and HTTP/Bearer path.
 *
 * Prerequisite: `pnpm -C apps/desktop build`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import axe from "axe-core";
import {
  ACTIVE_COMMENT,
  HISTORICAL_COMMENT,
  PROVIDER_BODY_DISCLOSURE,
  PROVIDER_OMITTED_DISCLOSURE,
  PROVIDER_REPLY_AUTHOR,
  PROVIDER_ROOT_AUTHOR,
} from "../../../../e2e/helpers/branch-details-comprehensive-comments-trace";
import {
  ACTIVE_DESCRIPTION,
  ACTIVE_PR,
  BRANCH_ID,
  HISTORICAL_PR,
  PR_BODY_AUTOMATION_MARKER,
  REPOSITORY,
  withCompleteEmptyLinkedArtifacts,
  withUnavailableEmptyLinkedArtifacts,
} from "../../../../e2e/helpers/branch-details-comprehensive-data";
import { expectWcagAaClean } from "../../../../e2e/helpers/critical-wcag-aa";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../src/shared/contracts.js";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  isAuthenticatedBranchRequest,
  launchAuthenticatedDesktopApp,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  gotoNav,
  launchDesktopApp,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { startFakeGitHubAuthorityServer } from "./helpers/fake-github-authority-server";
import {
  type BranchDetailsSeed,
  seedBranchDetails,
} from "./helpers/seed-branch-details-db";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

const NARROW_VIEWPORT = { height: 844, width: 390 };
const MERGED_PULL_REQUEST_OPTION = /#4473.*Merged/;
const ACTIVE_PULL_REQUEST_OPTION = new RegExp(`#${ACTIVE_PR}.*Open`);
const RAN_ONE_TOOL = /Ran 1 tool/;
const REFRESH_NAME = /refresh/i;
const SCREEN_READER_ONLY_CLASS = /sr-only/;
const CLAMPED_CLASS_PATTERN = /clamped/;
const SINGULAR_FILE_COUNT_PATTERN = /\b1 file\b/;
const TIMING_DISCLOSURE = /Timing is unavailable for session-rework/;
const TIMELINE_AXE_SCOPE = "section.bq-act";
const REVIEW_COMMENT_METADATA = /Review comment · Unresolved/;
const REVIEW_REPLY_METADATA = /Review reply · Resolved/;
const REVIEW_COMMENT_LINK = /review comment.*GitHub/i;
const REVIEW_REPLY_LINK = /review reply.*GitHub/i;
const ISSUE_COMMENT_LINK = /issue comment.*GitHub/i;
const GITHUB_LINK = /GitHub/i;
const PROVIDER_MUTATION_ACTION =
  /create|reply|edit|delete|react|resolve|unresolve|jump to (file|line)|file anchor/i;

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged; a type alias cannot augment it.
  interface Window {
    desktopApi: {
      getDesktopAuthState: () => Promise<DesktopAuthState>;
    };
  }
}
const SEED: BranchDetailsSeed = {
  repoFullName: "closedloop-ai/symphony-alpha",
  branchName: "feat/fea-4473-comprehensive-branch-details",
  sessionId: "iss-4473-branch-details-session",
  mergedPullRequest: {
    number: 4473,
    title: "Ship the historical Branch Details foundation",
    mergedAt: "2026-08-04T15:00:00.000Z",
    additions: 180,
    deletions: 40,
    filesChanged: 8,
  },
  activePullRequest: {
    number: 4474,
    title: "Complete the active Branch Details review",
    openedAt: "2026-08-05T16:00:00.000Z",
    additions: 72,
    deletions: 12,
    filesChanged: 4,
  },
};

test.describe("Branch Details", () => {
  test("renders the default-on local route truthfully and remains usable at 390px", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-udd-")
    );
    const authorityServer = await startFakeGitHubAuthorityServer([
      SEED.repoFullName,
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

      await seedBranchDetails(userDataDir, SEED);

      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env,
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await openSeededBranch(page);
        await expectBranchIdentityAndForbiddenChrome(page);

        const pullRequestSelector = page.getByRole("combobox", {
          name: "Pull request",
        });
        await expect(pullRequestSelector).toContainText("#4474");
        const activePullRequestRegion = page.getByRole("region", {
          name: "Branch and pull request #4474 evidence",
        });
        await expect(activePullRequestRegion).toBeVisible();
        await expect(
          activePullRequestRegion.getByText(SEED.activePullRequest.title, {
            exact: true,
          })
        ).toBeVisible();

        await expectMetricAndLocalEvidence(page, 4474);
        await expectWcagAaClean(page, axe.source, { criticalOnly: true });
        await expectUnavailableLocalComments(page);

        await pullRequestSelector.click();
        await page
          .getByRole("option", { name: MERGED_PULL_REQUEST_OPTION })
          .click();
        await expect(pullRequestSelector).toContainText("#4473");
        const mergedPullRequestRegion = page.getByRole("region", {
          name: "Branch and pull request #4473 evidence",
        });
        await expect(mergedPullRequestRegion).toBeVisible();
        await expect(
          mergedPullRequestRegion.getByText(SEED.mergedPullRequest.title, {
            exact: true,
          })
        ).toBeVisible();
        await expectMetricAndLocalEvidence(page, 4473);

        await page.getByRole("tab", { name: "Sessions & timeline" }).click();
        await expect(
          page.getByText("PR timeline", { exact: false })
        ).toBeVisible();
        await expect(
          page.getByText("Combined session trace", { exact: false })
        ).toBeVisible();
        await page.getByRole("button", { name: RAN_ONE_TOOL }).click();
        await expect(
          page.getByText("Seeded substantive tool invocation")
        ).toBeVisible();
        await expect(page.getByText("Lanes", { exact: true })).toHaveCount(0);
        await expectWcagAaClean(page, axe.source, { criticalOnly: true });

        await page.setViewportSize(NARROW_VIEWPORT);
        await expectNoHorizontalOverflow(page);

        await page.getByRole("tab", { name: "Branch details" }).click();
        const commentsToggle = page.locator(
          'button[aria-controls="branch-comments-workspace"]'
        );
        await expect(commentsToggle).toHaveAccessibleName("Show comments rail");
        await expect(commentsToggle).toHaveAttribute("aria-expanded", "false");
        await expect(commentsToggle).toHaveAttribute(
          "aria-controls",
          "branch-comments-workspace"
        );
        await commentsToggle.click();
        await expect(commentsToggle).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByRole("dialog")).toBeVisible();
        await expectWcagAaClean(page, axe.source, { criticalOnly: true });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(commentsToggle).toHaveAccessibleName("Show comments rail");
        await expect(commentsToggle).toBeFocused();

        await pullRequestSelector.scrollIntoViewIfNeeded();
        await pullRequestSelector.focus();
        await expect(pullRequestSelector).toBeFocused();
        await pullRequestSelector.press("Enter");
        await expect(page.getByRole("listbox")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(pullRequestSelector).toBeFocused();
        await expectNoHorizontalOverflow(page);

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

  test("scans the authenticated cloud Branch Details path at desktop and narrow widths", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-cloud-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-cloud-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "branch-details-cloud-udd-")
    );
    const server = await startAuthenticatedBranchCloudServer({
      detailProjector: (detail) =>
        detail.prNumber === ACTIVE_PR
          ? withUnavailableEmptyLinkedArtifacts(detail)
          : withCompleteEmptyLinkedArtifacts(detail),
      timingIncomplete: true,
    });

    try {
      const sessionSeedLaunch = await launchAuthenticatedDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        userDataDir,
      });
      try {
        await seedAuthenticatedDesktopSession(
          sessionSeedLaunch.app,
          userDataDir
        );
      } finally {
        await sessionSeedLaunch.cleanup();
      }

      const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp(
        {
          // ISS-5714: authentication alone no longer puts Branches on the cloud
          // — the cutover must first establish that the cloud HOLDS this
          // machine's history, or a still-uploading device would render an empty
          // workspace beside a populated Sessions page. This spec asserts the
          // authenticated CLOUD Branch Details path, so it owes that
          // precondition explicitly instead of inheriting it from whatever the
          // burn-down sampler happens not to have measured yet.
          cloudReadReadiness: drainedCloudReadReadiness(),
          beforeLaunch: (launchUserDataDir) => {
            seedDesktopSettings(launchUserDataDir, {
              activeConfigId: "branch-details-cloud-profile",
              apiOrigin: server.origin,
              cloudConnectionEnabled: true,
              savedConfigs: [
                {
                  apiOrigin: server.origin,
                  gatewayId: AUTHENTICATED_GATEWAY_ID,
                  id: "branch-details-cloud-profile",
                  name: "Branch Details Cloud E2E",
                  relayOrigin: "http://127.0.0.1:9",
                  webAppOrigin: "http://127.0.0.1:3000",
                },
              ],
            });
          },
          env: {
            CLAUDE_HOME: claudeHome,
            CL_AUTH_API_ORIGIN: server.origin,
            CODEX_HOME: codexHome,
          },
          userDataDir,
        }
      );
      try {
        await expect
          .poll(() =>
            page.evaluate(() => window.desktopApi.getDesktopAuthState())
          )
          .toMatchObject({
            organizationId: AUTHENTICATED_ORGANIZATION_ID,
            status: DesktopAuthStatus.Authenticated,
            userId: AUTHENTICATED_USER_ID,
          });
        await gotoHash(page, `/branches/${BRANCH_ID}`);
        await expect(
          page.getByRole("combobox", { name: "Pull request" })
        ).toBeVisible({ timeout: 30_000 });
        await expectAuthenticatedPrDescription(page);
        await expectUnavailableEmptyLinkedArtifacts(page, ACTIVE_PR);
        const activeRegion = page.getByRole("region", {
          name: `Branch and pull request #${ACTIVE_PR} evidence`,
        });
        await expect(
          activeRegion.getByText(SINGULAR_FILE_COUNT_PATTERN)
        ).toBeVisible();
        const commentsRail = page.getByRole("region", {
          name: "Branch comments",
        });
        await expect(commentsRail).toBeVisible();
        await expect(commentsRail.getByText(ACTIVE_COMMENT)).toBeVisible();
        await expectProviderProvenance(commentsRail);
        await expectProviderViewOnly(commentsRail);
        await expect(commentsRail).not.toContainText("<sub>");
        await expect(commentsRail).not.toContainText("</sub>");
        await expect(commentsRail).not.toContainText("<sup>");
        await expect(commentsRail).not.toContainText("</sup>");
        await page.getByRole("combobox", { name: "Pull request" }).click();
        await page
          .getByRole("option", {
            name: new RegExp(`#${HISTORICAL_PR}.*Merged`),
          })
          .click();
        const historicalRegion = page.getByRole("region", {
          name: `Branch and pull request #${HISTORICAL_PR} evidence`,
        });
        const leadTimeCard = historicalRegion.locator('[data-slot="card"]', {
          hasText: "Lead time for change",
        });
        await expect(
          leadTimeCard.getByText("3d 20h", { exact: true })
        ).toBeVisible();
        await expect(commentsRail.getByText(HISTORICAL_COMMENT)).toBeVisible();
        await expectCompleteEmptyLinkedArtifacts(page, HISTORICAL_PR);
        await expect(commentsRail.getByText(ACTIVE_COMMENT)).toHaveCount(0);
        await expect(
          commentsRail.getByRole("link", { name: ISSUE_COMMENT_LINK })
        ).toHaveAttribute(
          "href",
          `https://github.com/${REPOSITORY}/pull/${HISTORICAL_PR}#discussion_r${HISTORICAL_PR}1`
        );
        await expectWcagAaClean(page, axe.source, { criticalOnly: true });

        await page.getByRole("tab", { name: "Sessions & timeline" }).click();
        await expect(commentsRail.getByText(HISTORICAL_COMMENT)).toHaveCount(0);
        await expect(commentsRail.getByText(PROVIDER_ROOT_AUTHOR)).toHaveCount(
          0
        );
        await expect(
          commentsRail.getByText(PROVIDER_OMITTED_DISCLOSURE)
        ).toHaveCount(0);
        await expect(
          commentsRail.getByRole("link", { name: GITHUB_LINK })
        ).toHaveCount(0);
        await expect(page.getByText("Combined session trace")).toBeVisible();
        const timeline = page.locator("section.bq-act", {
          hasText: "PR timeline",
        });
        const chartableCost = timeline.getByText("$16.00*", { exact: true });
        await expect(chartableCost).toBeVisible();
        await expect(chartableCost).toHaveAccessibleDescription(
          TIMING_DISCLOSURE
        );
        await expect(timeline.getByText("6.67", { exact: true })).toBeVisible();
        await expect(
          timeline.getByText("60m 0s*", { exact: true })
        ).toHaveAccessibleDescription(TIMING_DISCLOSURE);
        await expect(timeline.getByText(TIMING_DISCLOSURE)).toBeVisible();
        await expect(timeline.getByText("$48.00", { exact: true })).toHaveCount(
          0
        );
        await expectWcagAaClean(page, axe.source, {
          scope: TIMELINE_AXE_SCOPE,
        });

        await page.getByRole("button", { name: "Hide comments rail" }).click();

        await page.setViewportSize(NARROW_VIEWPORT);
        await expect(chartableCost).toBeVisible();
        await expect(timeline.getByText(TIMING_DISCLOSURE)).toBeVisible();
        await expect(timeline.getByText("$48.00", { exact: true })).toHaveCount(
          0
        );
        await expectNoHorizontalOverflow(page);
        await expect(chartableCost).toHaveAccessibleDescription(
          TIMING_DISCLOSURE
        );
        await expectWcagAaClean(page, axe.source, {
          scope: TIMELINE_AXE_SCOPE,
        });
        await page.getByRole("tab", { name: "Branch details" }).click();
        await page.getByRole("combobox", { name: "Pull request" }).click();
        await page
          .getByRole("option", { name: ACTIVE_PULL_REQUEST_OPTION })
          .click();
        await expectAuthenticatedPrDescription(page);
        await expectNoHorizontalOverflow(page);
        await page.getByRole("button", { name: "Show comments rail" }).click();
        const commentsDialog = page.getByRole("dialog", { name: "Comments" });
        await expect(commentsDialog).toBeVisible();
        await expectProviderProvenance(commentsDialog);
        await expectProviderViewOnly(commentsDialog);
        await expectWcagAaClean(page, axe.source, { criticalOnly: true });

        await expect
          .poll(
            () => server.requests.filter(isAuthenticatedBranchRequest).length,
            {
              message:
                "Branch cloud reads should use the restored session token",
            }
          )
          .toBeGreaterThanOrEqual(4);
        const providerRequests = server.requests.filter(
          (request) => request.pathname === `/branches/${BRANCH_ID}/comments`
        );
        expect(providerRequests.length).toBeGreaterThanOrEqual(2);
        expect(
          providerRequests.every(
            (request) =>
              request.authorization === `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
          )
        ).toBe(true);
        const unauthorizedProviderResponse = await fetch(
          `${server.origin}/branches/${BRANCH_ID}/comments?repositoryFullName=${REPOSITORY}&pullRequestNumber=${ACTIVE_PR}`
        );
        expect(unauthorizedProviderResponse.status).toBe(401);
        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      await server.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
      fs.rmSync(claudeHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

async function expectCompleteEmptyLinkedArtifacts(
  page: Page,
  pullRequestNumber: number
): Promise<void> {
  const deliveredRegion = page.locator("section.bq-ctx").filter({
    has: page.getByText("What was delivered", { exact: true }),
  });
  await expect(
    deliveredRegion.getByText("No linked artifacts.", { exact: true })
  ).toBeVisible();
  await expect(
    deliveredRegion.getByText("Linked artifacts are unavailable.", {
      exact: true,
    })
  ).toHaveCount(0);
  const selectedPullRequest = deliveredRegion.locator(".bq-ctx-pr");
  await expect(
    selectedPullRequest.getByText(`#${pullRequestNumber}`, { exact: true })
  ).toBeVisible();
  await expect(selectedPullRequest.getByRole("link")).toHaveAttribute(
    "href",
    `https://github.com/${REPOSITORY}/pull/${pullRequestNumber}`
  );
}

async function expectUnavailableEmptyLinkedArtifacts(
  page: Page,
  pullRequestNumber: number
): Promise<void> {
  const deliveredRegion = page.locator("section.bq-ctx").filter({
    has: page.getByText("What was delivered", { exact: true }),
  });
  await expect(
    deliveredRegion.getByText("Linked artifacts are unavailable.", {
      exact: true,
    })
  ).toBeVisible();
  await expect(
    deliveredRegion.getByText("No linked artifacts.", { exact: true })
  ).toHaveCount(0);
  await expect(
    deliveredRegion.getByText(
      "Linked artifact completeness could not be verified.",
      { exact: true }
    )
  ).toHaveCount(0);
  await expect(
    deliveredRegion.locator(".bq-ctx-pr").getByText(`#${pullRequestNumber}`, {
      exact: true,
    })
  ).toBeVisible();
}

async function openSeededBranch(page: Page): Promise<void> {
  await gotoNav(page, "branches");
  await expect(
    page.locator("header").getByText("Branches", { exact: true })
  ).toBeVisible({ timeout: 30_000 });
  const allTime = page.locator('[aria-label="All time"]:visible').first();
  if (await allTime.isVisible()) {
    await allTime.click();
  }
  const branchLink = page
    .locator('a[href^="#/branches/"]')
    .filter({ hasText: SEED.branchName });
  await expect(branchLink).toBeVisible({ timeout: 30_000 });
  await branchLink.click();
  await expect(
    page.locator("header").getByText(SEED.branchName, { exact: true })
  ).toBeVisible({ timeout: 30_000 });
}

async function expectProviderProvenance(comments: Locator): Promise<void> {
  await expect(
    comments.getByRole("heading", { name: "PR Comments 2 shown" })
  ).toBeVisible();
  await expect(comments.getByText(PROVIDER_ROOT_AUTHOR)).toBeVisible();
  await expect(comments.getByText(PROVIDER_REPLY_AUTHOR)).toBeVisible();
  await expect(comments.getByText(PROVIDER_OMITTED_DISCLOSURE)).toBeVisible();
  await expect(comments.getByText(PROVIDER_BODY_DISCLOSURE)).toBeVisible();
  await expect(comments.getByText(REVIEW_COMMENT_METADATA)).toBeVisible();
  await expect(comments.getByText(REVIEW_REPLY_METADATA)).toBeVisible();
  await expect(
    comments.getByText("Stale · Body truncated", { exact: true })
  ).toHaveCount(2);
  const rootLink = comments.getByRole("link", { name: REVIEW_COMMENT_LINK });
  const replyLink = comments.getByRole("link", { name: REVIEW_REPLY_LINK });
  await expect(rootLink).toHaveAttribute(
    "href",
    `https://github.com/${REPOSITORY}/pull/${ACTIVE_PR}#discussion_r${ACTIVE_PR}1`
  );
  await expect(replyLink).toHaveAttribute(
    "href",
    `https://github.com/${REPOSITORY}/pull/${ACTIVE_PR}#discussion_r${ACTIVE_PR}2`
  );
  await rootLink.focus();
  await expect(rootLink).toBeFocused();
  await replyLink.focus();
  await expect(replyLink).toBeFocused();
}

async function expectProviderViewOnly(comments: Locator): Promise<void> {
  const providerThreads = comments.getByTestId("provider-comment-thread");
  await expect(providerThreads).toHaveCount(1);
  await expect(
    providerThreads.getByRole("button", { name: PROVIDER_MUTATION_ACTION })
  ).toHaveCount(0);
}

async function expectBranchIdentityAndForbiddenChrome(
  page: Page
): Promise<void> {
  const heading = page.getByRole("heading", {
    level: 1,
    name: SEED.branchName,
  });
  await expect(heading).toHaveCount(1);
  await expect(heading).toHaveClass(SCREEN_READER_ONLY_CLASS);
  await expect(page.locator("h1:not(.sr-only)")).toHaveCount(0);
  await expect(page.getByRole("button", { name: REFRESH_NAME })).toHaveCount(0);
  await expect(page.getByText("Refresh", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Properties" }).click();
  await expect(page.getByText("Reviewer", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Lanes", { exact: true })).toHaveCount(0);
}

async function expectMetricAndLocalEvidence(
  page: Page,
  pullRequestNumber: number
): Promise<void> {
  await expect(page.getByText("LOC per $", { exact: true })).toBeVisible();
  await expect(
    page
      .locator('[data-slot="card-description"]')
      .getByText("Lead time for change", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Abandonment Duration", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("What was delivered", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("FEA-4473", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "The linked artifact list includes only the relationships we could verify.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(
    page.getByText("Checks & review", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Checks", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Unavailable", { exact: true }).first()
  ).toBeVisible();
  await expect(
    page.getByText(
      `File evidence is unavailable for pull request #${pullRequestNumber}.`,
      { exact: true }
    )
  ).toBeVisible({ timeout: 30_000 });
}

async function expectUnavailableLocalComments(page: Page): Promise<void> {
  const commentsToggle = page.locator(
    'button[aria-controls="branch-comments-workspace"]'
  );
  await expect(commentsToggle).toHaveAccessibleName("Hide comments rail");
  await expect(commentsToggle).toHaveAttribute("aria-expanded", "true");
  const commentsRegion = page.getByRole("region", {
    name: "Branch comments",
  });
  await expect(commentsRegion).toBeVisible();
  await expect(
    commentsRegion.getByRole("heading", {
      name: "PR Comments Unavailable",
    })
  ).toBeVisible();
  await expect(
    commentsRegion.getByRole("alert").filter({
      hasText: "Comments are unavailable in this view.",
    })
  ).toBeVisible({ timeout: 30_000 });
  await commentsToggle.click();
  await expect(commentsToggle).toHaveAccessibleName("Show comments rail");
  await expect(commentsRegion).toHaveCount(0);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const maxScrollWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth
          );
          return maxScrollWidth - document.documentElement.clientWidth;
        }),
      { message: "Branch Details should not overflow horizontally at 390px" }
    )
    .toBeLessThanOrEqual(1);
}

async function expectAuthenticatedPrDescription(page: Page): Promise<void> {
  const region = page.getByRole("region", {
    name: `Branch and pull request #${ACTIVE_PR} evidence`,
  });
  const description = region.locator(".bq-ctx-prbody");
  await expect(
    description.getByRole("heading", { level: 5, name: ACTIVE_DESCRIPTION })
  ).toBeVisible();
  await expect(description.getByText(PR_BODY_AUTOMATION_MARKER)).toHaveCount(0);
  expect(await description.innerHTML()).not.toContain(
    PR_BODY_AUTOMATION_MARKER
  );
  await expect(description.getByRole("table")).toBeVisible();
  await expect(description).toHaveClass(CLAMPED_CLASS_PATTERN);
  const toggle = region.getByRole("button", {
    name: "Show full description",
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(description).not.toHaveClass(CLAMPED_CLASS_PATTERN);
  await region.getByRole("button", { name: "Show less" }).click();
  await expect(description).toHaveClass(CLAMPED_CLASS_PATTERN);
}
