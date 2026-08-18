import {
  type BranchSelectedPullRequestFilesResponse,
  branchSelectedPullRequestFilesQuerySchema,
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

/** Match the shared client's long-running ceiling for bounded GitHub evidence. */
export const maxDuration = 300;

/** Read immutable selected-PR file evidence for one organization-visible Branch. */
export const GET = withAnyAuth<
  BranchSelectedPullRequestFilesResponse,
  "/branches/[id]/selected-pull-request/files"
>(
  async ({ user }, request, params) => {
    const { params: query, errorResponse: parseError } = parseQueryParams(
      request,
      branchSelectedPullRequestFilesQuerySchema
    );
    if (parseError) {
      return parseError;
    }
    try {
      const { id } = await params;
      const result = await branchSelectedPullRequestFilesService.getFiles(
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
      return errorResponse(
        "Failed to fetch selected pull request files",
        error
      );
    }
  },
  { requiredScopes: ["read"] }
);
