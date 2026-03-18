import { success } from "@repo/api/src/types/common";
import type { JudgesFeedbackResponse } from "@repo/api/src/types/evaluation";
import { EvaluationReportType } from "@repo/database";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { artifactsService } from "../../service";

export const GET = withAuth<
  JudgesFeedbackResponse,
  "/artifacts/[id]/prd-judges"
>(async ({ user }, _request, params) => {
  const { id } = await params;

  const result = await artifactsService.getEvaluationFeedback(
    id,
    user.organizationId,
    EvaluationReportType.PRD
  );

  return NextResponse.json(success(result));
});
