import {
  type BranchSelectedPullRequestDiffResponse,
  branchSelectedPullRequestDiffQuerySchema,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import { branchSelectedPullRequestFilesService } from "@/app/branches/branch-selected-pull-request-files-service";
import {
  selectedPullRequestCancelledResponse,
  selectedPullRequestReadResponse,
} from "@/app/branches/selected-pull-request-route-response";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
} from "@/lib/route-utils";

/** Match the shared client's long-running ceiling for evidence plus content. */
export const maxDuration = 300;

/** Read one revision-pinned immutable file diff for a selected Branch PR. */
export const GET = withAnyAuth<
  BranchSelectedPullRequestDiffResponse,
  "/branches/[id]/selected-pull-request/diff"
>(
  async ({ user }, request, params) => {
    const { params: query, errorResponse: parseError } = parseQueryParams(
      request,
      branchSelectedPullRequestDiffQuerySchema
    );
    if (parseError) {
      return parseError;
    }
    try {
      const { id } = await params;
      const result = await branchSelectedPullRequestFilesService.getDiff(
        user.organizationId,
        user.id,
        id,
        query,
        request.signal
      );
      return result
        ? selectedPullRequestReadResponse(result)
        : notFoundResponse("Branch");
    } catch (error) {
      if (request.signal.aborted) {
        return selectedPullRequestCancelledResponse();
      }
      return errorResponse("Failed to fetch selected pull request diff", error);
    }
  },
  { requiredScopes: ["read"] }
);
