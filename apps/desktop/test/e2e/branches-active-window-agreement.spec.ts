/**
 * ISS-12309 regression, DESKTOP shell — the launched Branches Active branches
 * card reads the RANGE-SCOPED count, not the unwindowed cohort's.
 *
 * Its own launched spec because `packages/app/AGENTS.md` and
 * `apps/desktop/AGENTS.md` require each shell that mounts a shared surface to
 * carry one, and because no existing Electron Branches spec can tell the two
 * counts apart: `branches-page.spec.ts` asserts the card's LABEL and
 * `branches-cohort-transparency.spec.ts` asserts an unavailable guest count, so
 * the pre-ruling selector passes both. Those guest cases stay where they are —
 * this adds the authenticated-cloud case they cannot express.
 *
 * The web half is `e2e/branches-active-window-agreement.spec.ts`. The two are
 * NOT duplicates: desktop reaches the same `packages/app` component through its
 * own bridge and producer fold, which is the half a renderer vitest render never
 * exercises.
 */

import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  type BranchAnalytics,
  BranchKpiState,
  type BranchListResponse,
  type BranchRow,
  BranchStatus,
  BranchViewerScope,
} from "../../../../packages/api/src/types/branch";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "../../../../packages/api/src/types/branch-identity";
import {
  BRANCH_METRIC_DICTIONARY,
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricId,
  BranchMetricPeriod,
} from "../../../../packages/api/src/types/branch-metrics";
import { GitHubPRState } from "../../../../packages/api/src/types/github";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
  routeDesktopSessionRefresh,
} from "./helpers/branch-details-authenticated-cloud";
import {
  closeServer,
  emptyBranchListFacets,
  summaryCard,
  unavailableKpi,
  writeJson,
} from "./helpers/branches-cloud-fixture";
import { expectFixtureInsideDefaultDateWindow } from "./helpers/date-window-fixture-guard";
import {
  drainedCloudReadReadiness,
  gotoNav,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const PROFILE_ID = "branches-active-window-e2e-profile";
const CARD_VALUE_SELECTOR = '[data-slot="card-title"]';
const ACTIVE_BRANCHES_LABEL =
  BRANCH_METRIC_DICTIONARY[BranchMetricId.ActiveBranches].label;
const DAY_MS = 24 * 60 * 60 * 1000;
// The surface defaults to a rolling "Last 7 days" window, so the corpus is
// anchored to the run clock. Nothing here asserts a literal date.
const NOW_MS = Date.now();
const NOW_ISO = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
const METRIC_WINDOW_START_ISO = new Date(NOW_MS - 7 * DAY_MS).toISOString();
const METRIC_WINDOW_END_ISO = new Date(NOW_MS).toISOString();

/** The 2026-10-08 capture's count over the unwindowed product cohort. */
const UNWINDOWED_ACTIVE = 769;
/**
 * The count the selected window carries. Below the three rows the list serves
 * on purpose — the card counts the in-progress subset of the window, so a value
 * equal to the row count could be satisfied by the list total instead.
 */
const WINDOWED_ACTIVE = 2;

test("the launched Desktop Active branches card counts the selected window", async () => {
  test.setTimeout(180_000);
  expectFixtureInsideDefaultDateWindow(NOW_ISO, "Seeded branch lastActivityAt");

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-active-window-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-active-window-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-active-window-udd-")
  );
  const server = await startActiveWindowCloudApiServer();

  try {
    const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      cloudReadReadiness: drainedCloudReadReadiness(),
      userDataDir,
      env: {
        CLAUDE_HOME: claudeHome,
        CL_AUTH_API_ORIGIN: server.origin,
        CODEX_HOME: codexHome,
      },
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
              name: "Branches Active Window E2E",
              relayOrigin: "http://127.0.0.1:9",
              webAppOrigin: "http://127.0.0.1:3000",
            },
          ],
        });
      },
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

      await gotoNav(page, "branches");
      await expect(
        page.locator("header").getByText("Branches", { exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(WINDOW_BRANCHES[0].branchName)).toBeVisible({
        timeout: 30_000,
      });

      // Resolve the card before asserting anything absent from it: a negative
      // against a selector matching nothing passes for the wrong reason.
      const card = summaryCard(page, ACTIVE_BRANCHES_LABEL);
      await expect(card).toHaveCount(1);
      await expect(card.locator(CARD_VALUE_SELECTOR)).toHaveText(
        String(WINDOWED_ACTIVE),
        { timeout: 60_000 }
      );
      // The figure the pre-ruling selector printed, pinned so the two stay
      // distinguishable through the Desktop bridge and producer fold.
      await expect(card).not.toContainText(String(UNWINDOWED_ACTIVE));

      await page.screenshot({
        fullPage: true,
        path: test.info().outputPath("branches-active-window-desktop.png"),
      });
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
  }
});

type ActiveWindowCloudApiServer = {
  origin: string;
  close: () => Promise<void>;
};

