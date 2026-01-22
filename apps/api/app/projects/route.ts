import type { ProjectWithDetails } from "@repo/api/src/types/organization";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { projectsService } from "./service";
import { createProjectValidator } from "./validators";

/**
 * GET /projects - List all projects
 * Query params:
 *   - teamId: Filter by team
 */
export const GET = withAuth<ProjectWithDetails[], "/projects">(
  async ({ user }, request) => {
    try {
      const url = new URL(request.url);
      const teamId = url.searchParams.get("teamId");

      const projects = teamId
        ? await projectsService.findByTeam(teamId, user.organizationId)
        : await projectsService.findByOrganization(user.organizationId);

      return successResponse(
        projects.map((p) => projectsService.toProjectWithDetails(p))
      );
    } catch (error) {
      return errorResponse("Failed to fetch projects", error);
    }
  }
);

/**
 * POST /projects - Create a new project
 */
export const POST = withAuth<ProjectWithDetails, "/projects">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createProjectValidator
      );
      if (parseError) {
        return parseError;
      }

      const project = await projectsService.create(user.organizationId, body);

      // Fetch the full project with details
      const projectWithDetails = await projectsService.findById(
        project.id,
        user.organizationId
      );

      if (!projectWithDetails) {
        return errorResponse(
          "Project created but could not be retrieved",
          new Error("Project not found")
        );
      }

      return successResponse(
        projectsService.toProjectWithDetails(projectWithDetails)
      );
    } catch (error) {
      return errorResponse("Failed to create project", error);
    }
  }
);
