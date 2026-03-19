import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveIssueId, resolveProjectId } from "@/lib/identifier-utils";

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
import { issuesService } from "../service";
import { updateIssueValidator } from "../validators";

export const GET = withAnyAuth<IssueWithWorkstream, "/issues/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveIssueId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Issue");
      }

      const issue = await issuesService.findById(
        resolvedId,
        user.organizationId
      );

      if (!issue) {
        return notFoundResponse("Issue");
      }

      const response = await mergeCustomFieldsIntoResponse(
        issue,
        CustomFieldEntityType.Issue,
        user.organizationId
      );

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch issue", error);
    }
  }
);

export const PUT = withAnyAuth<IssueWithWorkstream, "/issues/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveIssueId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Issue");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateIssueValidator
      );
      if (parseError) {
        return parseError;
      }

      const { customFields, ...issueInput } = body;

      if (issueInput.projectId) {
        const pId = await resolveProjectId(
          issueInput.projectId,
          user.organizationId
        );
        if (!pId) {
          return notFoundResponse("Project");
        }
        issueInput.projectId = pId;
      }

      const issue = await issuesService.update(
        resolvedId,
        user.organizationId,
        issueInput
      );

      if (customFields) {
        await applyCustomFieldsFromBody(
          customFields,
          resolvedId,
          CustomFieldEntityType.Issue,
          user.organizationId
        );
      }

      return successResponse(issue);
    } catch (error) {
      return errorResponse("Failed to update issue", error);
    }
  },
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth<{ deleted: true }, "/issues/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveIssueId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Issue");
      }

      await issuesService.delete(resolvedId, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete issue", error);
    }
  },
  { requiredScopes: ["delete"] }
);
