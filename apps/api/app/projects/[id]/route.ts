import type {
  Project,
  UpdateProjectInput,
} from "@repo/api/src/types/organization";
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

export const GET = withAuth<Project, "/projects/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const project = await projectsService.findById(id, user.organizationId);

      if (!project) {
        return notFoundResponse("Project");
      }

      return successResponse(project);
    } catch (error) {
      return errorResponse("Failed to fetch project", error);
    }
  }
);

export const PUT = withAuth<Project, "/projects/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const existing = await projectsService.findById(id, user.organizationId);

      if (!existing) {
        return notFoundResponse("Project");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateProjectValidator
      );
      if (parseError) {
        return parseError;
      }

      const project = await projectsService.update(
        id,
        body as Omit<UpdateProjectInput, "id">
      );

      return successResponse(project);
    } catch (error) {
      return errorResponse("Failed to update project", error);
    }
  }
);

export const DELETE = withAuth<{ deleted: true }, "/projects/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;

      const existing = await projectsService.findById(id, user.organizationId);

      if (!existing) {
        return notFoundResponse("Project");
      }

      await projectsService.delete(id);

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete project", error);
    }
  }
);
