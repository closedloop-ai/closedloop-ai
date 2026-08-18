import {
  BranchCloudHydrationStatus,
  decodeBranchId,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import type {
  BranchCloudHydrationOverlay,
  DesktopCloudGitHubHydrationResult,
  DesktopRepositoryDefaultEligibilityInputs,
  DesktopRepositoryDefaultEligibilityRequest,
} from "../cloud/desktop-cloud-github-hydration.js";
import {
  type BranchDefaultEligibilityDecision,
  BranchDefaultEligibilityOutcome,
  BranchDefaultExclusionCause,
  decideBranchDefaultEligibility,
} from "../database/branch-default-eligibility.js";

export type BranchDefaultEligibilityCandidateRow = {
  repoFullName: string | null;
  branchName: string;
  /** Local publication evidence projected only by Desktop Branch readers. */
  hasLocalPublication?: boolean;
};

export const BranchProductExclusionCause = {
  PublicationMissing: "publication_missing",
} as const;

export type BranchProductExclusionCause =
  (typeof BranchProductExclusionCause)[keyof typeof BranchProductExclusionCause];

export type BranchProductEligibilityDecision =
  | BranchDefaultEligibilityDecision
  | {
      outcome: typeof BranchDefaultEligibilityOutcome.Excluded;
      cause: typeof BranchProductExclusionCause.PublicationMissing;
    };

export type BranchDefaultEligibilitySource = {
  resolveRepositoryDefaultEligibilityInputs?: (
    request: DesktopRepositoryDefaultEligibilityRequest
  ) => Promise<DesktopRepositoryDefaultEligibilityInputs>;
};

/** One immutable eligibility result reused across a complete product read. */
export type BranchDefaultEligibilitySnapshot = {
  eligibleBranchIds: ReadonlySet<string>;
  /** Pre-publication active-Wrote + default-authority keys for LOC/$ divisors. */
  denominatorEligibleBranchIds: ReadonlySet<string>;
  exclusionsByKey: ReadonlyMap<string, BranchProductEligibilityDecision>;
  /**
   * False when this snapshot DECIDED NOTHING — the repository-default authority
   * was unavailable, so every candidate was excluded by the fail-closed path
   * rather than by a verdict about the branch.
   *
   * The exclusions carry that in `cause`, but a consumer that only reads
   * `eligibleBranchIds` sees a filter result identical to "every candidate is a
   * default branch", and an empty survivor set then reads downstream as an empty
   * population. Callers that report over the survivors must pass this on rather
   * than describe an unqualified cohort as an empty one (ISS-5987).
   */
  authoritative: boolean;
  /** False when any requested candidate lacks a definitive eligibility verdict. */
  coverageComplete: boolean;
  /** False when repository-scoped PR enrichment was capped or failed. */
  pullRequestCoverageComplete: boolean;
  /** Awaited result reused by same-operation PR-field projection. */
  resolvedHydration?: DesktopCloudGitHubHydrationResult;
};

/**
 * Resolve authoritative eligibility for every distinct raw branch candidate.
 * A missing resolver denotes a legacy internal caller; production IPC wiring
 * supplies the resolver and separately fails closed if it is unavailable.
 */
export async function resolveBranchDefaultEligibilitySnapshot(
  rows: readonly BranchDefaultEligibilityCandidateRow[],
  source: BranchDefaultEligibilitySource | undefined,
  options: Pick<
    DesktopRepositoryDefaultEligibilityRequest,
    "forceRefresh" | "scope"
  >
): Promise<BranchDefaultEligibilitySnapshot | null> {
  if (!source?.resolveRepositoryDefaultEligibilityInputs) {
    return null;
  }
  const candidates = uniqueCandidates(rows);
  if (candidates.length === 0) {
    return emptySnapshot();
  }
  const inputs = await source.resolveRepositoryDefaultEligibilityInputs({
    rows: candidates,
    forceRefresh: options.forceRefresh,
    scope: options.scope,
  });
  if (!hasFreshEligibilityInputs(inputs)) {
    return unavailableSnapshot(
      candidates,
      inputs.failure
        ? RepositoryDefaultReason.ProviderError
        : RepositoryDefaultReason.Unknown
    );
  }
  return buildSnapshot(
    candidates,
    inputs.authorities,
    inputs.overlays,
    inputs,
    false
  );
}

/** Resolve dual-evidence Product membership without changing denominator authority. */
export async function resolveBranchProductEligibilitySnapshot(
  rows: readonly BranchDefaultEligibilityCandidateRow[],
  source: BranchDefaultEligibilitySource | undefined,
  options: Pick<
    DesktopRepositoryDefaultEligibilityRequest,
    "forceRefresh" | "scope"
  >
): Promise<BranchDefaultEligibilitySnapshot | null> {
  if (!source?.resolveRepositoryDefaultEligibilityInputs) {
    return null;
  }
  const candidates = uniqueCandidates(rows);
  if (candidates.length === 0) {
    return emptySnapshot();
  }
  const inputs = await source.resolveRepositoryDefaultEligibilityInputs({
    rows: candidates,
    forceRefresh: options.forceRefresh,
    scope: options.scope,
  });
  if (!hasFreshEligibilityInputs(inputs)) {
    return unavailableSnapshot(
      candidates,
      inputs.failure
        ? RepositoryDefaultReason.ProviderError
        : RepositoryDefaultReason.Unknown
    );
  }
  return buildSnapshot(
    candidates,
    inputs.authorities,
    inputs.overlays,
    inputs,
    true
  );
}

/** Filter keyed evidence with the exact snapshot resolved for its operation. */
export function filterEligibleBranchRows<
  Row extends BranchDefaultEligibilityCandidateRow,
>(
  rows: readonly Row[],
  snapshot: BranchDefaultEligibilitySnapshot | null
): Row[] {
  if (snapshot === null) {
    return [...rows];
  }
  if (
    !snapshot.authoritative ||
    (!snapshot.coverageComplete && snapshot.eligibleBranchIds.size === 0)
  ) {
    throw new Error("repository default eligibility unavailable");
  }
  return rows.filter((row) =>
    snapshot.eligibleBranchIds.has(branchId(row.repoFullName, row.branchName))
  );
}

/** True only when the candidate is admitted by the operation's snapshot. */
export function isEligibleBranchKey(
  row: BranchDefaultEligibilityCandidateRow,
  snapshot: BranchDefaultEligibilitySnapshot | null
): boolean {
  return (
    snapshot === null ||
    snapshot.eligibleBranchIds.has(branchId(row.repoFullName, row.branchName))
  );
}

/** Whether every candidate selected into one requested cohort was decided. */
export function isEligibilityCoverageCompleteForCohort(
  snapshot: BranchDefaultEligibilitySnapshot | null | undefined,
  branchIds: readonly string[] | undefined
): boolean {
  if (!snapshot) {
    return true;
  }
  if (!snapshot.authoritative) {
    return false;
  }
  if (snapshot.coverageComplete) {
    return true;
  }
  if (!branchIds) {
    return false;
  }
  const selectedIds = new Set(branchIds);
  return [...snapshot.exclusionsByKey].every(([id, decision]) => {
    if (!(selectedIds.has(id) && "cause" in decision)) {
      return true;
    }
    return decision.cause !== BranchDefaultExclusionCause.AuthorityUnavailable;
  });
}

/** Return each eligible repository/branch key once in deterministic order. */
export function eligibleBranchKeys(
  rows: readonly BranchDefaultEligibilityCandidateRow[],
  snapshot: BranchDefaultEligibilitySnapshot | null
): BranchDefaultEligibilityCandidateRow[] {
  return uniqueCandidates(filterEligibleBranchRows(rows, snapshot));
}

/** Return denominator-authority keys without applying Product publication. */
export function denominatorEligibleBranchKeys(
  rows: readonly BranchDefaultEligibilityCandidateRow[],
  snapshot: BranchDefaultEligibilitySnapshot | null
): BranchDefaultEligibilityCandidateRow[] {
  if (snapshot === null) {
    return uniqueCandidates(rows);
  }
  return [...snapshot.denominatorEligibleBranchIds]
    .sort()
    .map((id) => decodeBranchId(id));
}

type FreshEligibilityInputs = Extract<
  DesktopRepositoryDefaultEligibilityInputs,
  | { status: typeof BranchCloudHydrationStatus.Fresh }
  | { eligibilityStatus: typeof BranchCloudHydrationStatus.Fresh }
>;

function hasFreshEligibilityInputs(
  inputs: DesktopRepositoryDefaultEligibilityInputs
): inputs is FreshEligibilityInputs {
  return (
    (inputs.eligibilityStatus ?? inputs.status) ===
    BranchCloudHydrationStatus.Fresh
  );
}

function buildSnapshot(
  rows: readonly BranchDefaultEligibilityCandidateRow[],
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[],
  overlays: Record<string, BranchCloudHydrationOverlay> | undefined,
  resolvedEligibility: FreshEligibilityInputs,
  requirePublication: boolean
): BranchDefaultEligibilitySnapshot {
  const eligibleBranchIds = new Set<string>();
  const denominatorEligibleBranchIds = new Set<string>();
  const exclusionsByKey = new Map<string, BranchProductEligibilityDecision>();
  let coverageComplete = true;
  for (const row of rows) {
    const id = branchId(row.repoFullName, row.branchName);
    const denominatorDecision = decideCandidate(row, authorities, overlays);
    if (
      denominatorDecision.outcome === BranchDefaultEligibilityOutcome.Included
    ) {
      denominatorEligibleBranchIds.add(id);
    }
    const decision = requirePublication
      ? decideProductCandidate(row, authorities, overlays)
      : denominatorDecision;
    if (decision.outcome === BranchDefaultEligibilityOutcome.Included) {
      eligibleBranchIds.add(id);
      denominatorEligibleBranchIds.add(id);
    } else {
      exclusionsByKey.set(id, decision);
      if (decision.cause === BranchDefaultExclusionCause.AuthorityUnavailable) {
        coverageComplete = false;
      }
    }
  }
  return {
    eligibleBranchIds,
    denominatorEligibleBranchIds,
    exclusionsByKey,
    authoritative: true,
    coverageComplete,
    pullRequestCoverageComplete:
      hasCompletePullRequestCoverage(resolvedEligibility),
    ...(resolvedEligibility.rowHydrationResult
      ? { resolvedHydration: resolvedEligibility.rowHydrationResult }
      : {}),
  };
}

function decideProductCandidate(
  row: BranchDefaultEligibilityCandidateRow,
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[],
  overlays: Record<string, BranchCloudHydrationOverlay> | undefined
): BranchProductEligibilityDecision {
  if (row.hasLocalPublication === true) {
    return decideCandidateRepositoryAuthority(row, authorities);
  }
  const overlay = overlays?.[`${row.repoFullName}::${row.branchName}`];
  if (!hasExactPullRequestHead(overlay)) {
    return publicationMissingDecision();
  }
  const headIdentity = resolveHeadIdentity(overlay);
  if (headIdentity === false || headIdentity === null) {
    return publicationMissingDecision();
  }
  return decideBranchDefaultEligibility(
    {
      provider: headIdentity.provider,
      providerRepositoryId: headIdentity.providerRepositoryId,
      repositoryFullName: headIdentity.fullName,
      branchName: row.branchName,
    },
    authorities
  );
}

function decideCandidate(
  row: BranchDefaultEligibilityCandidateRow,
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[],
  overlays: Record<string, BranchCloudHydrationOverlay> | undefined
): BranchDefaultEligibilityDecision {
  if (row.repoFullName === null) {
    return unavailableDecision(RepositoryDefaultReason.NotReported);
  }
  const overlay = overlays?.[`${row.repoFullName}::${row.branchName}`];
  if (overlay?.headRepositoryUnavailableReason) {
    return unavailableDecision(overlay.headRepositoryUnavailableReason);
  }
  const headIdentity = resolveHeadIdentity(overlay);
  if (headIdentity === false) {
    return unavailableDecision(RepositoryDefaultReason.Unknown);
  }
  return decideBranchDefaultEligibility(
    {
      provider: headIdentity?.provider ?? VcsProviderKind.GitHub,
      ...(headIdentity
        ? { providerRepositoryId: headIdentity.providerRepositoryId }
        : {}),
      repositoryFullName: headIdentity?.fullName ?? row.repoFullName,
      branchName: row.branchName,
    },
    authorities
  );
}

function decideCandidateRepositoryAuthority(
  row: BranchDefaultEligibilityCandidateRow,
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[]
): BranchDefaultEligibilityDecision {
  if (row.repoFullName === null) {
    return unavailableDecision(RepositoryDefaultReason.NotReported);
  }
  return decideBranchDefaultEligibility(
    {
      provider: VcsProviderKind.GitHub,
      repositoryFullName: row.repoFullName,
      branchName: row.branchName,
    },
    authorities
  );
}

function hasExactPullRequestHead(
  overlay: BranchCloudHydrationOverlay | undefined
): boolean {
  return (
    typeof overlay?.prNumber === "number" &&
    Number.isInteger(overlay.prNumber) &&
    overlay.prNumber > 0 &&
    overlay.headRepositoryUnavailableReason === undefined
  );
}

function resolveHeadIdentity(overlay: BranchCloudHydrationOverlay | undefined):
  | {
      provider: VcsProviderKind;
      providerRepositoryId: string;
      fullName: string;
    }
  | false
  | null {
  if (!overlay) {
    return null;
  }
  const values = [
    overlay.headRepositoryProvider,
    overlay.headRepositoryProviderId,
    overlay.headRepositoryFullName,
  ];
  if (values.every((value) => value === undefined)) {
    return null;
  }
  if (
    overlay.headRepositoryProvider === undefined ||
    overlay.headRepositoryProviderId === undefined ||
    overlay.headRepositoryFullName === undefined
  ) {
    return false;
  }
  return {
    provider: overlay.headRepositoryProvider,
    providerRepositoryId: overlay.headRepositoryProviderId,
    fullName: overlay.headRepositoryFullName,
  };
}

function uniqueCandidates(
  rows: readonly BranchDefaultEligibilityCandidateRow[]
): BranchDefaultEligibilityCandidateRow[] {
  const byId = new Map<string, BranchDefaultEligibilityCandidateRow>();
  for (const row of rows) {
    const id = branchId(row.repoFullName, row.branchName);
    const current = byId.get(id);
    if (!current) {
      byId.set(id, row);
    } else if (
      current.hasLocalPublication !== true &&
      row.hasLocalPublication === true
    ) {
      byId.set(id, { ...current, hasLocalPublication: true });
    }
  }
  return [...byId.values()].sort((left, right) =>
    branchId(left.repoFullName, left.branchName).localeCompare(
      branchId(right.repoFullName, right.branchName)
    )
  );
}

function branchId(repoFullName: string | null, branchName: string): string {
  return encodeBranchId({ repoFullName, branchName });
}

function unavailableDecision(
  reason: RepositoryDefaultReason
): BranchDefaultEligibilityDecision {
  return {
    outcome: BranchDefaultEligibilityOutcome.Excluded,
    cause: BranchDefaultExclusionCause.AuthorityUnavailable,
    reason,
  };
}

function publicationMissingDecision(): BranchProductEligibilityDecision {
  return {
    outcome: BranchDefaultEligibilityOutcome.Excluded,
    cause: BranchProductExclusionCause.PublicationMissing,
  };
}

function emptySnapshot(): BranchDefaultEligibilitySnapshot {
  return {
    eligibleBranchIds: new Set(),
    denominatorEligibleBranchIds: new Set(),
    exclusionsByKey: new Map(),
    // No candidates to decide about — an empty survivor set IS the whole truth.
    authoritative: true,
    coverageComplete: true,
    pullRequestCoverageComplete: true,
  };
}

function unavailableSnapshot(
  rows: readonly BranchDefaultEligibilityCandidateRow[],
  reason: RepositoryDefaultReason
): BranchDefaultEligibilitySnapshot {
  const exclusionsByKey = new Map<string, BranchProductEligibilityDecision>();
  for (const row of rows) {
    exclusionsByKey.set(
      branchId(row.repoFullName, row.branchName),
      unavailableDecision(reason)
    );
  }
  return {
    eligibleBranchIds: new Set(),
    denominatorEligibleBranchIds: new Set(),
    exclusionsByKey,
    authoritative: false,
    coverageComplete: false,
    pullRequestCoverageComplete: false,
  };
}

function hasCompletePullRequestCoverage(
  result: DesktopCloudGitHubHydrationResult
): boolean {
  return Object.keys(result.pullRequestIncompleteReasons ?? {}).length === 0;
}
