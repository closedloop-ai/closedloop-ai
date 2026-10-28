import {
  EvaluationReportType,
  EvaluationReportTypeAlias,
} from "@repo/api/src/types/evaluation";
import { DOCUMENT_COUNTS_GROUP_BY_OPTIONS } from "@repo/api/src/types/judges-analytics";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  artifactCountsQueryValidator,
  judgesAnalyticsQueryValidator,
  scoreComparisonQueryValidator,
} from "./validators";

const VALID_RANGE = { startDate: "2026-01-01", endDate: "2026-01-31" } as const;

describe("judges-analytics report-type validators (FEA-3956 ISSUE alias)", () => {
  it("accepts the canonical ISSUE report type and normalizes it to persisted FEATURE", () => {
    const parsed = judgesAnalyticsQueryValidator.parse({
      ...VALID_RANGE,
      reportType: EvaluationReportTypeAlias.Issue,
    });

    expect(parsed.reportType).toBe(EvaluationReportType.Feature);
  });

  it("passes legacy FEATURE through unchanged (skew case)", () => {
    const parsed = judgesAnalyticsQueryValidator.parse({
      ...VALID_RANGE,
      reportType: EvaluationReportType.Feature,
    });

    expect(parsed.reportType).toBe(EvaluationReportType.Feature);
  });

  it("passes a non-aliased report type through unchanged", () => {
    const parsed = judgesAnalyticsQueryValidator.parse({
      ...VALID_RANGE,
      reportType: EvaluationReportType.Plan,
    });

    expect(parsed.reportType).toBe(EvaluationReportType.Plan);
  });

  it("rejects an unknown report type", () => {
    const result = judgesAnalyticsQueryValidator.safeParse({
      ...VALID_RANGE,
      reportType: "NONSENSE",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.invalid_value,
        path: ["reportType"],
      });
    }
  });

  it("normalizes ISSUE in the score-comparison validator too", () => {
    const parsed = scoreComparisonQueryValidator.parse({
      reportType: EvaluationReportTypeAlias.Issue,
    });

    expect(parsed.reportType).toBe(EvaluationReportType.Feature);
  });
});

// ISS-7545 part two: `artifactCountsQueryValidator`, the shared start<=end
// refine, and the score-comparison page bounds had no coverage here at all.
describe("artifactCountsQueryValidator groupBy", () => {
  it.each(DOCUMENT_COUNTS_GROUP_BY_OPTIONS)("accepts groupBy=%s", (groupBy) => {
    const parsed = artifactCountsQueryValidator.parse({
      ...VALID_RANGE,
      groupBy,
    });

    expect(parsed.groupBy).toBe(groupBy);
  });

  it("rejects an unknown groupBy", () => {
    const result = artifactCountsQueryValidator.safeParse({
      ...VALID_RANGE,
      groupBy: "quarter",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.invalid_value,
        path: ["groupBy"],
      });
    }
  });

  // `groupBy` is required, so the artifact-counts route's
  // `extra?.groupBy ?? "day"` fallback cannot fire — a start/end-only request
  // 400s at the boundary before the handler reads `extra`. Pinned as a
  // rejection so making the schema default it becomes a deliberate change.
  it("rejects an omitted groupBy rather than defaulting it to day", () => {
    const result = artifactCountsQueryValidator.safeParse(VALID_RANGE);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.invalid_value,
        path: ["groupBy"],
      });
    }
  });
});

describe("shared date-range refine (startDate <= endDate)", () => {
  const INVERTED_RANGE = {
    startDate: "2026-02-01",
    endDate: "2026-01-01",
  } as const;

  it("accepts a single-day range where startDate equals endDate", () => {
    const parsed = judgesAnalyticsQueryValidator.parse({
      startDate: "2026-01-31",
      endDate: "2026-01-31",
      reportType: EvaluationReportType.Prd,
    });

    expect(parsed.startDate).toBe("2026-01-31");
  });

  // The refine declares no `path`, so the issue lands on the object root rather
  // than on either date field — the 400 body names no field.
  it("rejects an inverted range on the report-type query", () => {
    const result = judgesAnalyticsQueryValidator.safeParse({
      ...INVERTED_RANGE,
      reportType: EvaluationReportType.Prd,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "startDate must be less than or equal to endDate",
      });
    }
  });

  // Same refine, reached through the other `.extend()` — proves the shared base
  // survives extension on both consumers, not just the one that is exercised.
  it("rejects an inverted range on the artifact-counts query", () => {
    const result = artifactCountsQueryValidator.safeParse({
      ...INVERTED_RANGE,
      groupBy: DOCUMENT_COUNTS_GROUP_BY_OPTIONS[0],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.custom,
        path: [],
      });
    }
  });
});

// Pinned as REJECTIONS: neither `.pipe()` carries a `.catch()`, so a `pageSize`
// outside 1-100, or a `page` below 1, is a 400 rather than a silent clamp.
describe("scoreComparisonQueryValidator page bounds", () => {
  const BASE = { reportType: EvaluationReportType.Prd } as const;

  it("defaults page to 1 and pageSize to 20 when both are omitted", () => {
    const parsed = scoreComparisonQueryValidator.parse(BASE);

    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
  });

  it("accepts pageSize at the lower bound", () => {
    expect(
      scoreComparisonQueryValidator.parse({ ...BASE, pageSize: "1" }).pageSize
    ).toBe(1);
  });

  it("accepts pageSize at the upper bound", () => {
    expect(
      scoreComparisonQueryValidator.parse({ ...BASE, pageSize: "100" }).pageSize
    ).toBe(100);
  });

  it("rejects pageSize below the lower bound instead of clamping to 1", () => {
    const result = scoreComparisonQueryValidator.safeParse({
      ...BASE,
      pageSize: "0",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        path: ["pageSize"],
      });
    }
  });

  it("rejects pageSize above the upper bound instead of clamping to 100", () => {
    const result = scoreComparisonQueryValidator.safeParse({
      ...BASE,
      pageSize: "101",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.too_big,
        maximum: 100,
        path: ["pageSize"],
      });
    }
  });

  it("accepts page at the lower bound", () => {
    expect(
      scoreComparisonQueryValidator.parse({ ...BASE, page: "1" }).page
    ).toBe(1);
  });

  it("rejects page below the lower bound instead of clamping to 1", () => {
    const result = scoreComparisonQueryValidator.safeParse({
      ...BASE,
      page: "0",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        path: ["page"],
      });
    }
  });

  // `page` carries no `.max()` — only `pageSize` is capped. Pinned so the
  // asymmetry is deliberate rather than an omission a reader has to re-derive.
  it("accepts a page beyond the pageSize cap", () => {
    expect(
      scoreComparisonQueryValidator.parse({ ...BASE, page: "101" }).page
    ).toBe(101);
  });
});
