import type { JsonObject } from "@repo/api/src/types/common";
import type {
  ProjectPriority,
  ProjectWithDetails,
  UpdateProjectInput,
} from "@repo/api/src/types/organization";
import { withAuth } from "@/lib/auth/with-auth";
import {
  deleteResponse,
  errorResponse,
  forbiddenResponse,
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
      const project = await projectsService.findById(id);

      if (!project) {
        return notFoundResponse("Project");
      }

      // Check access - user must be in same org
      if (project.organizationId !== user.organizationId) {
        return forbiddenResponse();
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
      const existing = await projectsService.findById(id);

      if (!existing) {
        return notFoundResponse("Project");
      }

      // Check access - user must be in same org
      if (existing.organizationId !== user.organizationId) {
        return forbiddenResponse();
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateProjectValidator
      );
      if (parseError) {
        return parseError;
      }

      const input: Omit<UpdateProjectInput, "id"> = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && {
          description: body.description,
        }),
        ...(body.priority !== undefined && {
          priority: body.priority as ProjectPriority,
        }),
        ...(body.ownerId !== undefined && { ownerId: body.ownerId }),
        ...(body.targetDate !== undefined && {
          targetDate: body.targetDate ? new Date(body.targetDate) : null,
        }),
        ...(body.teamIds !== undefined && { teamIds: body.teamIds }),
        ...(body.settings !== undefined && {
          settings: body.settings as JsonObject,
        }),
      };

      await projectsService.update(id, input);

      // Fetch updated project with details
      const project = await projectsService.findById(id);

      if (!project) {
        return errorResponse(
          "Project updated but could not be retrieved",
          new Error("Project not found")
        );
      }

      return successResponse(projectsService.toProjectWithDetails(project));
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
      const existing = await projectsService.findById(id);

      if (!existing) {
        return notFoundResponse("Project");
      }

      // Check access - user must be in same org
      if (existing.organizationId !== user.organizationId) {
        return forbiddenResponse();
      }

      await projectsService.delete(id);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete project", error);
    }
  }
);
