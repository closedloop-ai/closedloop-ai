import { EvaluationReportType } from "@repo/database";
import { createEvaluationHandler } from "./create-evaluation-handler";

export const evaluatePlanHandler = createEvaluationHandler({
  fileName: "plan-judges.json",
  uploadKey: "planJudges",
  reportType: EvaluationReportType.PLAN,
  requiresRepo: true,
  label: "plan",
});
