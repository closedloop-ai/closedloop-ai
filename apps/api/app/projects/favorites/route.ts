import type { ProjectWithDetails } from "@repo/api/src/types/organization";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { projectsService } from "../service";

/**
 * GET /projects/favorites - List the current user's favorite projects
 */
export const GET = withAuth<ProjectWithDetails[], "/projects/favorites">(
  async ({ user }) => {
    try {
      const projects = await projectsService.findFavoritesByUser(
        user.id,
        user.organizationId
      );

      return successResponse(
        projects.map((p) => projectsService.toProjectWithDetails(p))
      );
    } catch (error) {
      return errorResponse("Failed to fetch favorite projects", error);
    }
  }
);
