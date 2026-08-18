import { describe, expect, it } from "vitest";
import {
  EVALUATION_REPORT_TYPE_INPUT_TO_CANONICAL,
  EvaluationReportType,
  EvaluationReportTypeAlias,
  EvaluationReportTypeInput,
  normalizeEvaluationReportType,
} from "../evaluation";

// FEA-3956 (PRD-560 Phase 3): the evaluation report-type boundary accepts the
// canonical `ISSUE` in addition to the persisted `FEATURE`, mapping the
// canonical input back to `FEATURE`. Covers canonical + legacy shapes and the
// exhaustive mapping contract.

describe("EvaluationReportType ISSUE alias (FEA-3956)", () => {
  it("exposes ISSUE as the canonical input alias, not a persisted report type", () => {
    expect(EvaluationReportTypeAlias.Issue).toBe("ISSUE");
    expect(Object.values(EvaluationReportType)).not.toContain(
      EvaluationReportTypeAlias.Issue
    );
  });

  it("lists ISSUE in the accepted input superset alongside FEATURE", () => {
    const inputs = Object.values(EvaluationReportTypeInput);
    expect(inputs).toContain(EvaluationReportTypeAlias.Issue);
    expect(inputs).toContain(EvaluationReportType.Feature);
  });

  it("normalizes the canonical ISSUE report type to persisted FEATURE", () => {
    expect(normalizeEvaluationReportType(EvaluationReportTypeAlias.Issue)).toBe(
      EvaluationReportType.Feature
    );
  });

  it("still accepts legacy FEATURE unchanged (skew-safe compat alias)", () => {
    expect(normalizeEvaluationReportType(EvaluationReportType.Feature)).toBe(
      EvaluationReportType.Feature
    );
  });

  it("returns every other persisted report type unchanged", () => {
    for (const reportType of [
      EvaluationReportType.Plan,
      EvaluationReportType.Code,
      EvaluationReportType.Prd,
    ]) {
      expect(normalizeEvaluationReportType(reportType)).toBe(reportType);
    }
  });

  it("maps every accepted input to a persisted report type (exhaustive)", () => {
    for (const input of Object.values(EvaluationReportTypeInput)) {
      const canonical = EVALUATION_REPORT_TYPE_INPUT_TO_CANONICAL[input];
      expect(Object.values(EvaluationReportType)).toContain(canonical);
    }
  });
});
