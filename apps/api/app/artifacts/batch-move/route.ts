import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { artifactsService } from "../service";
import { batchMoveArtifactsValidator } from "../validators";

/**
 * POST /artifacts/batch-move
 * Move multiple artifacts to a target project atomically.
 * Accepts an array of artifact IDs and a target project ID.
 */
export const POST = withAuth<string[], "/artifacts/batch-move">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        batchMoveArtifactsValidator
      );
      if (parseError) {
        return parseError;
      }

      const movedIds = await artifactsService.batchMove(
        body.artifactIds,
        body.targetProjectId,
        user.organizationId
      );

      return successResponse(movedIds);
    } catch (error) {
      return errorResponse("Failed to move artifacts", error);
    }
  }
);
