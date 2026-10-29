/**
 * Branch-coverage pins for app/judges-analytics/service.ts (ISS-11280): aggregation keys and prompt descriptions.
 * Targets arms not already exercised by
 * apps/api/__tests__/unit/judges-analytics-*.test.ts.
 *  - the aggregation-key / route-name resolvers (collision + fallback arms)
 *    and the zero-count group skip in JudgeScoreAggregator.addGroup.
 *  - the prompt-description reduce (latest version wins) and the
 *    metric-collision detector in getAggregateStats.
 *
 * The human-ratings module is mocked here (its own arms are pinned in
 * service/human-ratings.branches.test.ts) so these cases control
 * humanRatingsByType/humanRatingsByArtifact directly.
 */
import { DocumentType } from "@repo/api/src/types/document";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyHumanData,
  type HumanStats,
  mockDbWith,
  scoreGroup,
  scoreRow,
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

import {
  aggregateJudgeScoreGroups,
  aggregateJudgeScoreRows,
  type JudgeScoreInput,
  judgesAnalyticsService,
} from "@/app/judges-analytics/service";

describe("aggregateJudgeScoreGroups — zero-count group skip", () => {
  it("drops a zero-count group entirely, keeping only the non-zero group's key", () => {
    const result = aggregateJudgeScoreGroups([
      scoreGroup({ metricName: "zero-metric", count: 0, documentIds: [] }),
      scoreGroup({ metricName: "real-metric" }),
    ]);

    const judgeMap = result.get(DocumentType.Prd);
    expect(judgeMap?.has("zero-metric")).toBe(false);
    expect(judgeMap?.has("real-metric")).toBe(true);
    expect(judgeMap?.size).toBe(1);
  });
});

describe("resolveAggregationKey / resolvePromptRouteName — collision + fallback arms", () => {
  it('falls back to "unknown" when a colliding metric\'s row has no promptId', () => {
    const rows: JudgeScoreInput[] = [
      scoreRow({ metricName: "clarity_judge", promptId: "prompt-a" }),
      scoreRow({ metricName: "clarity_judge", promptId: "prompt-b" }),
      scoreRow({ metricName: "clarity_judge", promptId: null, caseId: "x" }),
    ];
    const collisionMetrics = new Set(["clarity_judge"]);
    const promptNameById = new Map([
      ["prompt-a", "judge_a"],
      ["prompt-b", "judge_b"],
    ]);

    const result = aggregateJudgeScoreRows(
      rows,
      collisionMetrics,
      promptNameById
    );
    const judgeMap = result.get(DocumentType.Prd);
    expect(judgeMap?.has("unknown-clarity_judge")).toBe(true);
  });

  it("falls back to the raw metricName when a colliding row's promptId has no name mapping", () => {
    const rows: JudgeScoreInput[] = [
      scoreRow({
        metricName: "clarity_judge",
        promptId: "prompt-unmapped",
        caseId: "x",
      }),
    ];
    // Passing collisionMetrics explicitly (as if detected upstream) without a
    // matching promptNameById entry exercises the `?? row.metricName` and
    // `?? normalizeJudgeName(caseId)` fallbacks together.
    const result = aggregateJudgeScoreRows(
      rows,
      new Set(["clarity_judge"]),
      new Map()
    );
    const judgeMap = result.get(DocumentType.Prd);
    // aggregationKey = `${promptName}-${metricName}` where promptName fell
    // back to metricName itself (the `??` right-hand side).
    expect(judgeMap?.has("clarity_judge-clarity_judge")).toBe(true);
    const judgeData = judgeMap?.get("clarity_judge-clarity_judge");
    // promptName (used as judgeData.promptName) also fell back — this time to
    // normalizeJudgeName(caseId), because promptNameById has no entry either.
    expect(judgeData?.promptName).toBe("x");
  });
});

