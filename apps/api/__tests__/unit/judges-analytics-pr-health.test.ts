/**
 * Unit tests for judgesAnalyticsService.getPrHealthMetrics.
 *
 * Covers: mixed PR states, empty state, all-open PRs, zero-comment PRs,
 * zero-fill timeline, abandoned CLOSED PRs, cross-org null return, and
 * the privacy invariant (body/authorLogin/authorAvatarUrl never in response).
 */
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { PR_TIMELINE_GRANULARITY_OPTIONS } from "@repo/api/src/types/judges-analytics";
import { vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  PromptType: { JUDGE: "JUDGE" },
  GitHubPRState: { OPEN: "OPEN", MERGED: "MERGED", CLOSED: "CLOSED" },
}));

import { GitHubPRState } from "@repo/database";
import { judgesAnalyticsService } from "@/app/judges-analytics/service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = "org-test";
const START_DATE = new Date("2026-01-01T00:00:00Z");
const END_DATE = new Date("2026-01-31T23:59:59Z");

type PrStub = {
  id: string;
  state: string;
  createdAt: Date;
  mergedAt: Date | null;
  reviewComments: { id: string }[];
};

function makePr(
  id: string,
  state: string,
  createdAt: Date,
  mergedAt: Date | null,
  reviewCommentCount = 0
): PrStub {
  return {
    id,
    state,
    createdAt,
    mergedAt,
    reviewComments: Array.from({ length: reviewCommentCount }, (_, i) => ({
      id: `rc-${id}-${i}`,
    })),
  };
}

function makeJudgeScoreWithPrs(prs: PrStub[]) {
  return {
    evaluation: {
      artifact: {
        pullRequests: prs,
      },
    },
  };
}

function buildMockDb(
  promptNames: string[],
  judgeScores: ReturnType<typeof makeJudgeScoreWithPrs>[]
) {
  const db = {
    prompt: {
      findMany: vi.fn().mockResolvedValue(
        promptNames.map((name, i) => ({
          id: `prompt-${i}`,
          name,
          version: 1,
          content: "judge content",
          createdAt: new Date("2026-01-01"),
        }))
      ),
    },
    judgeScore: {
      findMany: vi.fn().mockResolvedValue(judgeScores),
    },
  };
  mockWithDbCall(db);
  return db;
}

