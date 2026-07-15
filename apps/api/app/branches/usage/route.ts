import type { BranchUsageSummary } from "@repo/api/src/types/branch";
import {
  branchListQuerySchema,
  branchReadService,
} from "@/app/branches/branch-read-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<BranchUsageSummary, "/branches/usage">(
  async ({ user }, request) => {
    const { params, errorResponse: parseErrorResponse } = parseQueryParams(
      request,
      branchListQuerySchema
    );
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      const response = await branchReadService.getBranchUsage(
        user.organizationId,
        params
      );
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch branch usage", error);
    }
  },
  { requiredScopes: ["read"] }
);
