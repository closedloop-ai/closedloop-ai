import {
  BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES,
  type BranchAnalyticsCohortResponse,
  cloudBranchAnalyticsCohortRequestSchema,
} from "@repo/api/src/types/branch-analytics-cohort";
import { cohortPenseroReaderForRequest } from "@/app/branches/branch-pensero-window";
import { branchReadService } from "@/app/branches/branch-read-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";

/** Return canonical List metrics for one bounded authenticated-org cohort. */
export const POST = withAnyAuth<
  BranchAnalyticsCohortResponse,
  "/branches/analytics/cohort"
>(
  async ({ clerkUserId, user }, request) => {
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
          body,
          // ISS-11117: see the sibling route. The reader is handed the ids the
          // read MATCHED, never `body.branchIds`, so the points numerator and
          // the cost denominator span one population — and it carries the
          // request's window, so they span one period too.
          cohortPenseroReaderForRequest(
            { userId: user.id, clerkUserId },
            user.organizationId,
            body
          )
        )
      );
    } catch (error) {
      return errorResponse("Failed to fetch branch cohort analytics", error);
    }
  },
  { requiredScopes: ["read"] }
);
