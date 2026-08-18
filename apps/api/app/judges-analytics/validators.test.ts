import {
  EvaluationReportType,
  EvaluationReportTypeAlias,
} from "@repo/api/src/types/evaluation";
import { describe, expect, it } from "vitest";
import {
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
    expect(
      judgesAnalyticsQueryValidator.safeParse({
        ...VALID_RANGE,
        reportType: "NONSENSE",
      }).success
    ).toBe(false);
  });

  it("normalizes ISSUE in the score-comparison validator too", () => {
    const parsed = scoreComparisonQueryValidator.parse({
      reportType: EvaluationReportTypeAlias.Issue,
    });

    expect(parsed.reportType).toBe(EvaluationReportType.Feature);
  });
});
