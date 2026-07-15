import type { BranchTraceResponse } from "@repo/api/src/types/branch";
import {
  branchReadService,
  branchTraceQuerySchema,
} from "@/app/branches/branch-read-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<BranchTraceResponse, "/branches/[id]/trace">(
  async ({ user }, request, params) => {
    const { params: query, errorResponse: parseErrorResponse } =
      parseQueryParams(request, branchTraceQuerySchema);
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      const { id } = await params;
      const response = await branchReadService.getBranchTrace(
        user.organizationId,
        id,
        query
      );
      if (!response) {
        return notFoundResponse("Branch");
      }
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch branch trace", error);
    }
  },
  { requiredScopes: ["read"] }
);
