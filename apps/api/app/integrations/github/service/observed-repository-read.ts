import type {
  GetBranchesResponse,
  GetPullRequestsResponse,
} from "@repo/api/src/types/github";
import { GitHubFetchCredentialType } from "@repo/api/src/types/github-read-model";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { getRepositoryBranches } from "@repo/github";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { GitHubAccessIntent } from "@/lib/github/github-access";
import { getGitHubClient } from "@/lib/github/github-client-resolver";
import {
  createGitHubReadCostObserver,
  type GitHubReadCostRoute,
} from "@/lib/github/github-read-cost-log";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import { getTrackedPullRequestState } from "../tracked-pull-requests";
import {
  buildRepositoryPullRequestsResponse,
  type RepositoryPullRequestReadOptions,
  readRepositoryPullRequestsWithAuthority,
  TARGET_PULL_REQUEST_MAX_ITEMS,
  TARGET_PULL_REQUEST_MAX_PAGES,
} from "./pull-request-list-read";

/**
 * PLN-1775 M7: the installation-free half of the three GitHub read routes.
 *
 * An org with no GitHub App installation still has repositories we have proven
 * we can read — `github_observed_repository` rows the desktop named and the M2
 * verifier confirmed with a pooled Clerk token. This module projects those rows
 * into the same response shapes `service.ts` returns for installation repos and
 * reads them through the INTERACTIVE resolver (`getGitHubClient`), never the
 * sync pool: a user-facing read must not draw against the reconciler's reserve
 * floor.
 *
 * The rows it serves are org-visible and can describe a member's PRIVATE
 * repository. That is bounded by decision A — a repo only lands here because
 * the org's own agent sessions worked in it — but it means every read here is
 * org-scoped at the query, never at the caller.
 */

const LOG_PREFIX = "[github/observed-repository-read]";

const VERIFIED_OBSERVED_REPOSITORY_SELECT = {
  id: true,
  repositoryFullName: true,
  owner: true,
  name: true,
  githubRepoId: true,
  isPrivate: true,
  lastPushedAt: true,
  defaultBranchName: true,
  defaultBranchAvailability: true,
  defaultBranchCompleteness: true,
  defaultBranchReason: true,
  defaultBranchSource: true,
  defaultBranchMechanism: true,
  defaultBranchTrigger: true,
  defaultBranchCredentialType: true,
  defaultBranchCredentialOwnerId: true,
  defaultBranchObservationKey: true,
  defaultBranchObservedAt: true,
  defaultBranchEventAt: true,
} as const;

type ObservedRepositoryRow = {
  id: string;
  repositoryFullName: string;
  owner: string | null;
  name: string | null;
  githubRepoId: string | null;
  isPrivate: boolean | null;
  lastPushedAt: Date | null;
  defaultBranchName: string | null;
  defaultBranchAvailability: string | null;
  defaultBranchCompleteness: string | null;
  defaultBranchReason: string | null;
  defaultBranchSource: string | null;
  defaultBranchMechanism: string | null;
  defaultBranchTrigger: string | null;
  defaultBranchCredentialType: string | null;
  defaultBranchCredentialOwnerId: string | null;
  defaultBranchObservationKey: string | null;
  defaultBranchObservedAt: Date | null;
  defaultBranchEventAt: Date | null;
};

/**
 * A verified row that actually carries the identity verification writes. The
 * four narrowed fields are nullable in the schema because they are absent until
 * a repo is verified; a `verified` row missing any of them is corrupt, not
 * merely incomplete, and is dropped rather than projected with a filled-in
 * value (AGENTS.md: never emit a plausible-but-wrong value).
 */
export type VerifiedObservedRepository = Omit<
  ObservedRepositoryRow,
  "owner" | "name" | "githubRepoId" | "isPrivate"
> & {
  owner: string;
  name: string;
  githubRepoId: string;
  isPrivate: boolean;
  /** Provider casing (`owner/name`), not the normalized identity column. */
  fullName: string;
};

/**
 * The org's verified observation rows, ordered exactly as the installation list
 * is (`lastPushedAt` desc nulls last, then `name` asc) so the two paths present
 * one list to the same consumers.
 *
 * Empty when an ACTIVE installation exists: that org is served by the
 * installation list, and mixing the two would put a `source` this build's
 * peers may not know in front of a client that has no reason to see it.
 */
export async function listVerifiedObservedRepositories(
  organizationId: string
): Promise<VerifiedObservedRepository[]> {
  const activeInstallation = await withDb((db) =>
    db.gitHubInstallation.findFirst({
      where: { organizationId, status: GitHubInstallationStatus.ACTIVE },
      select: { id: true },
    })
  );
  if (activeInstallation) {
    return [];
  }

  const rows = await withDb((db) =>
    db.gitHubObservedRepository.findMany({
      where: {
        organizationId,
        verificationState: GitHubObservedRepositoryVerificationState.Verified,
      },
      select: VERIFIED_OBSERVED_REPOSITORY_SELECT,
      orderBy: [
        { lastPushedAt: { sort: "desc", nulls: "last" } },
        { name: "asc" },
      ],
    })
  );
  return usableObservedRepositories(rows, organizationId);
}

/**
 * Resolve one observation-row id for the branch/PR sub-routes. Deliberately NOT
 * gated on the absence of an installation the way the list is: an id only
 * reaches here because the list handed it out, and failing an id the same org
 * legitimately owns would be the harder failure to diagnose.
 */
