import { success } from "@repo/api/src/types/common";
import type { JudgesFeedbackResponse } from "@repo/api/src/types/evaluation";
import { EvaluationReportType } from "@repo/api/src/types/evaluation";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { notFoundResponse } from "@/lib/route-utils";
import { documentsService } from "../../service";

export const GET = withAnyAuth<
  JudgesFeedbackResponse,
  "/documents/[id]/code-judges"
>(async ({ user }, _request, params) => {
  const { id } = await params;
  const resolvedId = await resolveDocumentId(id, user.organizationId);
  if (!resolvedId) {
    return notFoundResponse("Document");
  }

  const result = await documentsService.getEvaluationFeedback(
    resolvedId,
    user.organizationId,
    EvaluationReportType.Code
  );

  return NextResponse.json(success(result));
});
