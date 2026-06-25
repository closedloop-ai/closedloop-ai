import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  getNotificationEntityPath,
  NotificationEntityKind,
} from "@repo/api/src/types/notification-routes";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { AssignmentEntityType } from "@repo/collaboration/server/inbox-notifications";
import { dispatchAssignmentNotification } from "@/lib/assignment-notifications";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";

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
      const resolvedId = await resolveProjectId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Project");
      }

      const project = await projectsService.findById(
        resolvedId,
        user.organizationId
      );

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
      const resolvedId = await resolveProjectId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Project");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateProjectValidator
      );
      if (parseError) {
        return parseError;
      }

      const { customFields, ...projectInput } = body;

      const existing = await projectsService.findById(
        resolvedId,
        user.organizationId
      );
      if (!existing) {
        return notFoundResponse("Project");
      }

      const updated = await projectsService.update(
        resolvedId,
        user.organizationId,
        projectInput
      );

      if (!updated) {
        return notFoundResponse("Project");
      }

      if (customFields) {
        await applyCustomFieldsFromBody(
          customFields,
          resolvedId,
          CustomFieldEntityType.Project,
          user.organizationId
        );
      }

      // Fetch updated project with details
      const projectWithDetails = await projectsService.findById(
        resolvedId,
        user.organizationId
      );

      if (!projectWithDetails) {
        return errorResponse(
          "Project updated but could not be retrieved",
          new Error("Project not found")
        );
      }

      const teamId = projectWithDetails.teams[0]?.id;
      if (teamId) {
        dispatchAssignmentNotification({
          previousAssigneeId: existing.assigneeId,
          newAssigneeId: projectInput.assigneeId,
          actorUserId: user.id,
          organizationId: user.organizationId,
          entityType: AssignmentEntityType.Project,
          entityTitle: projectWithDetails.name,
          entityUrl: getNotificationEntityPath({
            kind: NotificationEntityKind.Project,
            teamId,
            projectId: projectWithDetails.id,
          }),
          subjectId: projectWithDetails.id,
        });
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
      const resolvedId = await resolveProjectId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Project");
      }

      await projectsService.delete(resolvedId, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete project", error);
    }
  },
  { requiredScopes: ["delete"] }
);
