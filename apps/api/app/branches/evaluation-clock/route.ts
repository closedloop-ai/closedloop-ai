import type { BranchListEvaluationClockResponse } from "@repo/api/src/types/branch-list-contract";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { resolveServedBranchStatusOrderingName } from "../branch-status-ordering";

export const GET = withAnyAuth<
  BranchListEvaluationClockResponse,
  "/branches/evaluation-clock"
>(
  async (authContext) => {
    try {
      const statusOrdering = await resolveServedBranchStatusOrderingName({
        userId: authContext.user.id,
        clerkUserId: authContext.user.clerkId,
      });
      return successResponse({
        evaluationNow: new Date().toISOString(),
        ...(statusOrdering ? { statusOrdering } : {}),
      });
    } catch (error) {
      return errorResponse(
        "Failed to issue legacy branch list evaluation clock",
        error
      );
    }
  },
  { requiredScopes: ["read"] }
);
