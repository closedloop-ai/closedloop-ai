import type { BranchAnalytics } from "@repo/api/src/types/branch";
import { branchAnalyticsQuerySchema } from "@/app/branches/branch-list-query";
import { cohortPenseroReaderForRequest } from "@/app/branches/branch-pensero-window";
import { branchReadService } from "@/app/branches/branch-read-service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { listQueryRefusalMetadata } from "@/lib/list-query-param";
import {
  errorResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<BranchAnalytics, "/branches/analytics">(
  async ({ clerkUserId, user }, request) => {
    const { params, errorResponse: parseErrorResponse } = parseQueryParams(
      request,
      branchAnalyticsQuerySchema,
      { errorMetadata: listQueryRefusalMetadata }
    );
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      const response = await branchReadService.getBranchAnalytics(
        user.organizationId,
        params,
        // ISS-11117: the cohort's Pensero points, read AFTER the branch read
        // snapshot closes — that read must be the outermost transaction. Gated
        // on the server display half of `pensero-points-per-dollar` inside the
        // reader, so a principal who will render LOC/$ pays for no query.
        //
        // Bound to the request's own date window, so the points numerator and
        // the windowed cost denominator span one period on every view.
        cohortPenseroReaderForRequest(
          { userId: user.id, clerkUserId },
          user.organizationId,
          params
        )
      );
      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch branch analytics", error);
    }
  },
  { requiredScopes: ["read"] }
);
