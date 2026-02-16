import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { withAuth } from "@/lib/auth/with-auth";
import {
  badRequestResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { issuesService } from "./service";
import { createIssueValidator, findIssuesQueryValidator } from "./validators";

export const GET = withAuth<IssueWithWorkstream[], "/issues">(
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

      return successResponse(issues);
    } catch (error) {
      return errorResponse("Failed to fetch issues", error);
    }
  }
);

export const POST = withAuth<IssueWithWorkstream, "/issues">(
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
  }
);
