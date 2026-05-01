import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { createEvaluationHandler } from "./create-evaluation-handler";

export const evaluateFeatureHandler = createEvaluationHandler({
  fileName: "feature-judges.json",
  uploadKey: "featureJudges",
  reportType: EvaluationReportType.Feature,
  requiresRepo: false,
  label: "feature",
});
