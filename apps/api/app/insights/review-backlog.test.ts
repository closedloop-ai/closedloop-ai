/**
 * Focused unit tests for the review-queue snapshot (ISS-4629): the review-queue
 * chart and the "Review backlog" KPI are derived from ONE `pullRequestDetail`
 * `groupBy` so they cannot skew across reads, and the KPI is a provable subset of
 * the chart's PENDING (awaiting-review) bucket.
 *
 * Kept out of the shrink-only grandfathered `service.test.ts`: this exercises
 * `fetchReviewQueue` directly with a minimal `withDb` fake, so it needs none of
 * that file's heavy `makeFakeDb` harness.
 */

import { GitHubPRState } from "@repo/api/src/types/github";
import { InsightsScope } from "@repo/api/src/types/insights";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ChecksStatus: {
    UNKNOWN: "UNKNOWN",
    PENDING: "PENDING",
    PASSING: "PASSING",
    FAILING: "FAILING",
  },
  GitHubPRState: {
    CLOSED: GitHubPRState.Closed,
    MERGED: GitHubPRState.Merged,
    OPEN: GitHubPRState.Open,
  },
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
    PENDING_CLAIM: "PENDING_CLAIM",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
  ReviewDecision: {
    APPROVED: "APPROVED",
    CHANGES_REQUESTED: "CHANGES_REQUESTED",
    COMMENTED: "COMMENTED",
    DISMISSED: "DISMISSED",
  },
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: Array.from(strings),
      values,
    }),
    join: (items: unknown[], separator = ",") => ({
      strings: items
        .map((_, index) => (index === 0 ? "" : separator))
        .concat(""),
      values: items,
    }),
  },
}));

import { withDb } from "@repo/database";
import { fetchReviewQueue } from "./review-backlog";
import type { InsightsScopeContext } from "./service";

const ORG = "org-1";
const ORG_CTX: InsightsScopeContext = {
  organizationId: ORG,
  userId: "user-1",
  scope: InsightsScope.Org,
};

type GroupRow = {
  reviewDecision: string | null;
  prState: GitHubPRState;
  _count: { _all: number };
};

/**
 * Drive `fetchReviewQueue` against a `groupBy` that returns `rows` and record the
 * single `groupBy` args it was handed, so a test can assert both the derived
 * snapshot and the query shape (predicate + grouping keys) from one read.
 */
function runReviewQueue(rows: GroupRow[]) {
  const groupByArgs: { by?: unknown; where?: Record<string, unknown> }[] = [];
  const db = {
    pullRequestDetail: {
      groupBy: (a: { by?: unknown; where?: Record<string, unknown> }) => {
        groupByArgs.push(a);
        return Promise.resolve(rows);
      },
    },
  };
  vi.mocked(withDb).mockImplementation((cb) =>
    Promise.resolve(cb(db as never))
  );
  return { groupByArgs, run: () => fetchReviewQueue(ORG_CTX) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("fetchReviewQueue (ISS-4629)", () => {
  it("derives the chart buckets and the backlog KPI from ONE groupBy snapshot", async () => {
    // A single non-merged (OPEN + CLOSED) population, grouped by (decision,
    // state). Only the OPEN + null-decision cell is the "open PRs awaiting
    // review" backlog; the chart's PENDING bucket collapses OPEN + CLOSED nulls.
    const openAwaiting = 2;
    const closedNullDecision = 3;
    const openApproved = 4;
    const { groupByArgs, run } = runReviewQueue([
      {
        reviewDecision: null,
        prState: GitHubPRState.Open,
        _count: { _all: openAwaiting },
      },
      {
        reviewDecision: null,
        prState: GitHubPRState.Closed,
        _count: { _all: closedNullDecision },
      },
      {
        reviewDecision: "APPROVED",
        prState: GitHubPRState.Open,
        _count: { _all: openApproved },
      },
    ]);

    const { buckets, backlog } = await run();

    // Backlog counts ONLY the OPEN + null-decision cell — the CLOSED null row is
    // excluded (the pre-fix bug counted the whole null population regardless of
    // state, which would give openAwaiting + closedNullDecision).
    expect(backlog).toBe(openAwaiting);

    // Reconciliation: PENDING collapses OPEN + CLOSED nulls from the SAME
    // snapshot, so the backlog is a provable subset of it (never exceeds it).
    const pending = buckets.find((b) => b.key === "PENDING");
    expect(pending?.value).toBe(openAwaiting + closedNullDecision);
    expect(backlog).toBeLessThanOrEqual(pending?.value ?? 0);

    // Approved rows collapse across state into their own bucket.
    expect(buckets.find((b) => b.key === "APPROVED")?.value).toBe(openApproved);

    // ONE read backs both the chart and the KPI — no cross-read skew.
    expect(vi.mocked(withDb).mock.calls.length).toBe(1);
    expect(groupByArgs).toHaveLength(1);
    expect(groupByArgs[0]?.by).toEqual(["reviewDecision", "prState"]);
  });

  it("scopes the query to the org, drops MERGED, and excludes stale merged rows via mergedAt: null", async () => {
    const { groupByArgs, run } = runReviewQueue([]);
    await run();

    const where = groupByArgs[0]?.where ?? {};
    // Denormalized org predicate so the planner can lead with the
    // (organizationId, prState) index prefix (wongk: join-scope alone cannot).
    expect(where.organizationId).toBe(ORG);
    // Non-merged population bound for the chart.
    expect(where.prState).toEqual({ not: GitHubPRState.Merged });
    // A stale OPEN-but-merged row (state projection trailing the merge timestamp)
    // is classified MERGED downstream, so mergedAt: null keeps it out of both the
    // chart and the backlog (wongk).
    expect(where.mergedAt).toBeNull();
    // Still authorization-scoped by the branch artifact for Me/Team.
    expect(where.branchArtifact).toBeDefined();
  });
});
