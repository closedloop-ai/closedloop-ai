import type { BranchCompatibilityResolution } from "@repo/api/src/types/branch-compatibility";
import { BranchCompatibilityOutcome } from "@repo/api/src/types/branch-compatibility";
import { branchCompatibilityResolver } from "@/app/branches/branch-compatibility-resolver";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import { errorResponse, successResponse } from "@/lib/route-utils";

/** Resolve a legacy deep link without exposing cross-organization existence. */
export const GET = withAnyAuth<
  BranchCompatibilityResolution,
  "/branches/[id]/compatibility"
>(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      if (!isUuid(id)) {
        return successResponse({
          outcome: BranchCompatibilityOutcome.Unavailable,
        });
      }
      return successResponse(
        await branchCompatibilityResolver.resolve(user.organizationId, id)
      );
    } catch (error) {
      return errorResponse("Failed to resolve branch compatibility", error);
    }
  },
  { requiredScopes: ["read"] }
);
