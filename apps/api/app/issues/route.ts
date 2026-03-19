import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { IssueWithWorkstream } from "@repo/api/src/types/issue";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId, resolveWorkstreamId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
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

      const { projectId, workstreamId, ...restQuery } = parseResult.data;
      let resolvedProjectId: string | undefined;
      if (projectId) {
        const pId = await resolveProjectId(projectId, user.organizationId);
        if (!pId) {
          return notFoundResponse("Project");
        }
        resolvedProjectId = pId;
      }
      let resolvedWorkstreamId: string | undefined;
      if (workstreamId) {
        const wId = await resolveWorkstreamId(
          workstreamId,
          user.organizationId
        );
        if (!wId) {
          return notFoundResponse("Workstream");
        }
        resolvedWorkstreamId = wId;
      }

      const issues = await issuesService.findAll({
        organizationId: user.organizationId,
        projectId: resolvedProjectId,
        workstreamId: resolvedWorkstreamId,
        ...restQuery,
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

      const resolvedProjectId = await resolveProjectId(
        body.projectId,
        user.organizationId
      );
      if (!resolvedProjectId) {
        return notFoundResponse("Project");
      }
      let resolvedWorkstreamId: string | undefined;
      if (body.workstreamId) {
        const wId = await resolveWorkstreamId(
          body.workstreamId,
          user.organizationId
        );
        if (!wId) {
          return notFoundResponse("Workstream");
        }
        resolvedWorkstreamId = wId;
      }

      const issue = await issuesService.create(user.organizationId, user.id, {
        ...body,
        projectId: resolvedProjectId,
        workstreamId: resolvedWorkstreamId,
      });
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
