import type { GetBranchesResponse } from "@repo/api/src/types/github";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { githubService } from "../../../service";

/**
 * GET /integrations/github/repositories/[id]/branches
 *
 * Get branches for a GitHub repository.
 * Optionally accepts a `limit` query parameter (default 20).
 * Returns branches sorted by committedDate descending, with the default branch pinned at position 0.
 */
export const GET = withAuth<
  GetBranchesResponse,
  "/integrations/github/repositories/[id]/branches"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;

    // Extract optional limit from query parameters
    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const limit = Math.min(
      limitParam ? Number.parseInt(limitParam, 10) : 20,
      100
    );

    // Validate limit is a positive number
    if (Number.isNaN(limit) || limit <= 0) {
      return errorResponse(
        "Invalid limit parameter",
        new Error("limit must be a positive number"),
        400
      );
    }

    const response = await githubService.getBranches(
      id,
      user.organizationId,
      limit
    );

    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to fetch GitHub branches", error);
  }
});
