/**
 * Native cloud-mode regression: the authenticated Desktop bridge must carry a
 * filtered cohort POST and render its partial producer response.
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
import type {
  BranchAnalyticsCohortRequest,
  BranchAnalyticsCohortResponse,
} from "../../../../packages/api/src/types/branch-analytics-cohort";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "../../../../packages/api/src/types/branch-identity";
import { BranchListFacetAvailability } from "../../../../packages/api/src/types/branch-list-contract";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "../../../../packages/api/src/types/branch-metrics";
import { BRANCHES_PARTIAL_COHORT_METRICS_FLAG_KEY } from "../../../../packages/api/src/types/branches-partial-cohort-metrics-flag";
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
  ALICE_OWNER_OPTION_PATTERN,
  closeServer,
  ownerKey,
  readJsonBody,
  selectOwnerFacetOption,
  summaryCard,
  writeJson,
} from "./helpers/branches-cloud-fixture";
import { expectFixtureInsideDefaultDateWindow } from "./helpers/date-window-fixture-guard";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  drainedCloudReadReadiness,
  gotoNav,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";

const PROFILE_ID = "branches-partial-cohort-e2e-profile";
const CARD_VALUE_SELECTOR = '[data-slot="card-title"]';
const LOC_PER_DOLLAR_LABEL = "LOC per $";
const COHORT_LOC_PER_DOLLAR = 20;
const LOC_PER_DOLLAR_VALUE = `${COHORT_LOC_PER_DOLLAR} LOC/$*`;
/**
 * What the card rendered before the fix. Copy, not a contract — an inline
 * literal in `availabilityDetail` (`approved-branches-summary-cards.tsx`).
 */
const SUPPRESSED_BY_FILTER_DETAIL = "Not available with filters applied";
const DAY_MS = 24 * 60 * 60 * 1000;
// Branches defaults to a rolling "Last 7 days" window, so anchor the corpus to
// the run clock rather than a frozen date. Nothing here asserts a literal date.
const NOW_MS = Date.now();
const NOW_ISO = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
const METRIC_WINDOW_START_ISO = new Date(NOW_MS - 7 * DAY_MS).toISOString();
const METRIC_WINDOW_END_ISO = new Date(NOW_MS).toISOString();

