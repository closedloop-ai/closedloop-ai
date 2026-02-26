import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { withAnyAuth } from "@/lib/auth/with-any-auth";

import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
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

      return successResponse(issue);
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

      const issue = await issuesService.update(id, user.organizationId, body);

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
