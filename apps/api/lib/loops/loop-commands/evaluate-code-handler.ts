import { EvaluationReportType } from "@repo/database";
import { createEvaluationHandler } from "./create-evaluation-handler";

export const evaluateCodeHandler = createEvaluationHandler({
  fileName: "code-judges.json",
  uploadKey: "codeJudges",
  reportType: EvaluationReportType.CODE,
  requiresRepo: true,
  label: "code",
});
