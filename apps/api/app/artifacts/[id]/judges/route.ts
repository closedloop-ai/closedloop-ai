import { success } from "@repo/api/src/types/common";
import type { JudgesFeedbackResponse } from "@repo/api/src/types/evaluation";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
import { notFoundResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

export const GET = withAuth<JudgesFeedbackResponse, "/artifacts/[id]/judges">(
  async ({ user }, _request, params) => {
    const { id } = await params;
    const resolvedId = await resolveArtifactId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const result = await artifactsService.getJudgesFeedback(
      resolvedId,
      user.organizationId
    );

    return NextResponse.json(success(result));
  }
);
