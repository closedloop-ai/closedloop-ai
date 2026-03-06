import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "../../service";

/**
 * GET /projects/by-slug/:slug - Get a single project by slug
 */
export const GET = withAnyAuth<ProjectWithDetails, "/projects/by-slug/[slug]">(
  async ({ user }, _, params) => {
    try {
      const { slug } = await params;
      const project = await projectsService.findBySlug(
        slug,
        user.organizationId
      );

      if (!project) {
        return notFoundResponse("Project");
      }

      return successResponse(project);
    } catch (error) {
      return errorResponse("Failed to fetch project", error);
    }
  }
);
