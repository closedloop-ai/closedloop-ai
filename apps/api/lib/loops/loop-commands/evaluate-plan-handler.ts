import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { createEvaluationHandler } from "./create-evaluation-handler";

export const evaluatePlanHandler = createEvaluationHandler({
  fileName: "plan-judges.json",
  uploadKey: "planJudges",
  reportType: EvaluationReportType.Plan,
  // Judges evaluate the plan against a checked-out code repo (grounding, conventions, etc.).
  requiresRepo: true,
  label: "plan",
});
