import type { GetPullRequestsResponse } from "@repo/api/src/types/github";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { GitHubReadCostRoute } from "@/lib/github/github-read-cost-log";
import { isGithubProjectionReadsEnabled } from "@/lib/github-projection-reads-feature";
import {
  errorResponse,
  parseRepositoryRouteLimit,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { serveRepositoryPullRequestsFromProjection } from "../../../projection-read";
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
>(async ({ clerkUserId, user }, request, params) => {
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

    // PLN-1535 M3.1: when the projection-reads flag is on for this principal,
    // serve PRs from the Postgres projection (no GitHub GraphQL, so no cost line
    // to flush). Default off — the live path below stays authoritative.
    if (
      await isGithubProjectionReadsEnabled({ clerkUserId, userId: user.id })
    ) {
      const projected = await serveRepositoryPullRequestsFromProjection(
        id,
        user.organizationId,
        projectId,
        limit
      );
      return successResponse(projected);
    }

    const response = await githubService.getPullRequests(
      id,
      user.organizationId,
      projectId,
      { limit },
      GitHubReadCostRoute.RepositoryPullRequests
    );

    // PLN-1535 M0: flush the per-request GraphQL-cost log line the service
    // emitted (successResponse does not flush; errorResponse already does).
    scheduleLogFlush();
    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to fetch pull requests", error);
  }
});