/**
 * Three rows inside the default window, one merged. The merged row is what keeps
 * `WINDOWED_ACTIVE` below the list total, so a card reading the row count rather
 * than the windowed metric cannot pass.
 */
const WINDOW_BRANCHES: readonly BranchRow[] = [
  makeBranch({
    branchName: "feat/active-window-open-a",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    prNumber: 12_309,
    status: BranchStatus.Open,
  }),
  makeBranch({
    branchName: "feat/active-window-open-b",
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    prNumber: 12_310,
    status: BranchStatus.Open,
  }),
  makeBranch({
    branchName: "feat/active-window-merged",
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    prNumber: 12_311,
    status: BranchStatus.Merged,
  }),
];

async function startActiveWindowCloudApiServer(): Promise<ActiveWindowCloudApiServer> {
  const server = createServer(async (request, response) => {
    try {
      await routeActiveWindowRequest(request, response);
    } catch (error) {
      response.statusCode = 500;
      writeJson(response, {
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Active window cloud API server did not bind to a port.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function routeActiveWindowRequest(
  request: IncomingMessage,
  response: ServerResponse
): void {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (routeDesktopSessionRefresh(request, response)) {
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/branches") {
    writeJson(response, listResponse());
    return;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/branches/analytics"
  ) {
    writeJson(response, analyticsResponse());
    return;
  }
  if (
    request.method === "GET" &&
    requestUrl.pathname === "/integrations/github/repositories"
  ) {
    writeJson(response, []);
    return;
  }
  response.statusCode = 404;
  writeJson(response, { error: "not found" });
}

function listResponse(): BranchListResponse {
  return {
    facets: emptyBranchListFacets(),
    items: [...WINDOW_BRANCHES],
    lifetimeSessionCostUsd: {},
    sessionBranchCount: {},
    sessionCostUsd: {},
    total: WINDOW_BRANCHES.length,
    viewerScope: BranchViewerScope.Organization,
  };
}

/**
 * Both counts ride in ONE response, so a card reading either field indifferently
 * cannot satisfy the pair the test asserts.
 */
function analyticsResponse(): BranchAnalytics {
  const kpi = unavailableKpi();
  return {
    activeBranchCount: kpi,
    activePrCount: kpi,
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
    canonicalMetrics: divergentWindowBundle(),
    leadTimeForChangeMs: kpi,
    locPerDollar: kpi,
    medianPrSize: kpi,
    medianTimeToMergeMs: kpi,
    mergeRate: kpi,
    mergedCount: kpi,
    totalSpendUsd: kpi,
    viewerScope: BranchViewerScope.Organization,
  };
}

function divergentWindowBundle(): BranchListMetricBundle {
  const unavailable = {
    current: { state: BranchMetricAvailability.Unavailable, value: null },
  } as const;
  return {
    activeBranches: {
      current: {
        state: BranchMetricAvailability.Complete,
        value: UNWINDOWED_ACTIVE,
      },
    },
    aiSpendUsd: unavailable,
    canonicalLocPerDollar: unavailable,
    cohortSize: 1144,
    label: BranchMetricComparisonLabel.WeekOverWeek,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: NOW_ISO,
    },
    locPerDollar: unavailable,
    medianPrSize: unavailable,
    mergeRatePct: unavailable,
    period: BranchMetricPeriod.SevenDays,
    window: { endAt: METRIC_WINDOW_END_ISO, startAt: METRIC_WINDOW_START_ISO },
    windowScoped: {
      activeBranches: {
        current: {
          state: BranchMetricAvailability.Complete,
          value: WINDOWED_ACTIVE,
        },
      },
      aiSpendUsd: unavailable,
    },
  };
}

function makeBranch(options: {
  branchName: string;
  id: string;
  prNumber: number;
  status: BranchStatus;
}): BranchRow {
  const owner = "Alice Agent";
  return {
    additions: 400,
    ahead: 1,
    artifactId: options.id,
    baseBranch: "main",
    behind: 0,
    branchName: options.branchName,
    checksPassed: null,
    checksStatus: null,
    checksTotal: null,
    deletions: 100,
    estimatedCostUsd: 25,
    filesChanged: 6,
    id: options.id,
    lastActivityAt: NOW_ISO,
    multiPrWarning: false,
    owner,
    ownerIdentity: {
      availability: BranchIdentityAvailability.Complete,
      person: {
        displayName: owner,
        id: "alice-agent",
        login: "alice-agent",
        provider: BranchPersonProvider.GitHub,
      },
    },
    prNumber: options.prNumber,
    prState:
      options.status === BranchStatus.Merged
        ? GitHubPRState.Merged
        : GitHubPRState.Open,
    prTitle: `PR for ${options.branchName}`,
    prUrl: `https://github.com/acme/web/pull/${options.prNumber}`,
    repoFullName: "acme/web",
    reviewDecision: null,
    sessionIds: [`${options.id}-session`],
    status: options.status,
  };
}
