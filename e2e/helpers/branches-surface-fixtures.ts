/**
 * Fixture builders for the web Branches surface specs.
 *
 * Extracted from `e2e/branches-surface.spec.ts`, which grew past the
 * 1000-line-per-file cap. These are pure response/row factories with no
 * assertions and no Playwright dependency, so they carry no test semantics —
 * moving them out changes nothing the specs observe, and leaves the spec file
 * holding only its scenarios.
 */

import type { Route } from "@playwright/test";
import {
  type BranchAnalytics,
  BranchKpiState,
  type BranchListResponse,
  type BranchPageDetail,
  type BranchPrCommentsResponse,
  type BranchRow,
  BranchStatus,
  type BranchUsageSummary,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { emptySyncedBranchComments } from "./branch-comments-fixture";
import { BranchFixtureSubResource } from "./branch-detail-path";
import { success } from "./mock-users";

export const ACME_BRANCH_NAME = "feature/acme-branches";
export const BRANCH_ID = "branch-1";
// One day ago, NOT a fixed ISO date: the branches page's default saved view
// windows rows to the last 7 days of activity (branch-saved-view.ts dateRange
// "7d"), so a pinned BASE_TIME silently ages out of the window and empties
// every row-dependent spec — the previous 2026-07-01 pin went red 2026-07-08
// with zero code change.
export const BASE_TIME = new Date(
  Date.now() - 24 * 60 * 60 * 1000
).toISOString();
export const BASE_TIME_PLUS_20_MIN = new Date(
  new Date(BASE_TIME).getTime() + 20 * 60 * 1000
).toISOString();

export function makeBranchRow(overrides: Partial<BranchRow> = {}): BranchRow {
  return {
    additions: 42,
    ahead: null,
    baseBranch: "main",
    behind: null,
    branchName: ACME_BRANCH_NAME,
    checksPassed: null,
    checksStatus: null,
    checksTotal: null,
    deletions: 8,
    estimatedCostUsd: 12.34,
    filesChanged: 5,
    id: BRANCH_ID,
    lastActivityAt: BASE_TIME,
    multiPrWarning: false,
    owner: "Ada",
    prNumber: 123,
    prState: null,
    prTitle: "Wire web branches",
    prUrl: "https://github.com/acme/app/pull/123",
    repoFullName: "acme/app",
    reviewDecision: null,
    sessionIds: ["session-1"],
    status: BranchStatus.Open,
    ...overrides,
  };
}

export function makeDetail(
  overrides: Partial<BranchPageDetail> = {}
): BranchPageDetail {
  const sessions =
    overrides.id === "no-sessions"
      ? []
      : [
          {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            endedAt: BASE_TIME_PLUS_20_MIN,
            estimatedCostUsd: 1.23,
            harness: "codex",
            inputTokens: 100,
            isPrimary: true,
            name: "Session one",
            outputTokens: 200,
            ownerUserName: null,
            sessionId: "session-1",
            slug: null,
            startedAt: BASE_TIME,
          },
        ];
  return {
    ...makeBranchRow(),
    closedAt: null,
    commits: [],
    headSha: null,
    leadTime: { firstActivityT: null, idleSpans: [], lastActivityT: null },
    linkedArtifacts: [],
    linkedPrNumbers: [123],
    mergeCommitSha: null,
    mergedAt: null,
    mergedTrace: [],
    openedAt: BASE_TIME,
    prBody: "PR body",
    prBodyHtmlUrl: "https://github.com/acme/app/pull/123",
    selectedPullRequest: {
      additions: 42,
      // Null, not the row's `baseBranch`/`owner`: this fixture models a cloud
      // response for a PR whose ISS-8155 columns were never backfilled, and the
      // branch's current base is not this PR's measured target (ISS-8241).
      authorLogin: null,
      baseRefName: null,
      body: "PR body",
      changedFiles: 5,
      closedAt: null,
      deletions: 8,
      headRefOid: null,
      id: "acme/app#123",
      isDraft: false,
      mergeCommitSha: null,
      mergedAt: null,
      number: 123,
      openedAt: BASE_TIME,
      repositoryFullName: "acme/app",
      reviewDecision: null,
      state: GitHubPRState.Open,
      title: "Wire web branches",
      url: "https://github.com/acme/app/pull/123",
    },
    sessions,
    ...overrides,
  };
}

export function makeListResponse(items: BranchRow[]): BranchListResponse {
  return {
    items,
    total: items.length,
    viewerScope: BranchViewerScope.Organization,
  };
}

export function makeUsage(): BranchUsageSummary {
  return {
    apiEstimatedCost: 0,
    byActor: [],
    hourBuckets: [],
    phaseStacks: [],
    subscriptionEstimatedCost: 0,
    totalBranches: 1,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    viewerScope: BranchViewerScope.Organization,
  };
}

export function makeAnalytics(): BranchAnalytics {
  const kpi = {
    baseline30d: null,
    deltaPct: null,
    state: BranchKpiState.Available,
    value: 1,
  };
  return {
    activeBranchCount: kpi,
    activePrCount: kpi,
    buildVsReworkSplit: {
      buildPct: 100,
      reworkPct: 0,
      state: BranchKpiState.Available,
    },
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

export function makeComments(branchId: string): BranchPrCommentsResponse {
  return emptySyncedBranchComments({
    branchId,
    prNumber: 123,
    prUrl: "https://github.com/acme/app/pull/123",
    providerProofedAt: BASE_TIME,
  });
}

/**
 * The `/branches/<id>` sub-resources `branches-surface.spec.ts` has a body for.
 * Every other one — `refresh`, `compatibility`, `custom-field-values`, and
 * whatever ships next — declines rather than inheriting the branch-detail read
 * (ISS-7644). Lives beside the bodies below because the two are one contract:
 * a name here without a body there fails `tsc`.
 */
export const BRANCHES_SURFACE_SUB_RESOURCES = [
  BranchFixtureSubResource.Comments,
  BranchFixtureSubResource.SelectedPullRequest,
  BranchFixtureSubResource.Trace,
  BranchFixtureSubResource.TraceComments,
] as const;

/**
 * The body for one claimed sub-resource. The map is exhaustive, so a name added
 * to a fixture's claimed sub-resource list without a body here fails `tsc`
 * rather than silently inheriting the branch-detail read.
 */
export async function fulfillBranchSubResource(
  route: Route,
  subResource: BranchFixtureSubResource,
  branchId: string,
  trace?: () => readonly unknown[] | Promise<readonly unknown[]>
): Promise<void> {
  const bodies: Record<BranchFixtureSubResource, () => Promise<void>> = {
    [BranchFixtureSubResource.Comments]: () =>
      fulfillMockedApi(route, () => makeComments(branchId)),
    [BranchFixtureSubResource.SelectedPullRequest]: () =>
      route.fulfill({
        body: JSON.stringify({
          error: "Selected pull request evidence unavailable",
          success: false,
        }),
        contentType: "application/json",
        status: 503,
      }),
    [BranchFixtureSubResource.Trace]: () =>
      fulfillMockedApi(route, async () => ({
        items: await (trace?.() ?? []),
        total: 0,
      })),
    // The comments rail mounts unconditionally on branch detail and defaults
    // OPEN at >=1025px, so this read fires on every desktop navigation here.
    // Empty is the honest payload: nothing in this file asserts on native
    // comments, and declining it would leave a live network call in a spec that
    // mocks everything else.
    [BranchFixtureSubResource.TraceComments]: () =>
      fulfillMockedApi(route, () => []),
  };
  await bodies[subResource]();
}

export async function fulfillMockedApi<T>(
  route: Route,
  value: () => T | Promise<T>
) {
  try {
    await route.fulfill({
      body: JSON.stringify(success(await value())),
      contentType: "application/json",
      status: 200,
    });
  } catch (error) {
    if (error instanceof MockApiFailure) {
      await route.fulfill({
        body: JSON.stringify({ error: error.message, success: false }),
        contentType: "application/json",
        status: error.status,
      });
      return;
    }
    throw error;
  }
}

export class MockApiFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
