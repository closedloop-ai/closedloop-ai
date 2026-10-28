/**
 * Branch-coverage pins for app/judges-analytics/service.ts (ISS-11280): artifact counts and the CODE report type.
 * Targets arms not already exercised by
 * apps/api/__tests__/unit/judges-analytics-*.test.ts.
 *  - getArtifactCounts bucket/count folding.
 *  - the CODE report-type branch of getAggregateStats and the ?? 0 fallback
 *    for a doc type outside the human-data map.
 *
 * The human-ratings module is mocked here (its own arms are pinned in
 * service/human-ratings.branches.test.ts) so these cases control
 * humanRatingsByType/humanRatingsByArtifact directly.
 */
import { DocumentType } from "@repo/api/src/types/document";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HumanStats,
  mockDbWith,
} from "@/__tests__/support/judges-analytics/service.test-helpers";

const humanRatingsMocks = vi.hoisted(() => ({
  getPlanHumanData: vi.fn(),
  getCodeHumanData: vi.fn(),
  computeHumanStats: vi.fn(
    (_scores: number[]): HumanStats => ({
      humanMin: null,
      humanMax: null,
      humanMean: null,
      humanStdDev: null,
    })
  ),
}));

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ join: values }),
  },
  PromptType: { JUDGE: "JUDGE" },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

vi.mock("./service/human-ratings", () => ({
  getPlanHumanData: humanRatingsMocks.getPlanHumanData,
  getCodeHumanData: humanRatingsMocks.getCodeHumanData,
  computeHumanStats: humanRatingsMocks.computeHumanStats,
}));

import { judgesAnalyticsService } from "@/app/judges-analytics/service";

describe("getArtifactCounts — bucket/count folding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips non-positive-count rows and reuses an existing bucket entry for a second subtype", async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([
      { bucket: "2026-01-01", subtype: DocumentType.Prd, count: 5 },
      {
        bucket: "2026-01-01",
        subtype: DocumentType.ImplementationPlan,
        count: 3,
      },
      // Malformed/edge DB row: a non-positive count for a would-be new
      // bucket, which must never surface as an empty bucket entry.
      { bucket: "2026-01-02", subtype: DocumentType.Prd, count: 0 },
    ]);
    mockDbWith({ $queryRaw: queryRaw });

    const result = await judgesAnalyticsService.getArtifactCounts(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      "day"
    );

    expect(result.buckets).toEqual([
      {
        bucket: "2026-01-01",
        countsByType: {
          [DocumentType.Prd]: 5,
          [DocumentType.ImplementationPlan]: 3,
        },
      },
    ]);
    const call = queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(call.values).toContain("org-1");
    expect(call.values).toContain("day");
    expect(call.values).toEqual(
      expect.arrayContaining([new Date("2026-01-01"), new Date("2026-01-31")])
    );
  });
});

describe("getAggregateStats — CODE report type with non-empty groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls getCodeHumanData (not getPlanHumanData) and pools scores only for rated artifacts", async () => {
    humanRatingsMocks.getCodeHumanData.mockResolvedValue({
      humanRatingsByType: new Map([[DocumentType.Prd, 1]]),
      humanCommentsByType: new Map([[DocumentType.Prd, 1]]),
      humanRatingsByArtifact: new Map([["artifact-1", [0.8]]]),
    });
    humanRatingsMocks.computeHumanStats.mockImplementation((scores) => ({
      humanMin: scores.length > 0 ? Math.min(...scores) : null,
      humanMax: scores.length > 0 ? Math.max(...scores) : null,
      humanMean: scores.length > 0 ? scores[0] : null,
      humanStdDev: null,
    }));

    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          caseId: "clarity_judge",
          metricName: "clarity_judge",
          promptId: null,
          subtype: DocumentType.Prd,
          count: 2,
          sum: 1,
          sumSq: 0.68,
          min: 0.4,
          max: 0.6,
          // Two distinct artifacts pooled into one judge; only "artifact-1"
          // has a human rating in humanRatingsByArtifact.
          documentIds: ["artifact-1", "artifact-2"],
        },
      ]);
    const db = {
      prompt: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: queryRaw,
    };
    mockDbWith(db);

    const result = await judgesAnalyticsService.getAggregateStats(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      EvaluationReportType.Code
    );

    expect(humanRatingsMocks.getCodeHumanData).toHaveBeenCalledOnce();
    expect(humanRatingsMocks.getPlanHumanData).not.toHaveBeenCalled();
    // Only artifact-1's score [0.8] pooled in (artifact-2 has no entry in
    // humanRatingsByArtifact), so computeHumanStats saw exactly that array.
    expect(humanRatingsMocks.computeHumanStats).toHaveBeenCalledWith([0.8]);
    expect(result.groups[0]?.judges[0]?.humanMean).toBe(0.8);
    // The human-data fetch is scoped to this org/date-range/type-set/
    // artifact-id-set, not called blind.
    expect(humanRatingsMocks.getCodeHumanData).toHaveBeenCalledWith(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      [DocumentType.Prd],
      ["artifact-1", "artifact-2"]
    );
    const groupsCall = queryRaw.mock.calls[1][0] as { values: unknown[] };
    expect(groupsCall.values).toContain("org-1");
    expect(groupsCall.values).toContain(EvaluationReportType.Code);
  });

  it("falls back to 0 for a document type getCodeHumanData's counts map omits", async () => {
    humanRatingsMocks.getCodeHumanData.mockResolvedValue({
      // Two doc types come back from the aggregator (Prd + ImplementationPlan
      // groups below), but this map only carries one of them.
      humanRatingsByType: new Map([[DocumentType.Prd, 4]]),
      humanCommentsByType: new Map([[DocumentType.Prd, 2]]),
      humanRatingsByArtifact: new Map(),
    });
    humanRatingsMocks.computeHumanStats.mockReturnValue({
      humanMin: null,
      humanMax: null,
      humanMean: null,
      humanStdDev: null,
    });

    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          caseId: "clarity_judge",
          metricName: "clarity_judge",
          promptId: null,
          subtype: DocumentType.Prd,
          count: 1,
          sum: 0.5,
          sumSq: 0.25,
          min: 0.5,
          max: 0.5,
          documentIds: ["artifact-1"],
        },
        {
          caseId: "clarity_judge",
          metricName: "clarity_judge",
          promptId: null,
          subtype: DocumentType.ImplementationPlan,
          count: 1,
          sum: 0.5,
          sumSq: 0.25,
          min: 0.5,
          max: 0.5,
          documentIds: ["artifact-2"],
        },
      ]);
    const db = {
      prompt: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: queryRaw,
    };
    mockDbWith(db);

    const result = await judgesAnalyticsService.getAggregateStats(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      EvaluationReportType.Code
    );

    const prdGroup = result.groups.find(
      (g) => g.documentType === DocumentType.Prd
    );
    const planGroup = result.groups.find(
      (g) => g.documentType === DocumentType.ImplementationPlan
    );
    expect(prdGroup?.humanRatingsCount).toBe(4);
    expect(prdGroup?.humanCommentsCount).toBe(2);
    // pins current behavior; looks odd because a doc type absent from the
    // human-data map silently reads as 0 instead of surfacing the mismatch.
    expect(planGroup?.humanRatingsCount).toBe(0);
    expect(planGroup?.humanCommentsCount).toBe(0);
    const groupsCall = queryRaw.mock.calls[1][0] as { values: unknown[] };
    expect(groupsCall.values).toContain("org-1");
    expect(groupsCall.values).toContain(EvaluationReportType.Code);
  });
});
