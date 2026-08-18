import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  normalizeRepositoryDefaultAuthority,
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  repositoryDefaultUnavailableObservationValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { z } from "zod";

/** Optional repository-list authority fields accepted from version-skewed peers. */
export const cloudRepositoryAuthorityShape = {
  repositoryDefaultAuthority: z.unknown().nullable().optional(),
};

/** Optional PR-head authority fields accepted from version-skewed peers. */
export const cloudPullRequestAuthorityShape = {
  headRepository: z.unknown().nullable().optional(),
  headRepositoryUnavailable: z.unknown().nullable().optional(),
};

export type CloudRepositoryAuthorityInput = {
  fullName: string;
  githubRepoId: string;
  repositoryDefaultAuthority?: unknown;
};

export type CloudPullRequestAuthorityInput = {
  headRepository?: unknown;
  headRepositoryUnavailable?: unknown;
};

/**
 * Normalize independently valid repository and PR-head observations. Typed
 * fork-head absence is parsed for compatibility but cannot be persisted
 * because it deliberately carries no repository identity; the selected/base
 * repository is never substituted.
 */
export function collectCloudRepositoryDefaultAuthorities(
  repositories: readonly CloudRepositoryAuthorityInput[],
  pullRequests: readonly CloudPullRequestAuthorityInput[],
  repoNames: readonly string[]
): RepositoryDefaultAuthority[] {
  const requestedRepositories = new Set(repoNames.map(normalizeRepoFullName));
  const observations: RepositoryDefaultAuthority[] = [];
  for (const repository of repositories) {
    if (
      !requestedRepositories.has(normalizeRepoFullName(repository.fullName))
    ) {
      continue;
    }
    const authority = normalizeRepositoryDefaultAuthority(
      repository.repositoryDefaultAuthority
    );
    if (authority && repositoryAuthorityMatchesOuter(repository, authority)) {
      observations.push(authority);
    }
  }
  for (const pullRequest of pullRequests) {
    const headAuthority = normalizeRepositoryDefaultAuthority(
      pullRequest.headRepository
    );
    if (headAuthority?.repository.provider === VcsProviderKind.GitHub) {
      observations.push(headAuthority);
    }
    // Validation is deliberately non-throwing: typed absence is a no-write
    // observation, and future/malformed peers must not block valid siblings.
    repositoryDefaultUnavailableObservationValidator.safeParse(
      pullRequest.headRepositoryUnavailable
    );
  }
  return observations;
}

/**
 * Classify selected repositories whose current response cannot prove usable
 * authority. These read-local overrides prevent an older persisted default
 * from winning when the current peer omitted, malformed, or mismatched the
 * additive authority group.
 */
export function collectCloudRepositoryDefaultAuthorityOverrides(
  repositories: readonly CloudRepositoryAuthorityInput[],
  repoNames: readonly string[]
): NormalizedPersistedRepositoryDefaultAuthority[] {
  const requestedRepositories = new Set(repoNames.map(normalizeRepoFullName));
  const overrides: NormalizedPersistedRepositoryDefaultAuthority[] = [];
  for (const repository of repositories) {
    const fullName = normalizeRepoFullName(repository.fullName);
    if (!requestedRepositories.has(fullName)) {
      continue;
    }
    const hasAuthority = Object.hasOwn(
      repository,
      "repositoryDefaultAuthority"
    );
    const authority = normalizeRepositoryDefaultAuthority(
      repository.repositoryDefaultAuthority
    );
    if (authority && repositoryAuthorityMatchesOuter(repository, authority)) {
      continue;
    }
    let reason: RepositoryDefaultReason = RepositoryDefaultReason.NotReported;
    if (hasAuthority) {
      reason = authority
        ? RepositoryDefaultReason.Malformed
        : RepositoryDefaultReason.Unknown;
    }
    overrides.push({
      repository: {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: repository.githubRepoId,
        fullName,
      },
      evidence: {
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason,
      },
    });
  }
  return overrides;
}

/** Reject nested identity spoofing without rejecting valid sibling records. */
function repositoryAuthorityMatchesOuter(
  repository: CloudRepositoryAuthorityInput,
  authority: RepositoryDefaultAuthority
): boolean {
  return (
    authority.repository.provider === VcsProviderKind.GitHub &&
    authority.repository.providerRepositoryId === repository.githubRepoId &&
    authority.repository.fullName === normalizeRepoFullName(repository.fullName)
  );
}
