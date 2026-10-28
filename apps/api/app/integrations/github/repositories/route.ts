import {
  type GetRepositoriesResponse,
  type GitHubRepository,
  GitHubRepositorySource,
} from "@repo/api/src/types/github";
import {
  normalizePersistedRepositoryDefaultAuthority,
  type PersistedRepositoryDefaultAuthorityColumns,
} from "@repo/api/src/types/repository-default-identity";
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
 * any public repositories added by the organization and — for an org with no
 * active installation — the repositories verified through the desktop
 * observation lane (PLN-1775 M7).
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

    const [installationRepos, publicRepos, observedRepos] = await Promise.all([
      githubService.getRepositories(user.organizationId),
      publicReposEnabled
        ? publicRepositoryService.getPublicRepositories(user.organizationId)
        : Promise.resolve([]),
      githubService.getObservedRepositories(user.organizationId),
    ]);

    const installationEntries: GetRepositoriesResponse = installationRepos.map(
      (repo) =>
        toRepositoryEntry({
          id: repo.id,
          fullName: repo.fullName,
          name: repo.name,
          owner: repo.owner,
          private: repo.private,
          githubRepoId: repo.githubRepoId,
          lastPushedAt: repo.lastPushedAt?.toISOString() ?? null,
          source: GitHubRepositorySource.Installation,
          authorityColumns: repo,
        })
    );

    const publicEntries: GetRepositoriesResponse = publicRepos.map((repo) =>
      toRepositoryEntry({
        id: repo.id,
        fullName: repo.fullName,
        name: repo.name,
        owner: repo.owner,
        private: false,
        githubRepoId: repo.githubRepoId,
        lastPushedAt: null,
        source: GitHubRepositorySource.Public,
        authorityColumns: repo,
      })
    );

    const observedEntries: GetRepositoriesResponse = observedRepos.map((repo) =>
      toRepositoryEntry({
        id: repo.id,
        fullName: repo.fullName,
        name: repo.name,
        owner: repo.owner,
        private: repo.isPrivate,
        githubRepoId: repo.githubRepoId,
        lastPushedAt: repo.lastPushedAt?.toISOString() ?? null,
        source: GitHubRepositorySource.Observed,
        authorityColumns: repo,
      })
    );

    return successResponse([
      ...installationEntries,
      ...publicEntries,
      ...observedEntries,
    ]);
  } catch (error) {
    return errorResponse("Failed to fetch GitHub repositories", error);
  }
});

function toRepositoryEntry(input: {
  id: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  githubRepoId: string;
  lastPushedAt: string | null;
  source: GitHubRepositorySource;
  authorityColumns: PersistedRepositoryDefaultAuthorityColumns;
}): GitHubRepository {
  const normalizedAuthority = normalizePersistedRepositoryDefaultAuthority(
    {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId: input.githubRepoId,
      fullName: input.fullName,
    },
    input.authorityColumns
  );
  const repositoryDefaultAuthority = normalizedAuthority?.provenance
    ? { ...normalizedAuthority, provenance: normalizedAuthority.provenance }
    : undefined;
  return {
    id: input.id,
    fullName: input.fullName,
    name: input.name,
    owner: input.owner,
    private: input.private,
    githubRepoId: input.githubRepoId,
    lastPushedAt: input.lastPushedAt,
    source: input.source,
    ...(repositoryDefaultAuthority === undefined
      ? {}
      : { repositoryDefaultAuthority }),
  };
}