export async function findVerifiedObservedRepository(
  observedRepositoryId: string,
  organizationId: string
): Promise<VerifiedObservedRepository | null> {
  const row = await withDb((db) =>
    db.gitHubObservedRepository.findFirst({
      where: {
        id: observedRepositoryId,
        organizationId,
        verificationState: GitHubObservedRepositoryVerificationState.Verified,
      },
      select: VERIFIED_OBSERVED_REPOSITORY_SELECT,
    })
  );
  if (!row) {
    return null;
  }
  return usableObservedRepositories([row], organizationId)[0] ?? null;
}

export type ObservedRepositoryReadInput = {
  repository: VerifiedObservedRepository;
  organizationId: string;
  userId: string;
};

/** Branches for a verified observation row, read as the requesting user. */
export async function readObservedRepositoryBranches(
  input: ObservedRepositoryReadInput & { limit: number }
): Promise<GetBranchesResponse> {
  const octokit = await resolveObservedRepositoryOctokit(
    input,
    "Failed to fetch branches from GitHub"
  );
  try {
    const branches = await getRepositoryBranches(
      octokit,
      input.repository.owner,
      input.repository.name,
      input.limit
    );
    return { branches };
  } catch (error) {
    log.error(`${LOG_PREFIX} Failed to fetch branches`, {
      organizationId: input.organizationId,
      observedRepositoryId: input.repository.id,
      fullName: input.repository.fullName,
      error: parseError(error),
    });
    throw new Error("Failed to fetch branches from GitHub");
  }
}

/** Pull requests for a verified observation row, read as the requesting user. */
export async function readObservedRepositoryPullRequests(
  input: ObservedRepositoryReadInput & {
    projectId: string | null;
    options?: RepositoryPullRequestReadOptions;
    costRoute?: GitHubReadCostRoute;
  }
): Promise<GetPullRequestsResponse> {
  const octokit = await resolveObservedRepositoryOctokit(
    input,
    "Failed to fetch pull requests from GitHub"
  );
  const { repository, options } = input;
  try {
    // `repositoryId: null` is the repo-less selector: PullRequestDetail rows for
    // installation-free orgs key on `repositoryFullName`.
    const tracked = await getTrackedPullRequestState({
      organizationId: input.organizationId,
      projectId: input.projectId,
      repositoryFullName: repository.fullName,
      repositoryId: null,
      ...(options?.trackingScope
        ? { trackingScope: options.trackingScope }
        : {}),
    });
    const targetNumbers = tracked.trackedPrNumbers;
    const pullRequests = await readRepositoryPullRequestsWithAuthority(
      octokit,
      repository.owner,
      repository.name,
      {
        state: "all",
        limit: options?.limit ?? 30,
        maxItems:
          targetNumbers.length > 0 ? TARGET_PULL_REQUEST_MAX_ITEMS : undefined,
        maxPages:
          targetNumbers.length > 0 ? TARGET_PULL_REQUEST_MAX_PAGES : undefined,
        targetNumbers,
      },
      input.costRoute
        ? createGitHubReadCostObserver({
            route: input.costRoute,
            organizationId: input.organizationId,
            repositoryId: repository.id,
            repositoryFullName: repository.fullName,
          })
        : undefined,
      {
        type: GitHubFetchCredentialType.UserOAuth,
        ownerId: input.userId,
      }
    );
    return buildRepositoryPullRequestsResponse(pullRequests, tracked);
  } catch (error) {
    log.error(`${LOG_PREFIX} Failed to fetch pull requests`, {
      organizationId: input.organizationId,
      observedRepositoryId: repository.id,
      fullName: repository.fullName,
      error: parseError(error),
    });
    throw new Error("Failed to fetch pull requests from GitHub");
  }
}

/**
 * A denial is a credential-state answer, not a crash: it is logged with its
 * reason and then surfaced as the SAME error the installation path throws when
 * its own read fails, so `computeRepoQueryStatus` and the desktop's
 * `CloudHydrationFailureCooldown` see the failure shape they already handle
 * rather than an unclassified 500.
 */
async function resolveObservedRepositoryOctokit(
  input: ObservedRepositoryReadInput,
  failureMessage: string
) {
  const client = await getGitHubClient({
    organizationId: input.organizationId,
    userId: input.userId,
    target: { owner: input.repository.owner, repo: input.repository.name },
    intent: GitHubAccessIntent.ReadAsUser,
  });
  if (client.ok) {
    return client.value.octokit;
  }
  log.warn(`${LOG_PREFIX} Denied a verified observed repository read`, {
    organizationId: input.organizationId,
    observedRepositoryId: input.repository.id,
    fullName: input.repository.fullName,
    denialReason: client.error.reason,
  });
  throw new Error(failureMessage);
}

function usableObservedRepositories(
  rows: readonly ObservedRepositoryRow[],
  organizationId: string
): VerifiedObservedRepository[] {
  const usable: VerifiedObservedRepository[] = [];
  const corruptIds: string[] = [];
  for (const row of rows) {
    const { owner, name, githubRepoId, isPrivate } = row;
    if (!(owner && name && githubRepoId) || isPrivate === null) {
      corruptIds.push(row.id);
      continue;
    }
    usable.push({
      ...row,
      owner,
      name,
      githubRepoId,
      isPrivate,
      fullName: `${owner}/${name}`,
    });
  }
  if (corruptIds.length > 0) {
    log.error(
      `${LOG_PREFIX} Verified rows are missing the identity verification writes`,
      { organizationId, observedRepositoryIds: corruptIds }
    );
  }
  return usable;
}
