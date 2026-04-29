import { success } from "@repo/api/src/types/common";
import type { JudgesFeedbackResponse } from "@repo/api/src/types/evaluation";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { documentEvaluationService } from "../../evaluation-service";

export const GET = withAnyAuth<
  JudgesFeedbackResponse,
  "/documents/[id]/prd-judges"
>(async ({ user }, _request, params) => {
  const { id } = await params;

  const result = await documentEvaluationService.getEvaluationFeedback(
    id,
    user.organizationId,
    EvaluationReportType.Prd
  );

  return NextResponse.json(success(result));
});
