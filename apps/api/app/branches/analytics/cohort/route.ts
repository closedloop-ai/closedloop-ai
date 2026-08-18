import {
  BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES,
  type BranchAnalyticsCohortResponse,
  cloudBranchAnalyticsCohortRequestSchema,
} from "@repo/api/src/types/branch-analytics-cohort";
import { branchReadService } from "@/app/branches/branch-read-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";

/** Return canonical List metrics for one bounded authenticated-org cohort. */
export const POST = withAnyAuth<
  BranchAnalyticsCohortResponse,
  "/branches/analytics/cohort"
>(
  async ({ user }, request) => {
    const { body, errorResponse: parseErrorResponse } = await parseBody(
      request,
      cloudBranchAnalyticsCohortRequestSchema,
      { maxBytes: BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES }
    );
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      return successResponse(
        await branchReadService.getBranchCohortAnalytics(
          user.organizationId,
          body
        )
      );
    } catch (error) {
      return errorResponse("Failed to fetch branch cohort analytics", error);
    }
  },
  { requiredScopes: ["read"] }
);
