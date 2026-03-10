import type { BatchJudgeScoresResponse } from "@repo/api/src/types/evaluation";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { artifactsService } from "../service";

/**
 * GET /artifacts/judge-scores?projectId=<id>
 * Batch-fetch the latest PLAN judge scores for all artifacts in a project.
 */
export const GET = withAnyAuth<
  BatchJudgeScoresResponse,
  "/artifacts/judge-scores"
>(async ({ user }, request) => {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return badRequestResponse("projectId is required");
    }

    const result = await artifactsService.getBatchJudgeScores(
      projectId,
      user.organizationId
    );

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch judge scores", error);
  }
});
