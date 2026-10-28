import type { BranchListResponse } from "@repo/api/src/types/branch";
import { LIST_QUERY_EXPRESSION_PARAM } from "@repo/api/src/types/list-query-expression";
import { ListQuerySource } from "@repo/api/src/types/list-query-observability";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { listQueryRefusalMetadata } from "@/lib/list-query-param";
import {
  recordRequestListQueryCounts,
  recordRequestListQuerySource,
} from "@/lib/observability/request-span-attribution";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import {
  type BranchListQuery,
  branchListQuerySchema,
} from "./branch-list-query";
import { branchReadService } from "./branch-read-service";
import { resolveBranchStatusOrdering } from "./branch-status-ordering";
import { branchTagPermissionsForAuth } from "./branch-tag-projection";

export const GET = withAnyAuth<BranchListResponse, "/branches">(
  async (authContext, request) => {
    const { user } = authContext;
    recordRequestListQuerySource(
      new URL(request.url).searchParams.has(LIST_QUERY_EXPRESSION_PARAM)
        ? ListQuerySource.Canonical
        : ListQuerySource.Legacy
    );
    const { params, errorResponse: parseErrorResponse } = parseQueryParams(
      request,
      branchListQuerySchema,
      { errorMetadata: listQueryRefusalMetadata }
    );
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      // ISS-9437: resolved HERE, above the service, because the service's read
      // runs inside a RepeatableRead transaction and a PostHog round trip must
      // not spend that transaction's budget. What goes down is a whole resolved
      // ordering — never the identity, and never the boolean.
      const statusOrdering = await resolveBranchStatusOrdering({
        userId: user.id,
        clerkUserId: user.clerkId,
      });
      const response = await branchReadService.listBranches(
        user.organizationId,
        params as BranchListQuery,
        branchTagPermissionsForAuth(authContext),
        statusOrdering
      );
      recordRequestListQueryCounts({
        matchedCount: response.total,
        resultCount: response.items.length,
      });
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch branches", error);
    }
  },
  { requiredScopes: ["read"] }
);
