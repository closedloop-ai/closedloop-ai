import { EvaluationReportType } from "@repo/api/src/types/evaluation";

export function paramsReportType(extra?: Record<string, unknown>) {
  return (
    (extra?.reportType as EvaluationReportType | undefined) ??
    EvaluationReportType.Plan
  );
}
