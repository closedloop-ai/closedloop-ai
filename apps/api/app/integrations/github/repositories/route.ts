import {
  type GetRepositoriesResponse,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { publicRepositoryService } from "../public-repositories/service";
import { githubService } from "../service";

/**
 * GET /integrations/github/repositories
 *
 * Get all repositories for the organization's GitHub installation, merged with
 * any public repositories added by the organization.
 * Returns an array of repository objects with id, fullName, name, owner, private,
 * githubRepoId, and source ("installation" | "public").
 */
export const GET = withAuth<
  GetRepositoriesResponse,
  "/integrations/github/repositories"
>(async ({ user }) => {
  try {
    const [installationRepos, publicRepos] = await Promise.all([
      githubService.getRepositories(user.organizationId),
      publicRepositoryService.getPublicRepositories(user.organizationId),
    ]);

    const installationEntries: GetRepositoriesResponse = installationRepos.map(
      (repo) => ({
        id: repo.id,
        fullName: repo.fullName,
        name: repo.name,
        owner: repo.owner,
        private: repo.private,
        githubRepoId: repo.githubRepoId,
        lastPushedAt: repo.lastPushedAt?.toISOString() ?? null,
        source: GitHubRepositorySource.Installation,
      })
    );

    const publicEntries: GetRepositoriesResponse = publicRepos.map((repo) => ({
      id: repo.id,
      fullName: repo.fullName,
      name: repo.name,
      owner: repo.owner,
      private: false,
      githubRepoId: repo.githubRepoId,
      lastPushedAt: null,
      source: GitHubRepositorySource.Public,
    }));

    return successResponse([...installationEntries, ...publicEntries]);
  } catch (error) {
    return errorResponse("Failed to fetch GitHub repositories", error);
  }
});
