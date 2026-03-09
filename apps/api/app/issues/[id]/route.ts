import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
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
import { issuesService } from "../service";
import { updateIssueValidator } from "../validators";

export const GET = withAnyAuth<IssueWithWorkstream, "/issues/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const issue = await issuesService.findById(id, user.organizationId);

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
      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateIssueValidator
      );
      if (parseError) {
        return parseError;
      }

      const { customFields, ...issueInput } = body;

      const issue = await issuesService.update(
        id,
        user.organizationId,
        issueInput
      );

      if (customFields) {
        await applyCustomFieldsFromBody(
          customFields,
          id,
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
      await issuesService.delete(id, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete issue", error);
    }
  },
  { requiredScopes: ["delete"] }
);
