import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { projectsService } from "../service";
import { reorderProjectsValidator } from "../validators";

/**
 * POST /projects/reorder
 * Reorder projects by setting sortOrder values.
 * Accepts an array of project IDs in the desired order.
 */
export const POST = withAuth<string[], "/projects/reorder">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        reorderProjectsValidator
      );
      if (parseError) {
        return parseError;
      }

      const reorderedIds = await projectsService.reorder(
        body.projectIds,
        user.organizationId
      );

      return successResponse(reorderedIds);
    } catch (error) {
      return errorResponse("Failed to reorder projects", error);
    }
  }
);
