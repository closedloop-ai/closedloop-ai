import {
  BranchStatus,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import type {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  normalizeRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
  repositoryDefaultUnavailableObservationValidator,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import type {
  BranchCloudHydrationOverlay,
  RepositoryDefaultAuthorityReadName,
} from "./desktop-cloud-github-hydration.js";

/** Preserve an available head identity or the provider's exact typed absence. */
export function pullRequestHeadRepositoryOverlay(pullRequest: {
  headRepository?: unknown;
  headRepositoryUnavailable?: unknown;
}): Pick<
  BranchCloudHydrationOverlay,
  | "headRepositoryProvider"
  | "headRepositoryProviderId"
  | "headRepositoryFullName"
  | "headRepositoryUnavailableReason"
> {
  const hasAuthority = Object.hasOwn(pullRequest, "headRepository");
  const hasUnavailable = Object.hasOwn(
    pullRequest,
    "headRepositoryUnavailable"
  );
  if (hasAuthority && hasUnavailable) {
    return { headRepositoryUnavailableReason: RepositoryDefaultReason.Unknown };
  }
  const authority = normalizeRepositoryDefaultAuthority(
    pullRequest.headRepository
  );
  if (
    hasAuthority &&
    authority?.repository.provider === VcsProviderKind.GitHub
  ) {
    return {
      headRepositoryProvider: authority.repository.provider,
      headRepositoryProviderId: authority.repository.providerRepositoryId,
      headRepositoryFullName: authority.repository.fullName,
    };
  }
  if (hasAuthority) {
    return { headRepositoryUnavailableReason: RepositoryDefaultReason.Unknown };
  }
  const unavailable =
    repositoryDefaultUnavailableObservationValidator.safeParse(
      pullRequest.headRepositoryUnavailable
    );
  if (hasUnavailable) {
    return {
      headRepositoryUnavailableReason: unavailable.success
        ? unavailable.data.reason
        : RepositoryDefaultReason.Unknown,
    };
  }
  return {};
}

/** Merge fresh bounded results over retained overlays for eligibility only. */
export function mergeEligibilityOverlays(
  persisted: Record<string, BranchCloudHydrationOverlay>,
  current: Record<string, BranchCloudHydrationOverlay> | undefined,
  pullRequestIncompleteReasons: Readonly<
    Record<string, RepositoryDefaultReason>
  > = {}
): Record<string, BranchCloudHydrationOverlay> {
  const merged: Record<string, BranchCloudHydrationOverlay> =
    Object.create(null);
  for (const [key, overlay] of Object.entries(persisted)) {
    const normalizedKey = normalizeRepositoryBranchOverlayKey(key);
    merged[normalizedKey] = omitLegacyPullRequestCoveragePoison(overlay);
  }
  const incompleteReasons = normalizeIncompleteReasonKeys(
    pullRequestIncompleteReasons
  );
  for (const [key, overlay] of Object.entries(current ?? {})) {
    const normalizedKey = normalizeRepositoryBranchOverlayKey(key);
    const repositoryName = repositoryNameFromOverlayKey(normalizedKey);
    if (
      repositoryName &&
      incompleteReasons[repositoryName] !== undefined &&
      overlay.prNumber === undefined
    ) {
      merged[normalizedKey] = { ...merged[normalizedKey], ...overlay };
      continue;
    }
    merged[normalizedKey] = mergePersistedEligibilityOverlay(
      merged[normalizedKey],
      overlay
    );
  }
  return { ...merged };
}

/** Apply current-response authority absence over retained account-scoped rows. */
export function applyCurrentAuthorityOverrides(
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[],
  overrides: readonly NormalizedPersistedRepositoryDefaultAuthority[],
  unavailableNames: readonly string[]
): NormalizedPersistedRepositoryDefaultAuthority[] {
  if (overrides.length === 0 && unavailableNames.length === 0) {
    return [...authorities];
  }
  const overrideKeys = new Set(overrides.map(authorityIdentityKey));
  const unavailableNameSet = new Set(
    unavailableNames.map(normalizeRepoFullName)
  );
  return [
    ...authorities
      .filter((authority) => !overrideKeys.has(authorityIdentityKey(authority)))
      .map((authority) =>
        unavailableNameSet.has(
          normalizeRepoFullName(authority.repository.fullName)
        )
          ? unavailableAuthority(authority)
          : authority
      ),
    ...overrides,
  ];
}

/** Merge two PRs returned for one base+branch without order-dependent identity. */
export function mergeCurrentPullRequestOverlay(
  current: BranchCloudHydrationOverlay | undefined,
  incoming: BranchCloudHydrationOverlay
): BranchCloudHydrationOverlay {
  if (!current) {
    return incoming;
  }
  const merged = { ...current, ...incoming };
  if (typeof current.prNumber !== "number") {
    return merged;
  }
  const currentObservation = headRepositoryObservationKey(current);
  const incomingObservation = headRepositoryObservationKey(incoming);
  if (currentObservation === undefined || incomingObservation === undefined) {
    if (current.prNumber === incoming.prNumber) {
      if (
        currentObservation === undefined &&
        incomingObservation === undefined
      ) {
        return merged;
      }
      const retained = currentObservation === undefined ? incoming : current;
      return {
        ...omitHeadRepositoryObservation(merged),
        ...headRepositoryObservationFields(retained),
      };
    }
    return unavailableOverlay(merged, RepositoryDefaultReason.Unknown);
  }
  if (currentObservation === incomingObservation) {
    return merged;
  }
  const currentReason = current.headRepositoryUnavailableReason;
  const incomingReason = incoming.headRepositoryUnavailableReason;
  if (currentReason !== undefined && incomingReason === undefined) {
    return unavailableOverlay(merged, currentReason);
  }
  if (incomingReason !== undefined && currentReason === undefined) {
    return unavailableOverlay(merged, incomingReason);
  }
  return {
    ...omitHeadRepositoryObservation(merged),
    headRepositoryUnavailableReason: RepositoryDefaultReason.Ambiguous,
  };
}

export type CloudHydrationOverlayResponse = {
  repository: { fullName: string };
  branches: Array<{ name: string; committedDate: string }>;
  pullRequests: Array<{
    number: number;
    title: string;
    htmlUrl: string;
    headBranch: string;
    baseBranch: string;
    state: GitHubPRState;
    mergedAt?: string | null;
    updatedAt: string;
    additions?: number | null;
    deletions?: number | null;
    changedFiles?: number | null;
    checksStatus?: ChecksStatus | null;
    reviewDecision?: ReviewDecision | null;
    headRepository?: unknown;
    headRepositoryUnavailable?: unknown;
  }>;
  pullRequestIncompleteReason?: RepositoryDefaultReason;
};

/** Build overlays while preserving partial evidence and explicit incompleteness. */
export function buildCloudOverlays(
  responses: readonly CloudHydrationOverlayResponse[]
): Record<string, BranchCloudHydrationOverlay> {
  const overlays: Record<string, BranchCloudHydrationOverlay> =
    Object.create(null);
  const prReasonByRepository = collectPullRequestIncompleteReasons(responses);
  for (const response of responses) {
    for (const branch of response.branches) {
      const key = overlayKey(response.repository.fullName, branch.name);
      overlays[key] = {
        ...overlays[key],
        lastActivityAt: maxIso(
          overlays[key]?.lastActivityAt,
          branch.committedDate
        ),
      };
    }
    for (const pullRequest of response.pullRequests) {
      const key = overlayKey(
        response.repository.fullName,
        pullRequest.headBranch
      );
      const incoming = pullRequestOverlay(pullRequest, overlays[key]);
      overlays[key] = mergeCurrentPullRequestOverlay(overlays[key], incoming);
    }
  }
  for (const response of responses) {
    for (const branch of response.branches) {
      const key = overlayKey(response.repository.fullName, branch.name);
      if (typeof overlays[key]?.prNumber === "number") {
        continue;
      }
      if (
        prReasonByRepository[
          normalizeRepoFullName(response.repository.fullName)
        ] !== undefined
      ) {
        continue;
      }
      overlays[key] = { ...overlays[key], prNumber: null };
    }
  }
  return overlays;
}

/** Confirm no PR only for repositories whose current PR response is complete. */
export function applyCompletePullRequestCoverageToCandidates(
  overlays: Record<string, BranchCloudHydrationOverlay> | undefined,
  completeRepositoryNames: ReadonlySet<string>,
  currentPullRequestBranchKeys: ReadonlySet<string>,
  requestedCandidates: readonly {
    branchName: string;
    repoFullName: string | null;
  }[]
): Record<string, BranchCloudHydrationOverlay> {
  const projected = { ...overlays };
  const normalizedCompleteRepositoryNames = new Set(
    [...completeRepositoryNames].map(normalizeRepoFullName)
  );
  const normalizedCurrentPullRequestBranchKeys = new Set(
    [...currentPullRequestBranchKeys].map(normalizeRepositoryBranchOverlayKey)
  );
  for (const candidate of requestedCandidates) {
    if (
      !(
        candidate.repoFullName &&
        normalizedCompleteRepositoryNames.has(
          normalizeRepoFullName(candidate.repoFullName)
        )
      )
    ) {
      continue;
    }
    const key = overlayKey(candidate.repoFullName, candidate.branchName);
    if (normalizedCurrentPullRequestBranchKeys.has(key)) {
      continue;
    }
    projected[key] = confirmedNoPullRequestOverlay(projected[key]);
  }
  return projected;
}

/** Capture repository-level PR coverage gaps independently of caller rows. */
export function collectPullRequestIncompleteReasons(
  responses: readonly CloudHydrationOverlayResponse[]
): Record<string, RepositoryDefaultReason> {
  const reasons: Record<string, RepositoryDefaultReason> = Object.create(null);
  for (const response of responses) {
    if (response.pullRequestIncompleteReason !== undefined) {
      reasons[normalizeRepoFullName(response.repository.fullName)] =
        response.pullRequestIncompleteReason;
    }
  }
  return reasons;
}

/** Resolve unique provider-qualified selected and fork repository names. */
export function collectAuthorityRepositories(
  selectedRepoNames: readonly string[],
  overlays: Record<string, BranchCloudHydrationOverlay> | undefined
): RepositoryDefaultAuthorityReadName[] {
  const repositories = new Map<string, RepositoryDefaultAuthorityReadName>();
  for (const fullName of selectedRepoNames) {
    repositories.set(`${VcsProviderKind.GitHub}:${fullName}`, {
      provider: VcsProviderKind.GitHub,
      fullName,
    });
  }
  for (const overlay of Object.values(overlays ?? {})) {
    if (overlay.headRepositoryProvider && overlay.headRepositoryFullName) {
      repositories.set(
        `${overlay.headRepositoryProvider}:${overlay.headRepositoryFullName}`,
        {
          provider: overlay.headRepositoryProvider,
          fullName: overlay.headRepositoryFullName,
        }
      );
    }
  }
  return [...repositories.values()].sort((left, right) =>
    `${left.provider}:${left.fullName}`.localeCompare(
      `${right.provider}:${right.fullName}`
    )
  );
}

function hasHeadRepositoryObservation(
  overlay: BranchCloudHydrationOverlay
): boolean {
  return (
    overlay.headRepositoryProvider !== undefined ||
    overlay.headRepositoryProviderId !== undefined ||
    overlay.headRepositoryFullName !== undefined ||
    overlay.headRepositoryUnavailableReason !== undefined
  );
}

export function mergePersistedEligibilityOverlay(
  persisted: BranchCloudHydrationOverlay | undefined,
  current: BranchCloudHydrationOverlay
): BranchCloudHydrationOverlay {
  const base = { ...current };
  if (hasHeadRepositoryObservation(current)) {
    if (
      persisted?.prNumber === current.prNumber &&
      headRepositoryIdentityKey(persisted) !== undefined &&
      headRepositoryIdentityKey(current) !== undefined &&
      headRepositoryIdentityKey(persisted) !==
        headRepositoryIdentityKey(current)
    ) {
      return {
        ...omitHeadRepositoryObservation(base),
        headRepositoryUnavailableReason: RepositoryDefaultReason.Ambiguous,
      };
    }
    return { ...omitHeadRepositoryObservation(base), ...current };
  }
  if (typeof current.prNumber === "number") {
    if (
      persisted?.prNumber === current.prNumber &&
      hasHeadRepositoryObservation(persisted)
    ) {
      return {
        ...base,
        ...headRepositoryObservationFields(persisted),
      };
    }
    return {
      ...omitHeadRepositoryObservation(base),
      headRepositoryUnavailableReason: RepositoryDefaultReason.Unknown,
    };
  }
  return omitHeadRepositoryObservation(base);
}

function headRepositoryObservationKey(
  overlay: BranchCloudHydrationOverlay | undefined
): string | undefined {
  if (!overlay) {
    return undefined;
  }
  if (overlay.headRepositoryUnavailableReason !== undefined) {
    return `reason:${overlay.headRepositoryUnavailableReason}`;
  }
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

function headRepositoryIdentityKey(
  overlay: BranchCloudHydrationOverlay | undefined
): string | undefined {
  if (
    overlay?.headRepositoryProvider === undefined ||
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

function headRepositoryObservationFields(
  overlay: BranchCloudHydrationOverlay
): BranchCloudHydrationOverlay {
  if (overlay.headRepositoryUnavailableReason !== undefined) {
    return {
      headRepositoryUnavailableReason: overlay.headRepositoryUnavailableReason,
    };
  }
  return {
    ...(overlay.headRepositoryProvider === undefined
      ? {}
      : { headRepositoryProvider: overlay.headRepositoryProvider }),
    ...(overlay.headRepositoryProviderId === undefined
      ? {}
      : { headRepositoryProviderId: overlay.headRepositoryProviderId }),
    ...(overlay.headRepositoryFullName === undefined
      ? {}
      : { headRepositoryFullName: overlay.headRepositoryFullName }),
  };
}

function unavailableOverlay(
  overlay: BranchCloudHydrationOverlay,
  reason: RepositoryDefaultReason
): BranchCloudHydrationOverlay {
  return {
    ...omitHeadRepositoryObservation(overlay),
    headRepositoryUnavailableReason: reason,
  };
}

function omitHeadRepositoryObservation(
  overlay: BranchCloudHydrationOverlay | undefined
): BranchCloudHydrationOverlay {
  if (!overlay) {
    return {};
  }
  const {
    headRepositoryProvider: _provider,
    headRepositoryProviderId: _providerId,
    headRepositoryFullName: _fullName,
    headRepositoryUnavailableReason: _unavailableReason,
    ...rest
  } = overlay;
  return rest;
}

function omitLegacyPullRequestCoveragePoison(
  overlay: BranchCloudHydrationOverlay
): BranchCloudHydrationOverlay {
  if (
    typeof overlay.prNumber === "number" ||
    (overlay.headRepositoryUnavailableReason !==
      RepositoryDefaultReason.Capped &&
      overlay.headRepositoryUnavailableReason !==
        RepositoryDefaultReason.ProviderError)
  ) {
    return overlay;
  }
  return omitHeadRepositoryObservation(overlay);
}

function confirmedNoPullRequestOverlay(
  overlay: BranchCloudHydrationOverlay | undefined
): BranchCloudHydrationOverlay {
  return {
    ...(overlay?.lastActivityAt === undefined
      ? {}
      : { lastActivityAt: overlay.lastActivityAt }),
    prNumber: null,
  };
}

function pullRequestOverlay(
  pullRequest: CloudHydrationOverlayResponse["pullRequests"][number],
  current: BranchCloudHydrationOverlay | undefined
): BranchCloudHydrationOverlay {
  return {
    baseBranch: pullRequest.baseBranch,
    status: branchStatus(pullRequest.state),
    prNumber: pullRequest.number,
    prTitle: pullRequest.title,
    prState: pullRequest.state,
    prUrl: pullRequest.htmlUrl,
    mergedAt: pullRequest.mergedAt,
    ...pullRequestLoc(pullRequest),
    checksStatus: pullRequest.checksStatus ?? null,
    reviewDecision: pullRequest.reviewDecision ?? null,
    lastActivityAt: maxIso(current?.lastActivityAt, pullRequest.updatedAt),
    ...pullRequestHeadRepositoryOverlay(pullRequest),
  };
}

function pullRequestLoc(
  pullRequest: CloudHydrationOverlayResponse["pullRequests"][number]
): Pick<
  BranchCloudHydrationOverlay,
  "additions" | "deletions" | "filesChanged"
> {
  return {
    ...(pullRequest.additions === undefined
      ? {}
      : { additions: pullRequest.additions }),
    ...(pullRequest.deletions === undefined
      ? {}
      : { deletions: pullRequest.deletions }),
    ...(pullRequest.changedFiles === undefined
      ? {}
      : { filesChanged: pullRequest.changedFiles }),
  };
}

function branchStatus(state: GitHubPRState): BranchStatus {
  if (state === GitHubPRState.Merged) {
    return BranchStatus.Merged;
  }
  return state === GitHubPRState.Closed
    ? BranchStatus.Closed
    : BranchStatus.Open;
}

function maxIso(left: string | null | undefined, right: string): string {
  return !left || Date.parse(right) > Date.parse(left) ? right : left;
}

/** Canonical overlay key: repository identity normalized, branch preserved. */
export function repositoryBranchOverlayKey(
  repoFullName: string,
  branchName: string
): string {
  return `${normalizeRepoFullName(repoFullName)}::${branchName}`;
}

function overlayKey(repoFullName: string, branchName: string): string {
  return repositoryBranchOverlayKey(repoFullName, branchName);
}

/** Normalize the repository segment of an existing overlay key when present. */
export function normalizeRepositoryBranchOverlayKey(key: string): string {
  const separator = key.indexOf("::");
  return separator < 0
    ? key
    : repositoryBranchOverlayKey(
        key.slice(0, separator),
        key.slice(separator + 2)
      );
}

function repositoryNameFromOverlayKey(key: string): string | undefined {
  const separator = key.indexOf("::");
  return separator < 0
    ? undefined
    : normalizeRepoFullName(key.slice(0, separator));
}

function normalizeIncompleteReasonKeys(
  reasons: Readonly<Record<string, RepositoryDefaultReason>>
): Record<string, RepositoryDefaultReason> {
  const normalized: Record<string, RepositoryDefaultReason> =
    Object.create(null);
  for (const [repository, reason] of Object.entries(reasons)) {
    normalized[normalizeRepoFullName(repository)] = reason;
  }
  return normalized;
}

function authorityIdentityKey(
  authority: NormalizedPersistedRepositoryDefaultAuthority
): string {
  return [
    authority.repository.provider,
    authority.repository.providerRepositoryId,
    normalizeRepoFullName(authority.repository.fullName),
  ].join(":");
}

function unavailableAuthority(
  authority: NormalizedPersistedRepositoryDefaultAuthority
): NormalizedPersistedRepositoryDefaultAuthority {
  return {
    repository: authority.repository,
    evidence: {
      availability: RepositoryDefaultAvailability.Unavailable,
      completeness: RepositoryDefaultCompleteness.Unavailable,
      reason: RepositoryDefaultReason.PermissionFiltered,
    },
  };
}
