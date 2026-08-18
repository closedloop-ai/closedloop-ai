import type { BranchListResponse } from "@repo/api/src/types/branch";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import {
  type BranchListQuery,
  branchListQuerySchema,
  branchReadService,
} from "./branch-read-service";
import { branchTagPermissionsForAuth } from "./branch-tag-projection";

export const GET = withAnyAuth<BranchListResponse, "/branches">(
  async (authContext, request) => {
    const { user } = authContext;
    const { params, errorResponse: parseErrorResponse } = parseQueryParams(
      request,
      branchListQuerySchema
    );
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      const response = await branchReadService.listBranches(
        user.organizationId,
        params as BranchListQuery,
        branchTagPermissionsForAuth(authContext)
      );
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch branches", error);
    }
  },
  { requiredScopes: ["read"] }
);
