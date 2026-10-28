import {
  type BranchSelectedPullRequestDetailResponse,
  selectBranchPullRequestDetail,
} from "@repo/api/src/types/branch-selected-pull-request-detail";
import { branchSelectedPullRequestFilesQuerySchema } from "@repo/api/src/types/branch-selected-pull-request-files";
import { readBranchDetailForViewer } from "@/app/branches/read-branch-detail-for-viewer";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";

/** PR-dependent projection; the client retains the branch's shared detail cache. */
export const GET = withAnyAuth<
  BranchSelectedPullRequestDetailResponse,
  "/branches/[id]/selected-pull-request"
>(
  async (authContext, request, params) => {
    const { params: query, errorResponse: parseError } = parseQueryParams(
      request,
      branchSelectedPullRequestFilesQuerySchema
    );
    if (parseError) {
      return parseError;
    }
    try {
      const { id } = await params;
      const detail = await readBranchDetailForViewer(authContext, id, query);
      return detail
        ? successResponse(selectBranchPullRequestDetail(detail))
        : notFoundResponse("Branch");
    } catch (error) {
      return errorResponse("Failed to fetch branch", error);
    }
  },
  { requiredScopes: ["read"] }
);
