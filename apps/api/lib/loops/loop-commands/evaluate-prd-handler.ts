import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { createEvaluationHandler } from "./create-evaluation-handler";

export const evaluatePrdHandler = createEvaluationHandler({
  fileName: "prd-judges.json",
  uploadKey: "prdJudges",
  reportType: EvaluationReportType.Prd,
  requiresRepo: false,
  label: "PRD",
});
