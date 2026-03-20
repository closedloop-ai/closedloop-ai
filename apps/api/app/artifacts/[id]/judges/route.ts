import { success } from "@repo/api/src/types/common";
import type { JudgesFeedbackResponse } from "@repo/api/src/types/evaluation";
import { EvaluationReportType } from "@repo/database";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
import { notFoundResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

export const GET = withAnyAuth<
  JudgesFeedbackResponse,
  "/artifacts/[id]/judges"
>(async ({ user }, _request, params) => {
  const { id } = await params;
  const resolvedId = await resolveArtifactId(id, user.organizationId);
  if (!resolvedId) {
    return notFoundResponse("Artifact");
  }

  const result = await artifactsService.getEvaluationFeedback(
    resolvedId,
    user.organizationId,
    EvaluationReportType.PLAN
  );

  return NextResponse.json(success(result));
});
