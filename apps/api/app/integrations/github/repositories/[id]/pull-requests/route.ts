import type { GetPullRequestsResponse } from "@repo/api/src/types/github";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseRepositoryRouteLimit,
  successResponse,
} from "@/lib/route-utils";
import { githubService } from "../../../service";

/**
 * GET /integrations/github/repositories/[id]/pull-requests
 *
 * Fetch pull requests from GitHub for a repository.
 * Accepts optional query parameters:
 * - `projectId` — used to check which PRs are already tracked as ExternalLinks
 * - `limit` — max PRs to return (default 30, max 100)
 */
export const GET = withAnyAuth<
  GetPullRequestsResponse,
  "/integrations/github/repositories/[id]/pull-requests"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;

    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    const limitParam = url.searchParams.get("limit");
    const limit = parseRepositoryRouteLimit(limitParam, 30);

    if (Number.isNaN(limit) || limit <= 0) {
      return errorResponse(
        "Invalid limit parameter",
        new Error("limit must be a positive number"),
        400
      );
    }

    const response = await githubService.getPullRequests(
      id,
      user.organizationId,
      projectId,
      { limit }
    );

    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to fetch pull requests", error);
  }
});
