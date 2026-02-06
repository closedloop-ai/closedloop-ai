import { success } from "@repo/api/src/types/common";
import type { JudgesFeedbackResponse } from "@repo/api/src/types/evaluation";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { artifactsService } from "../../service";

export const GET = withAuth<JudgesFeedbackResponse, "/artifacts/[id]/judges">(
  async ({ user }, _request, params) => {
    const { id } = await params;

    const result = await artifactsService.getJudgesFeedback(
      id,
      user.organizationId
    );

    return NextResponse.json(success(result));
  }
);
