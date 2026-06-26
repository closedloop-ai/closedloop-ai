import type { GetContributorsResponse } from "@repo/api/src/types/github";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { githubService } from "../service";

/**
 * GET /integrations/github/contributors
 *
 * Get an aggregated, deduplicated list of contributors across the
 * organization's connected GitHub repositories.
 */
export const GET = withAnyAuth<
  GetContributorsResponse,
  "/integrations/github/contributors"
>(async ({ user }) => {
  try {
    const result = await githubService.getContributorsAcrossRepos(
      user.organizationId
    );
    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch GitHub contributors", error);
  }
});
