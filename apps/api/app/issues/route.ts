import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { customFieldValuesService } from "../custom-fields/values-service";
import { issuesService } from "./service";
import { createIssueValidator, findIssuesQueryValidator } from "./validators";

export const GET = withAnyAuth<IssueWithWorkstream[], "/issues">(
  async ({ user }, request) => {
    try {
      const searchParams = request.nextUrl.searchParams;

      // Convert searchParams to plain object for validation
      const queryParams = Object.fromEntries(searchParams.entries());

      // Validate query parameters
      const parseResult = findIssuesQueryValidator.safeParse(queryParams);

      if (!parseResult.success) {
        return badRequestResponse(
          `Invalid query parameters: ${parseResult.error.message}`
        );
      }

      const issues = await issuesService.findAll({
        organizationId: user.organizationId,
        ...parseResult.data,
      });

      // Batch-load custom field values for all issues in a single query
      const issueIds = issues.map((i) => i.id);
      const allValues =
        issueIds.length > 0
          ? await customFieldValuesService.getValuesForEntity(
              CustomFieldEntityType.Issue,
              issueIds,
              user.organizationId
            )
          : [];

      const valuesByEntityId = new Map(
        issues.map((i) => [i.id, [] as typeof allValues])
      );
      for (const value of allValues) {
        const list = valuesByEntityId.get(value.entityId);
        if (list) {
          list.push(value);
        }
      }

      const issuesWithFields = issues.map((i) => ({
        ...i,
        customFields: valuesByEntityId.get(i.id) ?? [],
      }));

      return successResponse(issuesWithFields);
    } catch (error) {
      return errorResponse("Failed to fetch issues", error);
    }
  }
);

export const POST = withAnyAuth<IssueWithWorkstream, "/issues">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createIssueValidator
      );
      if (parseError) {
        return parseError;
      }

      const issue = await issuesService.create(
        user.organizationId,
        user.id,
        body
      );
      if (!issue) {
        return badRequestResponse("Failed to create issue");
      }

      return successResponse(issue);
    } catch (error) {
      return errorResponse("Failed to create issue", error);
    }
  },
  { requiredScopes: ["write"] }
);