describe("getAggregateStats — prompt description reduce (latest version wins)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    humanRatingsMocks.getPlanHumanData.mockResolvedValue(emptyHumanData());
  });

  it("keeps the highest-version description per normalized prompt name", async () => {
    const queryRaw = vi
      .fn()
      // getJudgeDescriptionByPromptName: two raw rows normalizing to the same
      // name, version 1 then version 2 — exercises both the
      // `existing === undefined` (first row) and `version > existing.version`
      // (second row replaces) arms of the reduce.
      .mockResolvedValueOnce([
        { name: "clarity_judge", description: "old", version: 1 },
        { name: "clarity_judge", description: "new latest", version: 2 },
        // A third same-name row with a LOWER version than what's already
        // latest: `existing !== undefined` and `version > existing.version`
        // both false, so the reduce's `if` must skip replacing "new latest".
        { name: "clarity_judge", description: "stale", version: 1 },
        // A fourth row with a TIED version: `version > existing.version`
        // (strict) is false at 2 > 2, so "new latest" must survive. A `>=`
        // mutant would replace it with this row instead.
        { name: "clarity_judge", description: "tied-version dupe", version: 2 },
      ])
      // getAggregateJudgeScoreGroups
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
      EvaluationReportType.Plan
    );

    const judge = result.groups[0]?.judges.find(
      (j) => j.judgeName === "clarity_judge"
    );
    expect(judge?.description).toBe("new latest");
    // Both canned $queryRaw calls are bound to this org (A3): the description
    // lookup's DISTINCT ON prompt_registry scan, and the aggregate-groups scan.
    const descriptionCall = queryRaw.mock.calls[0][0] as {
      strings: string[];
      values: unknown[];
    };
    expect(descriptionCall.strings.join(" ")).toContain("prompt_registry");
    expect(descriptionCall.values).toContain("org-1");
    const groupsCall = queryRaw.mock.calls[1][0] as { values: unknown[] };
    expect(groupsCall.values).toContain("org-1");
    expect(groupsCall.values).toContain(EvaluationReportType.Plan);
  });
});

describe("getAggregateStats — single (non-colliding) promptId per metric", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    humanRatingsMocks.getPlanHumanData.mockResolvedValue(emptyHumanData());
  });

  it("does not disambiguate the aggregation key when a metric has exactly one promptId", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          caseId: "brevity_judge",
          metricName: "brevity_judge",
          promptId: "prompt-solo",
          subtype: DocumentType.Prd,
          count: 1,
          sum: 0.5,
          sumSq: 0.25,
          min: 0.5,
          max: 0.5,
          documentIds: ["artifact-1"],
        },
      ]);
    const db = {
      prompt: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "prompt-solo", description: "d" }]),
      },
      $queryRaw: queryRaw,
    };
    mockDbWith(db);

    const result = await judgesAnalyticsService.getAggregateStats(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      EvaluationReportType.Plan
    );

    const judges = result.groups[0]?.judges ?? [];
    expect(judges.map((j) => j.judgeName)).toEqual(["brevity_judge"]);
    // buildMetricNameDescriptionMap resolves descriptions by exactly the
    // promptIds present in the judge-score groups, not a blanket fetch.
    // pins current behavior; looks odd because this lookup has no
    // organizationId predicate at all — prompt_registry rows are resolved by
    // id alone, scoped only implicitly by which promptIds the (org-scoped)
    // judge-score groups query surfaced. Tracked in ISS-11319.
    expect(db.prompt.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["prompt-solo"] } },
      select: { id: true, description: true },
    });
    const groupsCall = queryRaw.mock.calls[1][0] as { values: unknown[] };
    expect(groupsCall.values).toContain("org-1");
    expect(groupsCall.values).toContain(EvaluationReportType.Plan);
  });
});

describe("getAggregateStats — metric collision skips an already-mapped description key", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    humanRatingsMocks.getPlanHumanData.mockResolvedValue(emptyHumanData());
  });

  it("keeps the first-seen description when two groups resolve to the same key", async () => {
    // Row 2 deliberately has NO promptId, so its description would resolve
    // via the promptName-based fallback map (a DIFFERENT source, and a
    // DIFFERENT value here) if the "already mapped" skip did not fire —
    // proving the skip actually runs, not just that both rows happen to
    // agree on the description.
    const queryRaw = vi
      .fn()
      // getJudgeDescriptionByPromptName: the promptName-based fallback map
      // row 2 would resolve to if the skip were removed.
      .mockResolvedValueOnce([
        {
          name: "brevity_judge",
          description: "fallback description",
          version: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          caseId: "brevity_judge",
          metricName: "brevity_judge",
          promptId: "prompt-1",
          subtype: DocumentType.Prd,
          count: 1,
          sum: 0.5,
          sumSq: 0.25,
          min: 0.5,
          max: 0.5,
          documentIds: ["artifact-1"],
        },
        {
          caseId: "brevity_judge",
          metricName: "brevity_judge",
          promptId: null,
          subtype: DocumentType.Prd,
          count: 1,
          sum: 0.7,
          sumSq: 0.49,
          min: 0.7,
          max: 0.7,
          documentIds: ["artifact-2"],
        },
      ]);
    const db = {
      prompt: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "prompt-1", description: "first description" },
          ]),
      },
      $queryRaw: queryRaw,
    };
    mockDbWith(db);

    const result = await judgesAnalyticsService.getAggregateStats(
      "org-1",
      new Date("2026-01-01"),
      new Date("2026-01-31"),
      EvaluationReportType.Plan
    );

    const judges = result.groups[0]?.judges ?? [];
    expect(judges).toHaveLength(1);
    expect(judges[0]?.description).toBe("first description");
    // Both groups shared the same key, so their power sums combined.
    expect(judges[0]?.documentsEvaluated).toBe(2);
    const groupsCall = queryRaw.mock.calls[1][0] as { values: unknown[] };
    expect(groupsCall.values).toContain("org-1");
    expect(groupsCall.values).toContain(EvaluationReportType.Plan);
  });
});

