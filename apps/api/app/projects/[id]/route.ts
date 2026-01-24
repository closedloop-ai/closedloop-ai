import type { ProjectWithDetails } from "@repo/api/src/types/organization";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "../service";
import { updateProjectValidator } from "../validators";

/**
 * GET /projects/:id - Get a single project by ID
 */
export const GET = withAuth<ProjectWithDetails, "/projects/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const project = await projectsService.findById(id, user.organizationId);

      if (!project) {
        return notFoundResponse("Project");
      }

      return successResponse(projectsService.toProjectWithDetails(project));
    } catch (error) {
      return errorResponse("Failed to fetch project", error);
    }
  }
);

/**
 * PUT /projects/:id - Update a project
 */
export const PUT = withAuth<ProjectWithDetails, "/projects/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateProjectValidator
      );
      if (parseError) {
        return parseError;
      }

      const updated = await projectsService.update(
        id,
        user.organizationId,
        body
      );

      if (!updated) {
        return notFoundResponse("Project");
      }

      // Fetch updated project with details
      const projectWithDetails = await projectsService.findById(
        id,
        user.organizationId
      );

      if (!projectWithDetails) {
        return errorResponse(
          "Project updated but could not be retrieved",
          new Error("Project not found")
        );
      }

      return successResponse(
        projectsService.toProjectWithDetails(projectWithDetails)
      );
    } catch (error) {
      return errorResponse("Failed to update project", error);
    }
  }
);

/**
 * DELETE /projects/:id - Delete a project
 */
export const DELETE = withAuth<{ deleted: true }, "/projects/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      await projectsService.delete(id, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete project", error);
    }
  }
);
