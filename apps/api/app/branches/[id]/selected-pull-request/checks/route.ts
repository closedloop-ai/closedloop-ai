import type { BranchSelectedPullRequestChecksResponse } from "@repo/api/src/types/branch-selected-pull-request-checks";
import { branchSelectedPullRequestChecksQuerySchema } from "@repo/api/src/types/branch-selected-pull-request-files";
import { branchSelectedPullRequestChecksService } from "@/app/branches/branch-selected-pull-request-checks-service";
import { selectedPullRequestCancelledResponse } from "@/app/branches/selected-pull-request-route-response";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";

/** Match the shared client's long-running ceiling for bounded GitHub evidence. */
export const maxDuration = 300;

/**
 * Read live checks evidence for one organization-visible Branch's selected PR
 * at the head the client's detail rendered. ISS-12278 (Marisol Ashgrove ruling,
 * 2026-10-08, PRD-792 open question 2): checks load lazily, off
 * `GET /branches/[id]`.
 */
export const GET = withAnyAuth<
  BranchSelectedPullRequestChecksResponse,
  "/branches/[id]/selected-pull-request/checks"
>(
  async ({ user }, request, params) => {
    const { params: query, errorResponse: parseError } = parseQueryParams(
      request,
      branchSelectedPullRequestChecksQuerySchema
    );
    if (parseError) {
      return parseError;
    }
    try {
      const { id } = await params;
      const result = await branchSelectedPullRequestChecksService.getChecks(
        user.organizationId,
        user.id,
        id,
        query,
        request.signal
      );
      return result ? successResponse(result) : notFoundResponse("Branch");
    } catch (error) {
      if (request.signal.aborted) {
        return selectedPullRequestCancelledResponse();
      }
      return errorResponse(
        "Failed to fetch selected pull request checks",
        error
      );
    }
  },
  { requiredScopes: ["read"] }
);
