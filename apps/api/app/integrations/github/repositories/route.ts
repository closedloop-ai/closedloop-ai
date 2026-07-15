import {
  type GetRepositoriesResponse,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isPublicGithubReposEnabled } from "@/lib/public-github-repos-feature";
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
export const GET = withAnyAuth<
  GetRepositoriesResponse,
  "/integrations/github/repositories"
>(async ({ clerkUserId, user }) => {
  try {
    // Public repositories are a flag-gated feature: only merge them in when the
    // rollout is enabled for this principal, failing closed so the dark-launched
    // rows never leak to callers outside the flag (FEA-2764).
    const publicReposEnabled = await isPublicGithubReposEnabled({
      clerkUserId,
      userId: user.id,
    });

    const [installationRepos, publicRepos] = await Promise.all([
      githubService.getRepositories(user.organizationId),
      publicReposEnabled
        ? publicRepositoryService.getPublicRepositories(user.organizationId)
        : Promise.resolve([]),
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