function callGetPrHealthMetrics(
  granularity: (typeof PR_TIMELINE_GRANULARITY_OPTIONS)[keyof typeof PR_TIMELINE_GRANULARITY_OPTIONS] = PR_TIMELINE_GRANULARITY_OPTIONS.Week
) {
  return judgesAnalyticsService.getPrHealthMetrics(
    ORG_ID,
    "clarity",
    EvaluationReportType.Plan,
    START_DATE,
    END_DATE,
    granularity
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("judgesAnalyticsService.getPrHealthMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when resolveJudgePromptIds finds no matching prompts for the organizationId", async () => {
    buildMockDb([], []);

    const result = await callGetPrHealthMetrics();

    expect(result).toBeNull();
  });

  it("returns zero counts and null avgApprovalHours when no judgeScore rows exist", async () => {
    buildMockDb(["clarity_judge"], []);

    const result = await callGetPrHealthMetrics();

    expect(result).not.toBeNull();
    expect(result?.totalPrs).toBe(0);
    expect(result?.openPrs).toBe(0);
    expect(result?.avgApprovalHours).toBeNull();
    expect(result?.avgCommentCount).toBe(0);
    expect(result?.totalCommentCount).toBe(0);
    expect(result?.approvalDistribution).toEqual({
      lt1d: 0,
      "1to3d": 0,
      "3to7d": 0,
      gt7d: 0,
    });
  });

  it("computes correct aggregate metrics for mixed PR states (2 merged, 1 open, 1 closed/abandoned)", async () => {
    // merged in < 24h → lt1d bucket
    const mergedFast = makePr(
      "pr-merged-fast",
      GitHubPRState.MERGED,
      new Date("2026-01-05T00:00:00Z"),
      new Date("2026-01-05T12:00:00Z"),
      3
    );
    // merged in ~48h → 1to3d bucket
    const mergedSlow = makePr(
      "pr-merged-slow",
      GitHubPRState.MERGED,
      new Date("2026-01-08T00:00:00Z"),
      new Date("2026-01-10T00:00:00Z"),
      1
    );
    const openPr = makePr(
      "pr-open",
      GitHubPRState.OPEN,
      new Date("2026-01-15T00:00:00Z"),
      null,
      0
    );
    const closedAbandoned = makePr(
      "pr-closed",
      GitHubPRState.CLOSED,
      new Date("2026-01-20T00:00:00Z"),
      null,
      2
    );

    buildMockDb(
      ["clarity_judge"],
      [makeJudgeScoreWithPrs([mergedFast, mergedSlow, openPr, closedAbandoned])]
    );

    const result = await callGetPrHealthMetrics();

    expect(result?.totalPrs).toBe(4);
    expect(result?.openPrs).toBe(1);

    // avgApprovalHours: mean of [12h, 48h] = 30h
    expect(result?.avgApprovalHours).toBeCloseTo(30, 5);

    // approval distribution from merged PRs only
    expect(result?.approvalDistribution.lt1d).toBe(1); // 12h < 24h
    expect(result?.approvalDistribution["1to3d"]).toBe(1); // 48h
    expect(result?.approvalDistribution["3to7d"]).toBe(0);
    expect(result?.approvalDistribution.gt7d).toBe(0);

    // totalCommentCount: 3 + 1 + 0 + 2 = 6
    expect(result?.totalCommentCount).toBe(6);
    // avgCommentCount: 6 / 4 = 1.5
    expect(result?.avgCommentCount).toBeCloseTo(1.5, 5);
  });

  it("sets avgApprovalHours to null (not 0) when all PRs have state OPEN", async () => {
    const pr1 = makePr(
      "pr-open-1",
      "OPEN",
      new Date("2026-01-10T00:00:00Z"),
      null,
      0
    );
    const pr2 = makePr(
      "pr-open-2",
      "OPEN",
      new Date("2026-01-12T00:00:00Z"),
      null,
      0
    );

    buildMockDb(["clarity_judge"], [makeJudgeScoreWithPrs([pr1, pr2])]);

    const result = await callGetPrHealthMetrics();

    expect(result?.avgApprovalHours).toBeNull();
    expect(result?.totalPrs).toBe(2);
    expect(result?.openPrs).toBe(2);
  });

  it("reports zero comment counts when all PRs have no review comments", async () => {
    const pr1 = makePr(
      "pr-a",
      "MERGED",
      new Date("2026-01-03T00:00:00Z"),
      new Date("2026-01-03T06:00:00Z"),
      0
    );
    const pr2 = makePr(
      "pr-b",
      "OPEN",
      new Date("2026-01-10T00:00:00Z"),
      null,
      0
    );

    buildMockDb(["clarity_judge"], [makeJudgeScoreWithPrs([pr1, pr2])]);

    const result = await callGetPrHealthMetrics();

    expect(result?.avgCommentCount).toBe(0);
    expect(result?.totalCommentCount).toBe(0);
  });

  it("excludes CLOSED PRs with no mergedAt from avgApprovalHours and openPrs count", async () => {
    const closedAbandoned = makePr(
      "pr-abandoned",
      "CLOSED",
      new Date("2026-01-04T00:00:00Z"),
      null,
      0
    );
    const mergedPr = makePr(
      "pr-merged",
      "MERGED",
      new Date("2026-01-05T00:00:00Z"),
      new Date("2026-01-05T04:00:00Z"),
      0
    );

    buildMockDb(
      ["clarity_judge"],
      [makeJudgeScoreWithPrs([closedAbandoned, mergedPr])]
    );

    const result = await callGetPrHealthMetrics();

    expect(result?.totalPrs).toBe(2);
    expect(result?.openPrs).toBe(0); // CLOSED is not OPEN
    // avgApprovalHours uses only the merged PR (4h), not the abandoned one
    expect(result?.avgApprovalHours).toBeCloseTo(4, 5);
  });

  it("zero-fills all weekly timeline buckets between startDate and endDate even when no PRs fall in some weeks", async () => {
    // Only one PR, created in the first week of January 2026
    const pr = makePr(
      "pr-only",
      "OPEN",
      new Date("2026-01-05T00:00:00Z"),
      null,
      0
    );

    buildMockDb(["clarity_judge"], [makeJudgeScoreWithPrs([pr])]);

    const result = await callGetPrHealthMetrics(
      PR_TIMELINE_GRANULARITY_OPTIONS.Week
    );

    expect(result).not.toBeNull();

    // Every bucket must be present and have openedCount >= 0
    for (const point of result!.timeline) {
      expect(point.openedCount).toBeGreaterThanOrEqual(0);
    }

    // Start: 2026-01-01 is a Thursday; ISO week start (Monday) is 2025-12-29 → first bucket key
    // End: 2026-01-31; week containing Jan 31 starts on Jan 26 → last bucket key "2026-01-26"
    // We should have multiple buckets
    expect(result!.timeline.length).toBeGreaterThan(1);

    // Confirm all buckets are sorted
    const buckets = result!.timeline.map((p) => p.bucket);
    const sorted = [...buckets].sort();
    expect(buckets).toEqual(sorted);

    // The week with our PR should have openedCount = 1; all others = 0
    const prBucket = "2026-01-05"; // Monday of the week containing Jan 5 is Jan 5
    const prWeekPoint = result!.timeline.find((p) => p.bucket === prBucket);
    expect(prWeekPoint?.openedCount).toBe(1);

    // At least one bucket should have 0
    const zeroBuckets = result!.timeline.filter((p) => p.openedCount === 0);
    expect(zeroBuckets.length).toBeGreaterThan(0);
  });

  it("deduplicates PRs appearing in multiple judgeScore rows", async () => {
    const sharedPr = makePr(
      "pr-shared",
      "MERGED",
      new Date("2026-01-06T00:00:00Z"),
      new Date("2026-01-06T12:00:00Z"),
      2
    );

    // Same PR referenced from two separate judgeScore rows
    buildMockDb(
      ["clarity_judge"],
      [makeJudgeScoreWithPrs([sharedPr]), makeJudgeScoreWithPrs([sharedPr])]
    );

    const result = await callGetPrHealthMetrics();

    expect(result?.totalPrs).toBe(1);
    expect(result?.totalCommentCount).toBe(2);
  });

  it("does not include body, authorLogin, or authorAvatarUrl in the response JSON", async () => {
    const pr = makePr(
      "pr-privacy",
      "OPEN",
      new Date("2026-01-10T00:00:00Z"),
      null,
      1
    );

    buildMockDb(["clarity_judge"], [makeJudgeScoreWithPrs([pr])]);

    const result = await callGetPrHealthMetrics();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("body");
    expect(serialized).not.toContain("authorLogin");
    expect(serialized).not.toContain("authorAvatarUrl");
  });
});