describe("getAggregateStats — collision detection's promptNameById builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    humanRatingsMocks.getPlanHumanData.mockResolvedValue(emptyHumanData());
  });

  it("skips a promptId-less row when building promptNameById for an active collision", async () => {
    // "clarity_judge" collides (two distinct promptIds) so collisionMetrics
    // is non-empty and the promptNameById-building loop runs; the third row
    // ("other_judge", promptId: null) exercises its `row.promptId && ...`
    // guard's false arm without contributing a promptNameById entry.
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          caseId: "judge_alpha",
          metricName: "clarity_judge",
          promptId: "prompt-a",
          subtype: DocumentType.Prd,
          count: 1,
          sum: 0.5,
          sumSq: 0.25,
          min: 0.5,
          max: 0.5,
          documentIds: ["artifact-1"],
        },
        {
          caseId: "judge_beta",
          metricName: "clarity_judge",
          promptId: "prompt-b",
          subtype: DocumentType.Prd,
          count: 1,
          sum: 0.7,
          sumSq: 0.49,
          min: 0.7,
          max: 0.7,
          documentIds: ["artifact-2"],
        },
        {
          caseId: "other_judge",
          metricName: "other_judge",
          promptId: null,
          subtype: DocumentType.Prd,
          count: 1,
          sum: 0.3,
          sumSq: 0.09,
          min: 0.3,
          max: 0.3,
          documentIds: ["artifact-3"],
        },
        // A second row reusing "prompt-a" (already mapped by judge_alpha's
        // row above) under a DIFFERENT caseId: the `!promptNameById.has(...)`
        // half of the guard must keep the FIRST-seen mapping ("judge_alpha"),
        // not overwrite it with this row's name. A mutant that always runs
        // the body would retroactively rename judge_alpha's own key too,
        // since promptNameById is built before aggregation reads it.
        {
          caseId: "judge_alpha_imposter",
          metricName: "clarity_judge",
          promptId: "prompt-a",
          subtype: DocumentType.Prd,
          count: 1,
          sum: 0.4,
          sumSq: 0.16,
          min: 0.4,
          max: 0.4,
          documentIds: ["artifact-4"],
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
      EvaluationReportType.Plan
    );

    const judges = result.groups[0]?.judges ?? [];
    // The colliding metric disambiguates by prompt-derived name; the
    // non-colliding "other_judge" row keeps its raw metric name as the key.
    // "judge_alpha_imposter"'s row merges into judge_alpha's key (same
    // promptId), proving the first-seen mapping held rather than being
    // overwritten.
    expect(judges.map((j) => j.judgeName).sort()).toEqual(
      [
        "judge_alpha-clarity_judge",
        "judge_beta-clarity_judge",
        "other_judge",
      ].sort()
    );
    const clarityAlpha = judges.find(
      (j) => j.judgeName === "judge_alpha-clarity_judge"
    );
    expect(clarityAlpha?.documentsEvaluated).toBe(2);
    // The grouped-score query is bound to this org and reportType — the
    // collision math above only makes sense scoped to a single org's rows.
    const groupsCall = queryRaw.mock.calls[1][0] as { values: unknown[] };
    expect(groupsCall.values).toContain("org-1");
    expect(groupsCall.values).toContain(EvaluationReportType.Plan);
  });
});
