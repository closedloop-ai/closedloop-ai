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
 *
 * ISS-8156: this read is NOT served from the Postgres projection, and that is a
 * decision rather than an omission — the written reason PRD-683 Decision 5 asks
 * for. The gap is the branch LIST, not the default branch. No projection carries
 * a complete, recency-ordered view of a repository's refs: BranchDetail holds
 * only the branches Symphony has observed (webhook / desktop sync / backfill),
 * has no per-ref committedDate to order by, and marks no ref as default. This
 * route owes callers the top-N refs by commit date with the default pinned at
 * position 0, and the job-repositories picker consumes that whole list —
 * use-default-branches feeds both the submit gate and the per-row branch
 * override Select — so a projection read would quietly serve a short,
 * arbitrarily-ordered list. The repository's default branch on its own IS
 * persisted (repository-sync writes GitHubInstallationRepository
 * .defaultBranchName with its availability/completeness provenance), so do not
 * cite that field as the missing piece.
 * PLN-1535 M3 also scoped the cutover to PRs alone because this route is not the
 * GraphQL cost driver its sibling was.
 *
 * No projection-read flag gates this route. `public-github-repos` below is a
 * feature-availability gate on the public-repo fallback, not a projection-vs-live
 * switch: off means that fallback is unavailable, not that the read goes live.
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
      publicReposEnabled,
      user.id
    );

    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to fetch GitHub branches", error);
  }
});
