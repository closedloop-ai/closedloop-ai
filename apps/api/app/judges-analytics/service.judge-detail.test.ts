/**
 * Branch-coverage pins for app/judges-analytics/service.ts (ISS-11280): judge detail and judge scores.
 * Targets arms not already exercised by
 * apps/api/__tests__/unit/judges-analytics-*.test.ts.
 *  - getJudgeDetail's null-resolution path and per-version radar threshold.
 *  - getJudgeScores' null documentSlug fallback and zero-coverage arm.
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
  sqlText,
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

describe("getJudgeDetail — resolution and per-version radar threshold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no prompt matches the normalized promptName", async () => {
    const db = {
      prompt: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn(),
    };
    mockDbWith(db);

    const result = await judgesAnalyticsService.getJudgeDetail(
      "org-1",
      "nonexistent",
      EvaluationReportType.Plan
    );

    expect(result).toBeNull();
    // resolveJudgePromptIds scopes the JUDGE-prompt lookup to this org before
    // ever filtering by promptName in app code.
    expect(db.prompt.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", promptType: "JUDGE" },
      select: {
        id: true,
        name: true,
        version: true,
        content: true,
        createdAt: true,
      },
      orderBy: { version: "desc" },
    });
  });

  it("only computes radar axes for versions meeting the minScoreCount threshold", async () => {
    const highCountScores = Array.from({ length: 12 }, (_, i) => 0.1 * (i % 9));
    const lowCountScores = [0.2, 0.4, 0.6];
    // Exactly at minScoreCount (10): `>=` (strict boundary, inclusive) must
    // still compute radar axes here. A `>` mutant would exclude it.
    const boundaryCountScores = Array.from(
      { length: 10 },
      (_, i) => 0.1 * (i % 9)
    );

    function moments(scores: number[]) {
      return {
        count: scores.length,
        sum: scores.reduce((a, b) => a + b, 0),
        sumSq: scores.reduce((a, b) => a + b * b, 0),
        sum3: scores.reduce((a, b) => a + b ** 3, 0),
        sum4: scores.reduce((a, b) => a + b ** 4, 0),
        min: Math.min(...scores),
        max: Math.max(...scores),
        extremeCount: 0,
      };
    }

    const queryRaw = vi.fn().mockResolvedValueOnce([
      { promptId: "prompt-high", ...moments(highCountScores) },
      { promptId: "prompt-low", ...moments(lowCountScores) },
      { promptId: "prompt-boundary", ...moments(boundaryCountScores) },
    ]);
    const db = {
      prompt: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "prompt-high",
            name: "clarity_judge",
            version: 3,
            content: "v3",
            createdAt: new Date("2026-01-10"),
          },
          {
            id: "prompt-low",
            name: "clarity_judge",
            version: 1,
            content: "v1",
            createdAt: new Date("2026-01-01"),
          },
          {
            id: "prompt-boundary",
            name: "clarity_judge",
            version: 2,
            content: "v2",
            createdAt: new Date("2026-01-05"),
          },
        ]),
      },
      $queryRaw: queryRaw,
    };
    mockDbWith(db);

    const result = await judgesAnalyticsService.getJudgeDetail(
      "org-1",
      "clarity",
      EvaluationReportType.Plan
    );

    const highVersion = result?.judge.promptVersions.find(
      (v) => v.promptId === "prompt-high"
    );
    const lowVersion = result?.judge.promptVersions.find(
      (v) => v.promptId === "prompt-low"
    );
    const boundaryVersion = result?.judge.promptVersions.find(
      (v) => v.promptId === "prompt-boundary"
    );
    expect(highVersion?.radarAxes).not.toBeNull();
    expect(lowVersion?.radarAxes).toBeNull();
    expect(boundaryVersion?.scoreCount).toBe(10);
    expect(boundaryVersion?.radarAxes).not.toBeNull();
    // The moments query is bound to exactly the three resolved promptIds
    // (nested inside a Prisma.join, hence flattened) and this org/reportType,
    // not a blanket per-prompt-name scan.
    const text = sqlText(queryRaw.mock.calls[0][0]).toLowerCase();
    expect(text).toContain('group by js."prompt_id"');
    expect(text).toContain("org-1");
    expect(text).toContain(EvaluationReportType.Plan.toLowerCase());
    expect(text).toContain("prompt-high");
    expect(text).toContain("prompt-low");
    expect(text).toContain("prompt-boundary");
  });
});

describe("getJudgeScores — null slug fallback and zero-coverage on a non-empty page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes a null documentSlug to an empty string", async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([
      {
        judgeScoreId: "js-1",
        metricName: "clarity_judge",
        documentId: "artifact-1",
        subtype: DocumentType.Prd,
        documentTitle: "Untitled",
        documentSlug: null,
        judgeScore: 0.5,
        avgUserRating: 0.5,
        userRatingCount: 0,
        delta: 0,
        evaluatedAt: new Date("2026-01-05"),
        totalRows: 1,
        ratedRows: 0,
      },
    ]);
    const db = {
      prompt: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "prompt-1", name: "clarity_judge" }]),
      },
      $queryRaw: queryRaw,
    };
    mockDbWith(db);

    const result = await judgesAnalyticsService.getJudgeScores(
      "org-1",
      "clarity",
      EvaluationReportType.Plan,
      1,
      25
    );

    expect(result?.rows[0]?.documentSlug).toBe("");
    // The page query is bound to the resolved promptIds (nested inside a
    // Prisma.join), this org/reportType, and the requested page/offset
    // (page=1 -> offset 0).
    const call = queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(call.values).toContain(EvaluationReportType.Plan);
    expect(call.values).toContain(25);
    expect(call.values).toContain(0);
    const text = sqlText(queryRaw.mock.calls[0][0]);
    expect(text).toContain("prompt-1");
    expect(text).toContain("org-1");
  });

  it("reports 0% coverage when the windowed totalRows on a non-empty page is 0", async () => {
    // A DB-row edge case (COUNT(*) OVER() reporting 0 alongside a returned
    // row) — malformed/inconsistent at the trust boundary, not something the
    // in-process types forbid, so the ternary's false arm is exercised here.
    const queryRaw = vi.fn().mockResolvedValueOnce([
      {
        judgeScoreId: "js-1",
        metricName: "clarity_judge",
        documentId: "artifact-1",
        subtype: DocumentType.Prd,
        documentTitle: "Doc",
        documentSlug: "doc-slug",
        judgeScore: 0.5,
        avgUserRating: 0.5,
        userRatingCount: 0,
        delta: 0,
        evaluatedAt: new Date("2026-01-05"),
        totalRows: 0,
        ratedRows: 0,
      },
    ]);
    const db = {
      prompt: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "prompt-1", name: "clarity_judge" }]),
      },
      $queryRaw: queryRaw,
    };
    mockDbWith(db);

    const result = await judgesAnalyticsService.getJudgeScores(
      "org-1",
      "clarity",
      EvaluationReportType.Plan,
      1,
      25
    );

    expect(result?.coveragePct).toBe(0);
    expect(result?.totalDocuments).toBe(0);
    const call = queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(call.values).toContain(EvaluationReportType.Plan);
    expect(call.values).toContain(25);
    expect(call.values).toContain(0);
    expect(sqlText(queryRaw.mock.calls[0][0])).toContain("prompt-1");
  });
});
