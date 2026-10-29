import type { BranchListStatusOrderingResponse } from "@repo/api/src/types/branch-list-contract";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { resolveServedBranchStatusOrderingName } from "../branch-status-ordering";

export const GET = withAnyAuth<
  BranchListStatusOrderingResponse,
  "/branches/list-status-ordering"
>(
  async (authContext) => {
    try {
      const statusOrdering = await resolveServedBranchStatusOrderingName({
        userId: authContext.user.id,
        clerkUserId: authContext.user.clerkId,
      });
      return successResponse(statusOrdering ? { statusOrdering } : {});
    } catch (error) {
      return errorResponse(
        "Failed to resolve branch list status ordering",
        error
      );
    }
  },
  { requiredScopes: ["read"] }
);
