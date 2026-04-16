import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { documentsService } from "../service";
import { batchMoveDocumentsValidator } from "../validators";

/**
 * POST /artifacts/batch-move
 * Move multiple artifacts to a target project atomically.
 * Accepts an array of artifact IDs and a target project ID.
 */
export const POST = withAuth<string[], "/documents/batch-move">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        batchMoveDocumentsValidator
      );
      if (parseError) {
        return parseError;
      }

      const movedIds = await documentsService.batchMove(
        body.documentIds,
        body.targetProjectId,
        user.organizationId
      );

      return successResponse(movedIds);
    } catch (error) {
      return errorResponse("Failed to move artifacts", error);
    }
  }
);
