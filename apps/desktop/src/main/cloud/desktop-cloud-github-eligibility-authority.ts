import {
  BranchCloudHydrationStatus,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  type RepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import type { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import {
  mergeEligibilityOverlays,
  normalizeRepositoryBranchOverlayKey,
  repositoryBranchOverlayKey,
} from "./desktop-cloud-github-eligibility-overlays.js";
import type {
  BranchCloudHydrationOverlay,
  DesktopCloudGitHubHydrationResult,
} from "./desktop-cloud-github-hydration.js";
import type {
  CloudHydrationResponse,
  CloudRepository,
} from "./desktop-cloud-github-hydration-schema.js";

/** Capture only current-response evidence used to qualify eligibility reads. */
export function buildCurrentEligibilityEvidence(
  authorities: readonly RepositoryDefaultAuthority[],
  completePullRequestRepositoryNames: ReadonlySet<string>,
  currentPullRequestBranchKeys: ReadonlySet<string>,
  failedRequestKinds: ReadonlySet<CloudHydrationRequestKind>
): CurrentEligibilityEvidence {
  const uniqueAuthorities = dedupeCurrentAuthorityVerdicts(authorities);
  return {
    authorities: uniqueAuthorities,
    completeAuthorityKeys: new Set(
      uniqueAuthorities
        .filter(isCompleteAuthority)
        .map(repositoryAuthorityIdentityKey)
    ),
    completePullRequestRepositoryNames: new Set(
      [...completePullRequestRepositoryNames].map(normalizeRepoFullName)
    ),
    currentPullRequestBranchKeys: new Set(
      [...currentPullRequestBranchKeys].map(normalizeRepositoryBranchOverlayKey)
    ),
    failedRequestKinds: new Set(failedRequestKinds),
  };
}

/** Collapse repeated provenance for one verdict without hiding conflicts. */
function dedupeCurrentAuthorityVerdicts(
  authorities: readonly RepositoryDefaultAuthority[]
): RepositoryDefaultAuthority[] {
  const unique = new Map<string, RepositoryDefaultAuthority>();
  for (const authority of authorities) {
    const key = JSON.stringify([authority.repository, authority.evidence]);
    if (!unique.has(key)) {
      unique.set(key, authority);
    }
  }
  return [...unique.values()];
}

/** Fold independently settled branch/PR requests without widening failures. */
export function collectHydrationResponses(
  requests: readonly CloudHydrationRequest[],
  settled: readonly PromiseSettledResult<CloudHydrationResponse>[]
): HydrationResponseCollection {
  const responses: CloudHydrationResponse[] = [];
  const completePullRequestRepositoryNames = new Set<string>();
  const currentPullRequestBranchKeys = new Set<string>();
  const failedRequestKinds = new Set<CloudHydrationRequestKind>();
  for (const [index, response] of settled.entries()) {
    const request = requests[index];
    if (!request) {
      continue;
    }
    if (response.status === "fulfilled") {
      responses.push(response.value);
      collectCurrentPullRequestEvidence(
        request,
        response.value,
        completePullRequestRepositoryNames,
        currentPullRequestBranchKeys
      );
      continue;
    }
    failedRequestKinds.add(request.kind);
    if (request.kind === CloudHydrationRequestKind.PullRequests) {
      responses.push({
        repository: request.repository,
        branches: [],
        pullRequests: [],
        pullRequestIncompleteReason: RepositoryDefaultReason.ProviderError,
      });
    }
  }
  return {
    responses,
    completePullRequestRepositoryNames,
    currentPullRequestBranchKeys,
    failedRequestKinds,
  };
}

/** True when the provider's repository list settled for this hydration pass. */
export function hasCurrentRepositoryResponse(
  evidence: CurrentEligibilityEvidence
): boolean {
  return !evidence.failedRequestKinds.has(CloudHydrationRequestKind.Repository);
}

/**
 * Persisted fork identity remains useful when PR coverage is incomplete, but
 * its default-branch verdict is usable only when this pass observed the exact
 * provider-qualified fork authority.
 */
export function applyCurrentForkAuthorityFreshness(
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[],
  overlays: Record<string, BranchCloudHydrationOverlay> | undefined,
  selectedRepositoryNames: readonly string[],
  completeAuthorityKeys: ReadonlySet<string>
): NormalizedPersistedRepositoryDefaultAuthority[] {
  const selectedNames = new Set(
    selectedRepositoryNames.map(normalizeRepoFullName)
  );
  const referencedForkKeys = new Set<string>();
  for (const overlay of Object.values(overlays ?? {})) {
    const key = headRepositoryIdentityKey(overlay);
    if (
      key &&
      overlay.headRepositoryFullName &&
      !selectedNames.has(normalizeRepoFullName(overlay.headRepositoryFullName))
    ) {
      referencedForkKeys.add(key);
    }
  }
  return authorities.map((authority) => {
    const key = repositoryAuthorityIdentityKey(authority);
    if (!referencedForkKeys.has(key) || completeAuthorityKeys.has(key)) {
      return authority;
    }
    return {
      repository: authority.repository,
      evidence: {
        availability: RepositoryDefaultAvailability.Unavailable,
        completeness: RepositoryDefaultCompleteness.Unavailable,
        reason: RepositoryDefaultReason.NotReported,
      },
    };
  });
}

/** Merge a failed current pass without retaining stale authority verdicts. */
export function staleHydrationResult(
  base: Partial<DesktopCloudGitHubHydrationResult>,
  failed: DesktopCloudGitHubHydrationResult
): DesktopCloudGitHubHydrationResult {
  const {
    repositoryDefaultAuthorityOverrides: _baseOverrides,
    repositoryDefaultAuthorityUnavailableNames: _baseUnavailableNames,
    pullRequestIncompleteReasons: _basePullRequestIncompleteReasons,
    ...retainedBase
  } = base;
  return {
    ...retainedBase,
    status: BranchCloudHydrationStatus.Stale,
    overlays: mergeEligibilityOverlays(
      base.overlays ?? {},
      failed.overlays,
      failed.pullRequestIncompleteReasons
    ),
    ...(failed.failure === undefined ? {} : { failure: failed.failure }),
    ...(failed.repositoryDefaultAuthorityOverrides === undefined
      ? {}
      : {
          repositoryDefaultAuthorityOverrides:
            failed.repositoryDefaultAuthorityOverrides,
        }),
    ...(failed.repositoryDefaultAuthorityUnavailableNames === undefined
      ? {}
      : {
          repositoryDefaultAuthorityUnavailableNames:
            failed.repositoryDefaultAuthorityUnavailableNames,
        }),
    ...(failed.pullRequestIncompleteReasons === undefined
      ? {}
      : { pullRequestIncompleteReasons: failed.pullRequestIncompleteReasons }),
  };
}

/** Stable exact identity key shared by current and persisted authority rows. */
export function repositoryAuthorityIdentityKey(authority: {
  repository: {
    provider: VcsProviderKind;
    providerRepositoryId: string;
    fullName: string;
  };
}): string {
  return [
    authority.repository.provider,
    authority.repository.providerRepositoryId,
    normalizeRepoFullName(authority.repository.fullName),
  ].join(":");
}

function isCompleteAuthority(authority: {
  evidence: NormalizedPersistedRepositoryDefaultAuthority["evidence"];
}): boolean {
  return (
    authority.evidence.availability ===
      RepositoryDefaultAvailability.Available &&
    authority.evidence.completeness === RepositoryDefaultCompleteness.Complete
  );
}

function headRepositoryIdentityKey(
  overlay: BranchCloudHydrationOverlay
): string | undefined {
  if (
    overlay.headRepositoryProvider === undefined ||
    overlay.headRepositoryProviderId === undefined ||
    overlay.headRepositoryFullName === undefined
  ) {
    return undefined;
  }
  return [
    overlay.headRepositoryProvider,
    overlay.headRepositoryProviderId,
    normalizeRepoFullName(overlay.headRepositoryFullName),
  ].join(":");
}

function collectCurrentPullRequestEvidence(
  request: CloudHydrationRequest,
  response: CloudHydrationResponse,
  completeRepositoryNames: Set<string>,
  currentBranchKeys: Set<string>
): void {
  if (request.kind !== CloudHydrationRequestKind.PullRequests) {
    return;
  }
  if (response.pullRequestIncompleteReason === undefined) {
    completeRepositoryNames.add(request.repository.fullName);
  }
  for (const pullRequest of response.pullRequests) {
    currentBranchKeys.add(
      repositoryBranchOverlayKey(
        request.repository.fullName,
        pullRequest.headBranch
      )
    );
  }
}

export const CloudHydrationRequestKind = {
  Repository: "repository",
  Branches: "branches",
  PullRequests: "pull_requests",
} as const;
export type CloudHydrationRequestKind =
  (typeof CloudHydrationRequestKind)[keyof typeof CloudHydrationRequestKind];

export type CurrentEligibilityEvidence = {
  authorities: readonly RepositoryDefaultAuthority[];
  completeAuthorityKeys: ReadonlySet<string>;
  completePullRequestRepositoryNames: ReadonlySet<string>;
  currentPullRequestBranchKeys: ReadonlySet<string>;
  failedRequestKinds: ReadonlySet<CloudHydrationRequestKind>;
};

export type CloudHydrationRequest = {
  kind: CloudHydrationRequestKind;
  repository: CloudRepository;
  promise: Promise<CloudHydrationResponse>;
};

export type HydrationResponseCollection = {
  responses: CloudHydrationResponse[];
  completePullRequestRepositoryNames: ReadonlySet<string>;
  currentPullRequestBranchKeys: ReadonlySet<string>;
  failedRequestKinds: ReadonlySet<CloudHydrationRequestKind>;
};
