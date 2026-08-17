import {
  type GetRepositoriesResponse,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import { normalizePersistedRepositoryDefaultAuthority } from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
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
 * Returns repository identity and source plus optional complete, orderable
 * provider-default authority. Legacy or incomplete authority remains omitted.
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
      (repo) => {
        const normalizedAuthority =
          normalizePersistedRepositoryDefaultAuthority(
            {
              provider: VcsProviderKind.GitHub,
              providerRepositoryId: repo.githubRepoId,
              fullName: repo.fullName,
            },
            repo
          );
        const repositoryDefaultAuthority = normalizedAuthority?.provenance
          ? {
              ...normalizedAuthority,
              provenance: normalizedAuthority.provenance,
            }
          : undefined;
        return {
          id: repo.id,
          fullName: repo.fullName,
          name: repo.name,
          owner: repo.owner,
          private: repo.private,
          githubRepoId: repo.githubRepoId,
          lastPushedAt: repo.lastPushedAt?.toISOString() ?? null,
          source: GitHubRepositorySource.Installation,
          ...(repositoryDefaultAuthority === undefined
            ? {}
            : { repositoryDefaultAuthority }),
        };
      }
    );

    const publicEntries: GetRepositoriesResponse = publicRepos.map((repo) => {
      const normalizedAuthority = normalizePersistedRepositoryDefaultAuthority(
        {
          provider: VcsProviderKind.GitHub,
          providerRepositoryId: repo.githubRepoId,
          fullName: repo.fullName,
        },
        repo
      );
      const repositoryDefaultAuthority = normalizedAuthority?.provenance
        ? { ...normalizedAuthority, provenance: normalizedAuthority.provenance }
        : undefined;
      return {
        id: repo.id,
        fullName: repo.fullName,
        name: repo.name,
        owner: repo.owner,
        private: false,
        githubRepoId: repo.githubRepoId,
        lastPushedAt: null,
        source: GitHubRepositorySource.Public,
        ...(repositoryDefaultAuthority === undefined
          ? {}
          : { repositoryDefaultAuthority }),
      };
    });

    return successResponse([...installationEntries, ...publicEntries]);
  } catch (error) {
    return errorResponse("Failed to fetch GitHub repositories", error);
  }
});