test("a partial cohort answer renders as a starred value, not a blanked card", async () => {
  test.setTimeout(180_000);
  expectFixtureInsideDefaultDateWindow(NOW_ISO, "Seeded branch lastActivityAt");

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-partial-cohort-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-partial-cohort-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "desktop-partial-cohort-udd-")
  );
  const server = await startPartialCohortCloudApiServer();

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
        // ISS-8968: the starred partial figure is gated closed by default, so
        // the assertions below are asserting the OPEN side and have to open it.
        seedDesktopFeatureFlags(launchUserDataDir, {
          [BRANCHES_PARTIAL_COHORT_METRICS_FLAG_KEY]: true,
        });
        seedDesktopSettings(launchUserDataDir, {
          activeConfigId: PROFILE_ID,
          apiOrigin: server.origin,
          cloudConnectionEnabled: true,
          savedConfigs: [
            {
              apiOrigin: server.origin,
              gatewayId: AUTHENTICATED_GATEWAY_ID,
              id: PROFILE_ID,
              name: "Branches Partial Cohort E2E",
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
      await expect(page.getByText(ALICE_BRANCHES[0].branchName)).toBeVisible({
        timeout: 30_000,
      });
      await clickDesktopDateRange(page, DesktopDateRangeLabel.AllTime);
      // The facet is what makes this an exact-cohort read at all: with no active
      // filter the surface never asks the producer for a cohort.
      await selectOwnerFacetOption(page, ALICE_OWNER_OPTION_PATTERN);

      const card = summaryCard(page, LOC_PER_DOLLAR_LABEL);
      await expect(card.locator(CARD_VALUE_SELECTOR)).toHaveText(
        LOC_PER_DOLLAR_VALUE,
        { timeout: 60_000 }
      );
      // ISS-10540 (product ruling 2026-09-22): the disclosure is carried in the
      // card's info popover; the face carries the `*` and the scope caption only.
      await expect(card).not.toContainText(
        BranchMetricDisclosure.BranchesIncomplete
      );
      await card
        .getByRole("button", { name: `About ${LOC_PER_DOLLAR_LABEL}` })
        .click();
      await expect(
        page.getByRole("dialog", { name: `About ${LOC_PER_DOLLAR_LABEL}` })
      ).toContainText(BranchMetricDisclosure.BranchesIncomplete);
      await page.keyboard.press("Escape");
      // The state the bug rendered, pinned so the two stay distinguishable.
      await expect(card).not.toContainText(SUPPRESSED_BY_FILTER_DETAIL);

      // Without this the assertion above could pass off a local fallback and say
      // nothing about the partial producer answer the fix exists to admit.
      expect(server.cohortRequests.at(-1)?.branchIds).toEqual(
        [...ALICE_BRANCHES.map((row) => row.id)].sort()
      );

      await page.screenshot({
        fullPage: true,
        path: test.info().outputPath("branches-partial-cohort-desktop.png"),
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

type PartialCohortCloudApiServer = {
  origin: string;
  cohortRequests: BranchAnalyticsCohortRequest[];
  close: () => Promise<void>;
};

/** Two rows the owner facet admits; the producer then declines the second. */
const ALICE_BRANCHES = [
  makeBranch({
    branchName: "feat/partial-cohort-matched",
    id: "11111111-1111-4111-8111-111111111111",
    owner: "Alice Agent",
    ownerId: "alice-agent",
    prNumber: 8968,
  }),
  makeBranch({
    branchName: "feat/partial-cohort-declined",
    id: "22222222-2222-4222-8222-222222222222",
    owner: "Alice Agent",
    ownerId: "alice-agent",
    prNumber: 8969,
  }),
] as const;
/** Excluded by the facet, so it never reaches the producer request at all. */
const BOB_BRANCH = makeBranch({
  branchName: "feat/partial-cohort-other-owner",
  id: "33333333-3333-4333-8333-333333333333",
  owner: "Bob Builder",
  ownerId: "bob-builder",
  prNumber: 8970,
});
const ALL_BRANCHES = [...ALICE_BRANCHES, BOB_BRANCH];
/** The one identity the producer answers for — a STRICT subset of the request. */
const MATCHED_BRANCH_ID = ALICE_BRANCHES[0].id;

async function startPartialCohortCloudApiServer(): Promise<PartialCohortCloudApiServer> {
  const cohortRequests: BranchAnalyticsCohortRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      await routePartialCohortRequest(request, response, cohortRequests);
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
    throw new Error("Partial cohort cloud API server did not bind to a port.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    cohortRequests,
    close: () => closeServer(server),
  };
}

async function routePartialCohortRequest(
  request: IncomingMessage,
  response: ServerResponse,
  cohortRequests: BranchAnalyticsCohortRequest[]
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (routeDesktopSessionRefresh(request, response)) {
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/branches") {
    writeJson(response, listResponse(requestUrl));
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
    request.method === "POST" &&
    requestUrl.pathname === "/branches/analytics/cohort"
  ) {
    const body = (await readJsonBody(request)) as BranchAnalyticsCohortRequest;
    cohortRequests.push(body);
    writeJson(response, partialCohortResponse(body));
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

/**
 * Deliberately advertises no server-pagination capability. That capability is
 * what puts the surface on the server-paged branch, which bypasses the cohort
 * binder entirely — the sibling `branches-cloud-owner-filter-metrics` spec
 * asserts exactly that, and it is why this fixture must not carry `pageInfo`.
 */
function listResponse(requestUrl: URL): BranchListResponse {
  const selectedOwners = requestUrl.searchParams.getAll("owners");
  const items = ALL_BRANCHES.filter(
    (row) =>
      selectedOwners.length === 0 || selectedOwners.includes(ownerKey(row))
  );
  return {
    facets: facets(),
    items,
    lifetimeSessionCostUsd: {},
    sessionBranchCount: {},
    sessionCostUsd: {},
    total: items.length,
    viewerScope: BranchViewerScope.Organization,
  };
}

/**
 * Whole-list analytics whose every metric is unavailable, so any number the card
 * renders came from the cohort response rather than a fallback that agrees.
 * `canonicalMetrics` is present because the partial path REBINDS onto that
 * bundle — omit it and the fallback returns the analytics untouched.
 */
function analyticsResponse(): BranchAnalytics {
  const unavailableKpi = {
    baseline30d: null,
    deltaPct: null,
    state: BranchKpiState.Unavailable,
    value: null,
  } as const;
  return {
    activeBranchCount: unavailableKpi,
    activePrCount: unavailableKpi,
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
    canonicalMetrics: metricBundle(ALL_BRANCHES.length, null),
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

/**
 * The producer matched ONE of the two requested identities and its metrics
 * describe exactly that one, so `cohortSize` is the matched count.
 */
function partialCohortResponse(
  request: BranchAnalyticsCohortRequest
): BranchAnalyticsCohortResponse {
  const matchedBranchIds = request.branchIds.filter(
    (id) => id === MATCHED_BRANCH_ID
  );
  return {
    canonicalMetrics: metricBundle(
      matchedBranchIds.length,
      COHORT_LOC_PER_DOLLAR
    ),
    matchedBranchIds,
  };
}

function metricBundle(
  cohortSize: number,
  locPerDollar: number | null
): BranchListMetricBundle {
  const unavailable = {
    current: { state: BranchMetricAvailability.Unavailable, value: null },
  } as const;
  return {
    activeBranches: unavailable,
    aiSpendUsd: unavailable,
    cohortSize,
    label: BranchMetricComparisonLabel.AllTime,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: NOW_ISO,
    },
    // ISS-10636: the LOC per $ card reads `canonicalLocPerDollar` and refuses
    // the legacy list ratio, which divides a different cost population
    // (`selectCanonicalLocPerDollar`). Both live producers emit this key, so
    // the two move together here rather than the bundle describing a producer
    // shape that does not exist.
    canonicalLocPerDollar:
      locPerDollar === null
        ? unavailable
        : {
            current: {
              state: BranchMetricAvailability.Complete,
              value: locPerDollar,
            },
          },
    locPerDollar:
      locPerDollar === null
        ? unavailable
        : {
            current: {
              state: BranchMetricAvailability.Complete,
              value: locPerDollar,
            },
          },
    medianPrSize: unavailable,
    mergeRatePct: unavailable,
    period: BranchMetricPeriod.All,
    window: { endAt: METRIC_WINDOW_END_ISO, startAt: METRIC_WINDOW_START_ISO },
  };
}

function facets(): BranchListResponse["facets"] {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    collaborators: emptyFacet,
    lastActiveRanges: emptyFacet,
    names: emptyFacet,
    owners: {
      availability: BranchListFacetAvailability.Complete,
      options: [
        {
          count: ALICE_BRANCHES.length,
          id: ownerKey(ALICE_BRANCHES[0]),
          label: ALICE_BRANCHES[0].owner ?? "",
        },
        {
          count: 1,
          id: ownerKey(BOB_BRANCH),
          label: BOB_BRANCH.owner ?? "",
        },
      ],
    },
    pullRequests: emptyFacet,
    repositories: emptyFacet,
    statuses: emptyFacet,
    tags: emptyFacet,
  };
}

function makeBranch(options: {
  branchName: string;
  id: string;
  owner: string;
  ownerId: string;
  prNumber: number;
}): BranchRow {
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
    owner: options.owner,
    ownerIdentity: {
      availability: BranchIdentityAvailability.Complete,
      person: {
        displayName: options.owner,
        id: options.ownerId,
        login: options.ownerId,
        provider: BranchPersonProvider.GitHub,
      },
    },
    prNumber: options.prNumber,
    prState: GitHubPRState.Merged,
    prTitle: `Merged PR for ${options.branchName}`,
    prUrl: `https://github.com/acme/web/pull/${options.prNumber}`,
    repoFullName: "acme/web",
    reviewDecision: null,
    sessionIds: [`${options.id}-session`],
    status: BranchStatus.Merged,
  };
}
