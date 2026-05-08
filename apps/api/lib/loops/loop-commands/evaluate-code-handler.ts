import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { createEvaluationHandler } from "./create-evaluation-handler";

export const evaluateCodeHandler = createEvaluationHandler({
  fileName: "code-judges.json",
  uploadKey: "codeJudges",
  reportType: EvaluationReportType.Code,
  requiresRepo: true,
  label: "code",
});
