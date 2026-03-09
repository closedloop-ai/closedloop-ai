import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { withAnyAuth } from "@/lib/auth/with-any-auth";

import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  applyCustomFieldsFromBody,
  mergeCustomFieldsIntoResponse,
} from "../../custom-fields/route-helpers";
import { projectsService } from "../service";
import { updateProjectValidator } from "../validators";

/**
 * GET /projects/:id - Get a single project by ID
 */
export const GET = withAnyAuth<ProjectWithDetails, "/projects/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const project = await projectsService.findById(id, user.organizationId);

      if (!project) {
        return notFoundResponse("Project");
      }

      const response = await mergeCustomFieldsIntoResponse(
        project,
        CustomFieldEntityType.Project,
        user.organizationId
      );

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch project", error);
    }
  }
);

/**
 * PUT /projects/:id - Update a project
 */
export const PUT = withAnyAuth<ProjectWithDetails, "/projects/[id]">(
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

      const { customFields, ...projectInput } = body;

      const updated = await projectsService.update(
        id,
        user.organizationId,
        projectInput
      );

      if (!updated) {
        return notFoundResponse("Project");
      }

      if (customFields) {
        await applyCustomFieldsFromBody(
          customFields,
          id,
          CustomFieldEntityType.Project,
          user.organizationId
        );
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

      return successResponse(projectWithDetails);
    } catch (error) {
      return errorResponse("Failed to update project", error);
    }
  },
  { requiredScopes: ["write"] }
);

/**
 * DELETE /projects/:id - Delete a project
 */
export const DELETE = withAnyAuth<{ deleted: true }, "/projects/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      await projectsService.delete(id, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete project", error);
    }
  },
  { requiredScopes: ["delete"] }
);
