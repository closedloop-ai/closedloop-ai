import type { ProjectWithDetails } from "@repo/api/src/types/organization";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { projectsService } from "../service";

/**
 * GET /projects/favorites - List the current user's favorite projects
 */
export const GET = withAnyAuth<ProjectWithDetails[], "/projects/favorites">(
  async ({ user }) => {
    try {
      const projects = await projectsService.findFavoritesByUser(
        user.id,
        user.organizationId
      );

      return successResponse(projects);
    } catch (error) {
      return errorResponse("Failed to fetch favorite projects", error);
    }
  }
);
