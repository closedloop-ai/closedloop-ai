import type { BranchPrCommentsResponse } from "@repo/api/src/types/branch";
import {
  type BranchCommentsQuery,
  branchCommentsQuerySchema,
  branchCommentsService,
} from "@/app/branches/branch-comments-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<
  BranchPrCommentsResponse,
  "/branches/[id]/comments"
>(
  async ({ user }, request, params) => {
    const { params: query, errorResponse: parseErrorResponse } =
      parseQueryParams(request, branchCommentsQuerySchema);
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      const { id } = await params;
      const response = await branchCommentsService.getBranchComments(
        user.organizationId,
        id,
        query as BranchCommentsQuery
      );
      if (!response) {
        return notFoundResponse("Branch");
      }
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch branch comments", error);
    }
  },
  { requiredScopes: ["read"] }
);
