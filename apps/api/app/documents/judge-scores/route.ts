import {
  type BatchJudgeScoresResponse,
  EvaluationReportType,
} from "@repo/api/src/types/evaluation";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { documentsService } from "../service";

/**
 * GET /artifacts/judge-scores?projectId=<id>
 * Batch-fetch the latest judge scores for all artifacts in a project,
 * grouped by report type (PLAN, PRD, CODE).
 */
export const GET = withAnyAuth<
  BatchJudgeScoresResponse,
  "/documents/judge-scores"
>(async ({ user }, request) => {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return badRequestResponse("projectId is required");
    }

    const result = await documentsService.getBatchJudgeScores(
      projectId,
      user.organizationId,
      Object.values(EvaluationReportType)
    );

    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch judge scores", error);
  }
});
