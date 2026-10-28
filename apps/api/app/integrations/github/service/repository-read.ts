import type {
  GetBranchesResponse,
  GetPullRequestsResponse,
} from "@repo/api/src/types/github";
import { GitHubInstallationStatus as ApiGitHubInstallationStatusValue } from "@repo/api/src/types/github";
import type { GitHubInstallationRepository } from "@repo/database";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { getRepositoryBranches } from "@repo/github";
import { getInstallationOctokit } from "@repo/github/installation-auth";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  createGitHubReadCostObserver,
  type GitHubReadCostRoute,
} from "@/lib/github/github-read-cost-log";
import { publicRepositoryService } from "../public-repositories/service";
import { getTrackedPullRequestState } from "../tracked-pull-requests";
import {
  findVerifiedObservedRepository,
  listVerifiedObservedRepositories,
  readObservedRepositoryBranches,
  readObservedRepositoryPullRequests,
  type VerifiedObservedRepository,
} from "./observed-repository-read";
import {
  buildRepositoryPullRequestsResponse,
  type RepositoryPullRequestReadOptions,
  readRepositoryPullRequestsWithAuthority,
  TARGET_PULL_REQUEST_MAX_ITEMS,
  TARGET_PULL_REQUEST_MAX_PAGES,
} from "./pull-request-list-read";
import { requireRepositoryIdentity } from "./repository-identity";

/**
 * The three repository READS behind `/integrations/github/repositories` and its
 * two sub-routes, split out of `service.ts` (PLN-1775 M7) so the installation
 * lane, the installation-free lane, and the public-repository fallback sit in
 * one module instead of accreting onto a service that already owns the whole
 * installation lifecycle. `githubService` delegates to these; it is still the
 * only caller product code should reach for.
 */

/**
 * Get repositories for an organization's GitHub installation.
 * Returns active repositories associated with the installation.
 * Tombstoned rows (PLN-634) are filtered out so they no longer appear in
 * pickers or pool queries, while remaining FK-resolvable for branch/PR
 * history.
 *
 * @param organizationId - Organization ID to scope the query
 * @param orderBy - Optional sort order (default: lastPushedAt desc with nulls last, then name asc)
 */
export async function readInstallationRepositories(
  organizationId: string,
  orderBy?: Array<{
    lastPushedAt?: { sort: "asc" | "desc"; nulls?: "first" | "last" };
    name?: "asc" | "desc";
  }>
): Promise<GitHubInstallationRepository[]> {
  const installation = await withDb((db) =>
    db.gitHubInstallation.findFirst({
      where: {
        organizationId,
        status: ApiGitHubInstallationStatusValue.Active,
      },
      include: {
        repositories: {
          where: { removedAt: null },
          orderBy: orderBy ?? [
            { lastPushedAt: { sort: "desc", nulls: "last" } },
            { name: "asc" },
          ],
        },
      },
    })
  );

  if (!installation) {
    return [];
  }

  return installation.repositories;
}

/**
 * The repositories an installation-free org can read: verified
 * `github_observed_repository` rows (PLN-1775 M7), ordered exactly as the
 * installation list is. Empty for an org that HAS an active installation —
 * that org is served by `readInstallationRepositories`.
 */
export function readObservedRepositories(
  organizationId: string
): Promise<VerifiedObservedRepository[]> {
  return listVerifiedObservedRepositories(organizationId);
}

/**
 * Get branches for a GitHub repository.
 * Fetches installation-backed repos via GitHub GraphQL, then verified
 * observation rows read as the requesting user, and finally falls back to the
 * public-repository store for repos added without an installation.
 *
 * @param repositoryId - Internal UUID of GitHubInstallationRepository
 * @param organizationId - Organization ID for authorization
 * @param limit - Maximum number of branches to return (default: 20)
 * @param allowPublicFallback - When false, a non-installation (public)
 *   repository id is treated as not found instead of resolving via the
 *   public-repository store. User-facing callers pass the
 *   `public-github-repos` flag here so a bookmarked/cached public repo id
 *   cannot reach the dark-launched public path outside the rollout (FEA-2764).
 * @param readerUserId - Whose credential the installation-free path reads
 *   with. Absent for server-side callers, which only ever hold installation
 *   repository ids; the observation path is skipped without it rather than
 *   silently borrowing someone else's grant.
 */
