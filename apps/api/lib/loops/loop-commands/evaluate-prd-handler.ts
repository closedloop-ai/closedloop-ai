import { EvaluationReportType } from "@repo/database";
import { createEvaluationHandler } from "./create-evaluation-handler";

export const evaluatePrdHandler = createEvaluationHandler({
  fileName: "prd-judges.json",
  uploadKey: "prdJudges",
  reportType: EvaluationReportType.PRD,
  requiresRepo: false,
  label: "PRD",
});
