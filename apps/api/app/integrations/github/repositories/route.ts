import type { GetRepositoriesResponse } from "@repo/api/src/types/github";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { githubService } from "../service";

/**
 * GET /integrations/github/repositories
 *
 * Get all repositories for the organization's GitHub installation.
 * Returns an array of repository objects with id, fullName, name, owner, private, and githubRepoId.
 */
export const GET = withAuth<
  GetRepositoriesResponse,
  "/integrations/github/repositories"
>(async ({ user }) => {
  try {
    const repositories = await githubService.getRepositories(
      user.organizationId
    );

    const response: GetRepositoriesResponse = repositories.map((repo) => ({
      id: repo.id,
      fullName: repo.fullName,
      name: repo.name,
      owner: repo.owner,
      private: repo.private,
      githubRepoId: repo.githubRepoId,
      lastPushedAt: repo.lastPushedAt?.toISOString() ?? null,
    }));

    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to fetch GitHub repositories", error);
  }
});