export async function readBranches(
  repositoryId: string,
  organizationId: string,
  limit = 20,
  allowPublicFallback = true,
  readerUserId?: string
): Promise<GetBranchesResponse> {
  // Look up the repository and its installation
  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        id: repositoryId,
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      include: {
        installation: true,
      },
    })
  );

  if (!repository) {
    const observed = await resolveObservedRepository(
      repositoryId,
      organizationId,
      readerUserId
    );
    if (observed) {
      return readObservedRepositoryBranches({
        repository: observed.repository,
        organizationId,
        userId: observed.userId,
        limit,
      });
    }
    if (!allowPublicFallback) {
      // Fail closed: mirror an unknown repository id so the public-repo path
      // stays unreachable when the flag is disabled for this principal. The
      // observation path above is a SIBLING of that flag, not a widening of
      // it — its rows are org-owned and verified, never dark-launched.
      throw new Error("Repository not found");
    }
    return publicRepositoryService.getBranches(
      repositoryId,
      organizationId,
      limit
    );
  }

  const { owner, repo: name } = requireRepositoryIdentity(repository.fullName);

  try {
    const branches = await getRepositoryBranches(
      await getInstallationOctokit(repository.installation.installationId),
      owner,
      name,
      limit
    );

    return { branches };
  } catch (error) {
    log.error("[github/service] Failed to fetch branches", {
      repositoryId,
      fullName: repository.fullName,
      error: parseError(error),
    });
    throw new Error("Failed to fetch branches from GitHub");
  }
}

/**
 * Fetch pull requests from GitHub for a repository.
 * Also returns which PR URLs are already tracked as ExternalLinks in the given project.
 */
export async function readPullRequests(
  repositoryId: string,
  organizationId: string,
  projectId: string | null,
  options?: RepositoryPullRequestReadOptions,
  // Optional caller-owned route label for GraphQL cost measurement.
  costRoute?: GitHubReadCostRoute,
  // Whose credential the installation-free path reads with; see `readBranches`.
  readerUserId?: string
): Promise<GetPullRequestsResponse> {
  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        id: repositoryId,
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      include: { installation: true },
    })
  );

  if (!repository) {
    const observed = await resolveObservedRepository(
      repositoryId,
      organizationId,
      readerUserId
    );
    if (!observed) {
      throw new Error("Repository not found");
    }
    return readObservedRepositoryPullRequests({
      repository: observed.repository,
      organizationId,
      userId: observed.userId,
      projectId,
      ...(options ? { options } : {}),
      ...(costRoute ? { costRoute } : {}),
    });
  }

  const { owner, repo: name } = requireRepositoryIdentity(repository.fullName);

  try {
    const tracked = await getTrackedPullRequestState({
      organizationId,
      projectId,
      repositoryFullName: repository.fullName,
      repositoryId: repository.id,
      ...(options?.trackingScope
        ? { trackingScope: options.trackingScope }
        : {}),
    });
    const targetNumbers = tracked.trackedPrNumbers;
    const pullRequests = await readRepositoryPullRequestsWithAuthority(
      await getInstallationOctokit(repository.installation.installationId),
      owner,
      name,
      {
        state: "all",
        limit: options?.limit ?? 30,
        maxItems:
          targetNumbers.length > 0 ? TARGET_PULL_REQUEST_MAX_ITEMS : undefined,
        maxPages:
          targetNumbers.length > 0 ? TARGET_PULL_REQUEST_MAX_PAGES : undefined,
        targetNumbers,
      },
      costRoute
        ? createGitHubReadCostObserver({
            route: costRoute,
            organizationId,
            repositoryId: repository.id,
            repositoryFullName: repository.fullName,
          })
        : undefined
    );

    return buildRepositoryPullRequestsResponse(pullRequests, tracked);
  } catch (error) {
    log.error("[github/service] Failed to fetch pull requests", {
      repositoryId,
      organizationId,
      error: parseError(error),
    });
    throw new Error("Failed to fetch pull requests from GitHub");
  }
}

/**
 * The installation-free repository behind an id, paired with the reader whose
 * credential resolves it. Returns null without a reader: the observation lane
 * has no server credential to fall back on, and borrowing an arbitrary member's
 * grant is not a fallback — it is an attribution bug.
 */
async function resolveObservedRepository(
  repositoryId: string,
  organizationId: string,
  readerUserId: string | undefined
): Promise<{ repository: VerifiedObservedRepository; userId: string } | null> {
  if (!readerUserId) {
    return null;
  }
  const repository = await findVerifiedObservedRepository(
    repositoryId,
    organizationId
  );
  return repository ? { repository, userId: readerUserId } : null;
}
