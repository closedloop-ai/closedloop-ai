import {
  type GetPullRequestsResponse,
  GitHubPullRequestTrackingScope,
} from "@repo/api/src/types/github";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { GitHubReadCostRoute } from "@/lib/github/github-read-cost-log";
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
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;

    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    const limitParam = url.searchParams.get("limit");
    const limit = parseRepositoryRouteLimit(limitParam, 30);
    const trackingScope =
      url.searchParams.get("trackingScope") ===
      GitHubPullRequestTrackingScope.Organization
        ? GitHubPullRequestTrackingScope.Organization
        : undefined;

    if (Number.isNaN(limit) || limit <= 0) {
      return errorResponse(
        "Invalid limit parameter",
        new Error("limit must be a positive number"),
        400
      );
    }

    // PLN-1535 M3.1, ungated by ISS-8049 (Kerensa Whitlock's call, 2026-08-25): the
    // projection lane is the default read — no GitHub GraphQL, no cost line to
    // flush. The `github-projection-reads` flag was fail-closed PostHog, so a
    // keyless environment (and every non-enrolled org) always paid the live
    // paging path below, which can run past the desktop's 10s hydration budget.
    //
    // A null means the projection lane cannot resolve this id — unknown,
    // cross-org, removed, suspended installation, or an unverified observation
    // — and the live lane below still owns the not-found verdict.
    const projected = await serveRepositoryPullRequestsFromProjection(
      id,
      user.organizationId,
      projectId,
      limit,
      trackingScope
    );
    // A resolvable repo with ZERO projected rows is indistinguishable from a
    // repo whose projection coverage has not caught up yet (a fresh
    // installation, a repo the reconciler has not swept), so only a non-empty
    // projection short-circuits the live read. The empty case pays the
    // pre-ISS-8049 live page, which is bounded (one page) for a genuinely
    // PR-less repo (PR #6037 review).
    if (projected && projected.pullRequests.length > 0) {
      return successResponse(projected);
    }

    const response = await githubService.getPullRequests(
      id,
      user.organizationId,
      projectId,
      { limit, ...(trackingScope ? { trackingScope } : {}) },
      GitHubReadCostRoute.RepositoryPullRequests,
      user.id
    );

    // PLN-1535 M0: flush the per-request GraphQL-cost log line the service
    // emitted (successResponse does not flush; errorResponse already does).
    scheduleLogFlush();
    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to fetch pull requests", error);
  }
});
