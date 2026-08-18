/**
 * ISS-5559: launched-app proof that an authenticated canonical `awaiting_sync`
 * Branch row stays provisional on the shared Branches List in Desktop.
 *
 * The fixture deliberately disagrees across the compatibility boundary:
 * top-level `dataState` says ready while `canonicalProjection.list.dataState`
 * says awaiting sync. The visible loader therefore proves the production
 * cloud read → shared adapter → Name-cell rendering path honors the canonical
 * projection, rather than merely proving an isolated component can render it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  type BranchAnalytics,
  BranchDataState,
  BranchKpiState,
  type BranchListResponse,
  BranchTagAvailability,
  BranchViewerScope,
} from "@repo/api/src/types/branch.ts";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics.ts";
import { ReadSource } from "@repo/api/src/types/read-source.ts";
import { TagColor } from "@repo/api/src/types/tag.ts";
import axe from "axe-core";
import {
  ACTIVE_PR,
  BRANCH_ID,
  BRANCH_NAME,
  detailFor,
  REPOSITORY,
} from "../../../../e2e/helpers/branch-details-comprehensive-data";
import { expectWcagAaClean } from "../../../../e2e/helpers/critical-wcag-aa";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  launchAuthenticatedDesktopApp,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  gotoHash,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const VIEWPORTS = [
  { height: 800, label: "desktop", width: 1280 },
  { height: 800, label: "768px", width: 768 },
] as const;
const EXPECTED_HEADERS = [
  "Name",
  "Owner",
  "Collaborators",
  "Linked sessions",
  "Changes",
  "Status",
  "Pull request",
  "Last active",
  "Repository",
  "Tags",
] as const;
const SYNCING_LINK_NAME = `Syncing branch data. ${BRANCH_NAME}`;
const READY_ROW_NAME = /^feature\/ready\s/;
const SR_ONLY_CLASS_PATTERN = /sr-only/;
const READY_BRANCH_ID = "branch-ready";
const READY_BRANCH_NAME = "feature/ready";
const TAG_NAME = "awaiting-sync";
const PROFILE_ID = "iss-5559-awaiting-sync-profile";
const SUB_PIXEL_TOLERANCE_PX = 1;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_ACTIVITY_AT = new Date(Date.now() - ONE_DAY_MS).toISOString();

test("renders an authenticated awaiting-sync row truthfully at Desktop widths", async () => {
  test.setTimeout(240_000);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5559-desktop-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5559-desktop-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5559-desktop-udd-")
  );
  const server = await startAuthenticatedBranchCloudServer({
    analyticsFactory: branchAnalyticsResponse,
    listFactory: awaitingSyncListResponse,
    repositoryFullNames: [REPOSITORY],
  });

  try {
    const sessionSeedLaunch = await launchAuthenticatedDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      userDataDir,
    });
    try {
      await seedAuthenticatedDesktopSession(sessionSeedLaunch.app, userDataDir);
    } finally {
      await sessionSeedLaunch.cleanup();
    }

    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          activeConfigId: PROFILE_ID,
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: PROFILE_ID,
              name: "ISS-5559 Awaiting Sync E2E",
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
    });

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

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await gotoHash(page, "/branches");
        await expectAwaitingSyncList(page, viewport.label);
        await expectWcagAaClean(page, axe.source, { criticalOnly: true });

        const branchLink = page.getByRole("link", {
          name: SYNCING_LINK_NAME,
        });
        await branchLink.focus();
        await expect(branchLink).toBeFocused();
        await branchLink.click();
        await expect(page).toHaveURL(new RegExp(`#/branches/${BRANCH_ID}$`));
        await expect(
          page.getByRole("heading", { level: 1, name: BRANCH_NAME })
        ).toBeVisible({ timeout: 30_000 });
      }

      await expect
        .poll(
          () =>
            server.requests.filter(
              (request) =>
                request.pathname === "/branches" &&
                request.authorization === `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
            ).length,
          {
            message:
              "Branches List reads should use the restored session token",
          }
        )
        .toBeGreaterThanOrEqual(1);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

function awaitingSyncListResponse(): BranchListResponse {
  return {
    hasMore: false,
    items: [
      branchListItem({
        branchName: BRANCH_NAME,
        canonicalDataState: BranchDataState.AwaitingSync,
        id: BRANCH_ID,
        tagName: TAG_NAME,
        topLevelDataState: BranchDataState.Ready,
      }),
      branchListItem({
        branchName: READY_BRANCH_NAME,
        canonicalDataState: BranchDataState.Ready,
        id: READY_BRANCH_ID,
        tagName: "ready",
        topLevelDataState: BranchDataState.AwaitingSync,
      }),
    ],
    readSource: ReadSource.Cloud,
    total: 2,
    viewerScope: BranchViewerScope.Organization,
  };
}

function branchListItem({
  branchName,
  canonicalDataState,
  id,
  tagName,
  topLevelDataState,
}: BranchListItemOptions): BranchListResponse["items"][number] {
  const detail = detailFor(ACTIVE_PR);
  const projection = detail.canonicalProjection;
  if (!projection) {
    throw new Error(
      "ISS-5559 fixture requires the canonical Branch projection."
    );
  }
  const tag = {
    color: TagColor.Amber,
    id: `iss-5559-${id}-tag`,
    name: tagName,
  };
  const tagPermissions = { canApply: true, canRemove: false };
  return {
    additions: detail.additions,
    ahead: detail.ahead,
    artifactId: id,
    attributedCostUsd: detail.attributedCostUsd,
    baseBranch: detail.baseBranch,
    behind: detail.behind,
    branchName,
    canonicalProjection: {
      ...projection,
      common: {
        ...projection.common,
        identity: {
          ...projection.common.identity,
          artifactId: id,
          branchName,
        },
        lastActiveAt: {
          state: BranchMetricAvailability.Complete,
          value: RECENT_ACTIVITY_AT,
        },
        tags: {
          availability: BranchTagAvailability.Available,
          items: [tag],
          permissions: tagPermissions,
        },
      },
      list: { ...projection.list, dataState: canonicalDataState },
    },
    checksPassed: detail.checksPassed,
    checksStatus: detail.checksStatus,
    checksTotal: detail.checksTotal,
    dataState: topLevelDataState,
    deletions: detail.deletions,
    estimatedCostUsd: detail.estimatedCostUsd,
    filesChanged: detail.filesChanged,
    id,
    lastActivityAt: RECENT_ACTIVITY_AT,
    multiPrWarning: detail.multiPrWarning,
    owner: detail.owner,
    prNumber: detail.prNumber,
    prState: detail.prState,
    prTitle: detail.prTitle,
    prUrl: detail.prUrl,
    projectId: projection.common.identity.projectId,
    repoFullName: detail.repoFullName,
    reviewDecision: detail.reviewDecision,
    sessionIds: detail.sessionIds,
    status: detail.status,
    tagAvailability: BranchTagAvailability.Available,
    tagPermissions,
    tags: [tag],
  };
}

function branchAnalyticsResponse(): BranchAnalytics {
  const unavailableKpi = {
    baseline30d: null,
    deltaPct: null,
    state: BranchKpiState.Unavailable,
    value: null,
  } as const;
  return {
    activeBranchCount: {
      ...unavailableKpi,
      state: BranchKpiState.Available,
      value: 2,
    },
    activePrCount: unavailableKpi,
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
    leadTimeForChangeMs: unavailableKpi,
    locPerDollar: unavailableKpi,
    medianPrSize: unavailableKpi,
    medianTimeToMergeMs: unavailableKpi,
    mergeRate: unavailableKpi,
    mergedCount: unavailableKpi,
    totalSpendUsd: unavailableKpi,
    viewerScope: BranchViewerScope.Organization,
  };
}

async function expectAwaitingSyncList(
  page: Page,
  viewportLabel: string
): Promise<void> {
  const table = page.getByRole("table");
  await expect(table).toBeVisible({ timeout: 30_000 });
  await expect(table.getByRole("columnheader")).toHaveText(EXPECTED_HEADERS);

  const branchLink = table.getByRole("link", { name: SYNCING_LINK_NAME });
  const readyLink = table.getByRole("link", {
    exact: true,
    name: READY_BRANCH_NAME,
  });
  await expect(branchLink).toBeVisible();
  await expect(branchLink).toHaveAccessibleName(SYNCING_LINK_NAME);
  await expect(readyLink).toBeVisible();
  await expect(readyLink).toHaveAccessibleName(READY_BRANCH_NAME);
  const row = table.getByRole("row").filter({ hasText: BRANCH_NAME });
  const readyRow = table.getByRole("row", { name: READY_ROW_NAME });
  await expect(row).toBeVisible();
  await expect(readyRow).toBeVisible();
  await expect(row.getByRole("cell")).toHaveCount(EXPECTED_HEADERS.length);
  await expect(readyRow.getByRole("cell")).toHaveCount(EXPECTED_HEADERS.length);
  await expect(
    branchLink.getByText("Syncing branch data.", { exact: true })
  ).toHaveClass(SR_ONLY_CLASS_PATTERN);
  await expect(row.locator(".animate-spin")).toHaveCount(1);
  await expect(readyLink.locator("svg")).toHaveCount(1);
  await expect(readyRow.locator(".animate-spin")).toHaveCount(0);
  await expect(readyRow).not.toContainText("Syncing branch data.");
  await expect(row).not.toContainText("Syncing…");
  await expect(row).not.toContainText("*");
  await expectRowCellsRemainUsable(row);

  const scrollOwner = page.getByRole("region", { name: "Branches" });
  await expectScrollOwnerKeyboardAccess(page, scrollOwner);
  await expectTagsReachableAtRightEdge(page, scrollOwner, table, row);
  await expectNoDocumentOverflow(page, viewportLabel);
  await scrollOwner.evaluate((element) => {
    element.scrollLeft = 0;
  });
}

async function expectRowCellsRemainUsable(row: Locator): Promise<void> {
  await expect(row.locator('[data-column-id="owner"]')).toContainText(
    "Ada Lovelace"
  );
  await expect(row.locator('[data-column-id="collaborators"]')).toHaveText("—");
  await expect(row.locator('[data-column-id="sessions"]')).toContainText("3");
  await expect(row.locator('[data-column-id="sessions"] a')).toHaveAttribute(
    "href",
    `#/branches/${BRANCH_ID}?tab=sessions-timeline`
  );
  await expect(row.locator('[data-column-id="changes"]')).toContainText("+120");
  await expect(row.locator('[data-column-id="changes"]')).toContainText("−40");
  await expect(row.locator('[data-column-id="status"]')).toHaveText("Open");
  await expect(row.locator('[data-column-id="pr"] a')).toHaveAttribute(
    "href",
    `https://github.com/${REPOSITORY}/pull/${ACTIVE_PR}`
  );
  await expect(row.locator('[data-column-id="lastActivity"]')).not.toHaveText(
    "Unavailable"
  );
  await expect(row.locator('[data-column-id="repo"] a')).toHaveAccessibleName(
    `${REPOSITORY} repository on GitHub`
  );
  await expect(row.locator('[data-column-id="tags"]')).toContainText(TAG_NAME);
  await expect(
    row.locator('[data-column-id="tags"]').getByRole("button", {
      name: `Edit tags for ${BRANCH_NAME}`,
    })
  ).toBeVisible();
}

async function expectScrollOwnerKeyboardAccess(
  page: Page,
  scrollOwner: Locator
): Promise<void> {
  await expect(scrollOwner).toHaveAttribute("tabindex", "0");
  await expect
    .poll(() =>
      scrollOwner.evaluate(
        (element) => element.scrollWidth - element.clientWidth
      )
    )
    .toBeGreaterThan(0);
  await scrollOwner.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(scrollOwner).toBeFocused();
  await scrollOwner.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await scrollOwner.press("ArrowRight");
  await expect
    .poll(() => scrollOwner.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
}

async function expectTagsReachableAtRightEdge(
  page: Page,
  scrollOwner: Locator,
  table: Locator,
  row: Locator
): Promise<void> {
  await scrollOwner.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const tagsHeader = table.getByRole("columnheader", { name: "Tags" });
  await tagsHeader.scrollIntoViewIfNeeded();
  const ownerBox = await scrollOwner.boundingBox();
  const tagsBox = await tagsHeader.boundingBox();
  if (!(ownerBox && tagsBox)) {
    throw new Error("Expected Branches scroll-owner and Tags header geometry.");
  }
  expect(tagsBox.x).toBeGreaterThanOrEqual(ownerBox.x - SUB_PIXEL_TOLERANCE_PX);
  expect(tagsBox.x + tagsBox.width).toBeLessThanOrEqual(
    ownerBox.x + ownerBox.width + SUB_PIXEL_TOLERANCE_PX
  );
  const tagsCell = row.locator('[data-column-id="tags"]');
  await expect
    .poll(() => elementFitsHorizontally(scrollOwner, tagsCell))
    .toBe(true);
  await expect
    .poll(() => elementIntersectsVisualViewport(page, scrollOwner))
    .toBe(true);
  await expect
    .poll(() => elementFitsVisualViewport(page, tagsHeader))
    .toBe(true);
  await expect.poll(() => elementFitsVisualViewport(page, tagsCell)).toBe(true);
}

async function elementFitsHorizontally(
  container: Locator,
  element: Locator
): Promise<boolean> {
  const [containerBox, elementBox] = await Promise.all([
    container.boundingBox(),
    element.boundingBox(),
  ]);
  if (!(containerBox && elementBox)) {
    return false;
  }
  return (
    elementBox.x >= containerBox.x - SUB_PIXEL_TOLERANCE_PX &&
    elementBox.x + elementBox.width <=
      containerBox.x + containerBox.width + SUB_PIXEL_TOLERANCE_PX
  );
}

async function elementIntersectsVisualViewport(
  page: Page,
  element: Locator
): Promise<boolean> {
  const [elementBox, viewport] = await Promise.all([
    element.boundingBox(),
    visualViewportBounds(page),
  ]);
  if (!elementBox) {
    return false;
  }
  return (
    elementBox.x + elementBox.width >= viewport.x &&
    elementBox.x <= viewport.x + viewport.width &&
    elementBox.y + elementBox.height >= viewport.y &&
    elementBox.y <= viewport.y + viewport.height
  );
}

async function elementFitsVisualViewport(
  page: Page,
  element: Locator
): Promise<boolean> {
  const [elementBox, viewport] = await Promise.all([
    element.boundingBox(),
    visualViewportBounds(page),
  ]);
  if (!elementBox) {
    return false;
  }
  return (
    elementBox.x >= viewport.x - SUB_PIXEL_TOLERANCE_PX &&
    elementBox.x + elementBox.width <=
      viewport.x + viewport.width + SUB_PIXEL_TOLERANCE_PX &&
    elementBox.y + elementBox.height >= viewport.y &&
    elementBox.y <= viewport.y + viewport.height
  );
}

function visualViewportBounds(page: Page): Promise<{
  height: number;
  width: number;
  x: number;
  y: number;
}> {
  return page.evaluate(() => ({
    height: window.visualViewport?.height ?? window.innerHeight,
    width: window.visualViewport?.width ?? window.innerWidth,
    x: window.visualViewport?.offsetLeft ?? 0,
    y: window.visualViewport?.offsetTop ?? 0,
  }));
}

async function expectNoDocumentOverflow(
  page: Page,
  viewportLabel: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const maxScrollWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth
          );
          const viewportWidth =
            window.visualViewport?.width ?? window.innerWidth;
          return maxScrollWidth - viewportWidth;
        }),
      {
        message: `Branches should not overflow the document at ${viewportLabel}`,
      }
    )
    .toBeLessThanOrEqual(SUB_PIXEL_TOLERANCE_PX);
}

type BranchListItemOptions = {
  branchName: string;
  canonicalDataState: BranchDataState;
  id: string;
  tagName: string;
  topLevelDataState: BranchDataState;
};
