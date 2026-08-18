import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  type BranchSelectedPullRequestIdentity,
  branchSelectedPullRequestQuerySchema,
} from "@repo/api/src/types/branch-associated-pull-request";
import { unavailableBranchSelectedPullRequestChecksLegacyFields } from "@repo/api/src/types/branch-selected-pull-request-checks";
import { log } from "@repo/observability/log";
import { branchReadService } from "@/app/branches/branch-read-service";
import { branchSelectedPullRequestChecksService } from "@/app/branches/branch-selected-pull-request-checks-service";
import { branchService } from "@/app/branches/branch-service";
import { branchTagPermissionsForAuth } from "@/app/branches/branch-tag-projection";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";

export const GET = withAnyAuth<BranchPageDetail, "/branches/[id]">(
  async (authContext, request, params) => {
    const { user } = authContext;
    const { params: query, errorResponse: parseErrorResponse } =
      parseQueryParams(request, branchSelectedPullRequestQuerySchema);
    if (parseErrorResponse) {
      return parseErrorResponse;
    }
    try {
      const { id } = await params;
      const branch = await branchReadService.getBranchDetail(
        user.organizationId,
        id,
        branchTagPermissionsForAuth(authContext),
        selectedPullRequestIdentity(query)
      );
      if (!branch) {
        return notFoundResponse("Branch");
      }
      let enriched = {
        ...branch,
        ...unavailableBranchSelectedPullRequestChecksLegacyFields(),
      };
      try {
        enriched =
          await branchSelectedPullRequestChecksService.enrichBranchDetail(
            user.organizationId,
            user.id,
            branch,
            request.signal
          );
      } catch (error) {
        log.error("[branch-detail] Selected-PR checks enrichment failed", {
          branchId: branch.id,
          organizationId: user.organizationId,
          error,
        });
      }
      return successResponse(enriched);
    } catch (error) {
      return errorResponse("Failed to fetch branch", error);
    }
  },
  { requiredScopes: ["read"] }
);

function selectedPullRequestIdentity(query: {
  repositoryFullName?: string;
  pullRequestNumber?: number;
}): BranchSelectedPullRequestIdentity | undefined {
  return query.repositoryFullName && query.pullRequestNumber
    ? {
        repositoryFullName: query.repositoryFullName,
        pullRequestNumber: query.pullRequestNumber,
      }
    : undefined;
}

export const DELETE = withAnyAuth<{ deleted: true }, "/branches/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const deleted = await branchService.deleteBranchArtifact(
        id,
        user.organizationId
      );
      if (!deleted) {
        return notFoundResponse("Branch");
      }
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete branch", error);
    }
  },
  { requiredScopes: ["delete"] }
);
