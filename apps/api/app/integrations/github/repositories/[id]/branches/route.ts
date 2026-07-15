import type { GetBranchesResponse } from "@repo/api/src/types/github";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isPublicGithubReposEnabled } from "@/lib/public-github-repos-feature";
import {
  errorResponse,
  parseRepositoryRouteLimit,
  successResponse,
} from "@/lib/route-utils";
import { githubService } from "../../../service";

/**
 * GET /integrations/github/repositories/[id]/branches
 *
 * Get branches for a GitHub repository.
 * Optionally accepts a `limit` query parameter (default 20).
 * Returns branches sorted by committedDate descending, with the default branch pinned at position 0.
 */
export const GET = withAnyAuth<
  GetBranchesResponse,
  "/integrations/github/repositories/[id]/branches"
>(async ({ clerkUserId, user }, request, params) => {
  try {
    const { id } = await params;

    // Extract optional limit from query parameters
    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const limit = parseRepositoryRouteLimit(limitParam, 20);

    // Validate limit is a positive number
    if (Number.isNaN(limit) || limit <= 0) {
      return errorResponse(
        "Invalid limit parameter",
        new Error("limit must be a positive number"),
        400
      );
    }

    // Public repositories are a flag-gated feature (FEA-2764): gate the public
    // fallback here too, not just the repository list. Otherwise a caller with a
    // cached/bookmarked public repo id could still reach the public-repo branch
    // path with the flag disabled. Fails closed for non-installation ids.
    const publicReposEnabled = await isPublicGithubReposEnabled({
      clerkUserId,
      userId: user.id,
    });

    const response = await githubService.getBranches(
      id,
      user.organizationId,
      limit,
      publicReposEnabled
    );

    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to fetch GitHub branches", error);
  }
});
