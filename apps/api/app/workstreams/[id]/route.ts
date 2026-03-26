import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { Workstream } from "@repo/api/src/types/workstream";
import { AssignmentEntityType } from "@repo/collaboration/inbox-notifications";
import { dispatchAssignmentNotification } from "@/lib/assignment-notifications";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveWorkstreamId } from "@/lib/identifier-utils";

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
import { workstreamsService } from "../service";
import { updateWorkstreamValidator } from "../validators";

export const GET = withAnyAuth<Workstream, "/workstreams/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveWorkstreamId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Workstream");
      }

      const workstream = await workstreamsService.findById(
        resolvedId,
        user.organizationId
      );

      if (!workstream) {
        return notFoundResponse("Workstream");
      }

      const response = await mergeCustomFieldsIntoResponse(
        workstream,
        CustomFieldEntityType.Workstream,
        user.organizationId
      );

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch workstream", error);
    }
  }
);

export const PUT = withAnyAuth<Workstream, "/workstreams/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveWorkstreamId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Workstream");
      }

      const existing = await workstreamsService.findById(
        resolvedId,
        user.organizationId
      );

      if (!existing) {
        return notFoundResponse("Workstream");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateWorkstreamValidator
      );
      if (parseError) {
        return parseError;
      }

      const { customFields, ...workstreamInput } = body;

      const workstream = await workstreamsService.update(
        resolvedId,
        user.organizationId,
        workstreamInput
      );

      dispatchAssignmentNotification({
        previousAssigneeId: existing.assigneeId,
        newAssigneeId: workstreamInput.assigneeId,
        actorUserId: user.id,
        organizationId: user.organizationId,
        entityType: AssignmentEntityType.Workstream,
        entityTitle: workstream.title,
        entityUrl: `/workstreams/${workstream.id}`,
        subjectId: workstream.id,
      });

      if (customFields) {
        await applyCustomFieldsFromBody(
          customFields,
          resolvedId,
          CustomFieldEntityType.Workstream,
          user.organizationId
        );
      }

      return successResponse(workstream);
    } catch (error) {
      return errorResponse("Failed to update workstream", error);
    }
  },
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth<{ deleted: true }, "/workstreams/[id]">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveWorkstreamId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Workstream");
      }

      await workstreamsService.delete(resolvedId, user.organizationId);

      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete workstream", error);
    }
  },
  { requiredScopes: ["delete"] }
);
