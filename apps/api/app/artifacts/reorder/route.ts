import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { artifactsService } from "../service";
import { reorderArtifactsValidator } from "../validators";

/**
 * POST /artifacts/reorder
 * Reorder artifacts by setting sortOrder values.
 * Accepts an array of artifact IDs in the desired order.
 */
export const POST = withAuth<string[], "/artifacts/reorder">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        reorderArtifactsValidator
      );
      if (parseError) {
        return parseError;
      }

      const reorderedIds = await artifactsService.reorder(
        body.artifactIds,
        user.organizationId
      );

      return successResponse(reorderedIds);
    } catch (error) {
      return errorResponse("Failed to reorder artifacts", error);
    }
  }
);
