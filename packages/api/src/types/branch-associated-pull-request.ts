import { z } from "zod";
import type { ReviewDecision } from "./branch-checks.js";
import { normalizeRepoFullName } from "./branch-repository.ts";
import { GitHubPRState } from "./github-status.js";

const REPOSITORY_FULL_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/;

const selectedPullRequestRepositoryFullNameSchema = z
  .string()
  .transform(normalizeRepoFullName)
  .pipe(z.string().regex(REPOSITORY_FULL_NAME_PATTERN));
const selectedPullRequestNumberSchema = z.coerce.number().int().positive();

/**
 * Optional repository-qualified PR selection used by Branch detail/comments.
 * Omission preserves legacy default selection; a caller may never send half an
 * identity and absent values remain omitted on the wire.
 */
export const branchSelectedPullRequestQuerySchema = z
  .object({
    repositoryFullName: selectedPullRequestRepositoryFullNameSchema.optional(),
    pullRequestNumber: selectedPullRequestNumberSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.repositoryFullName === undefined) !==
      (value.pullRequestNumber === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "repositoryFullName and pullRequestNumber must be provided together",
      });
    }
  });
export type BranchSelectedPullRequestQuery = z.infer<
  typeof branchSelectedPullRequestQuerySchema
>;

/** Canonical repository-qualified identity after boundary validation. */
export type BranchSelectedPullRequestIdentity = {
  repositoryFullName: string;
  pullRequestNumber: number;
};

/** The persisted surface that supplied an associated pull-request collection. */
export const BranchAssociatedPullRequestProvenance = {
  PersistedCloud: "persisted_cloud",
  PersistedDesktop: "persisted_desktop",
} as const;
export type BranchAssociatedPullRequestProvenance =
  (typeof BranchAssociatedPullRequestProvenance)[keyof typeof BranchAssociatedPullRequestProvenance];

/** Truthfulness state for the all-known associated pull-request collection. */
export const BranchAssociatedPullRequestCompletenessState = {
  Complete: "complete",
  Incomplete: "incomplete",
  Unavailable: "unavailable",
} as const;
export type BranchAssociatedPullRequestCompletenessState =
  (typeof BranchAssociatedPullRequestCompletenessState)[keyof typeof BranchAssociatedPullRequestCompletenessState];

/** Closed reasons explaining why persisted associated-PR evidence is not complete. */
export const BranchAssociatedPullRequestCompletenessReason = {
  ConflictingDuplicate: "conflicting_duplicate",
  InvalidIdentity: "invalid_identity",
  InvalidLifecycle: "invalid_lifecycle",
  InvalidTimestamp: "invalid_timestamp",
  MissingTerminalTimestamp: "missing_terminal_timestamp",
  MultipleActive: "multiple_active",
} as const;
export type BranchAssociatedPullRequestCompletenessReason =
  (typeof BranchAssociatedPullRequestCompletenessReason)[keyof typeof BranchAssociatedPullRequestCompletenessReason];

/** Why the contract did or did not choose a default pull request. */
export const BranchAssociatedPullRequestSelectionReason = {
  Active: "active",
  Ambiguous: "ambiguous",
  Explicit: "explicit",
  MostRecentTerminal: "most_recent_terminal",
  None: "none",
} as const;
export type BranchAssociatedPullRequestSelectionReason =
  (typeof BranchAssociatedPullRequestSelectionReason)[keyof typeof BranchAssociatedPullRequestSelectionReason];

/** One canonical repository-qualified pull request associated with a Branch. */
export type BranchAssociatedPullRequest = {
  id: string;
  repositoryFullName: string;
  number: number;
  title: string | null;
  url: string | null;
  state: GitHubPRState;
  isDraft: boolean | null;
  reviewDecision: ReviewDecision | null;
  openedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
};

/** Additive all-known PR collection and deterministic default selection. */
export type BranchAssociatedPullRequestCollection = {
  items: readonly BranchAssociatedPullRequest[];
  selectedId: string | null;
  selectionReason: BranchAssociatedPullRequestSelectionReason;
  completeness: {
    state: BranchAssociatedPullRequestCompletenessState;
    reasons: readonly BranchAssociatedPullRequestCompletenessReason[];
    provenance: BranchAssociatedPullRequestProvenance;
  };
};

/** Persisted candidate shape accepted by the shared cloud/Desktop selector. */
export type BranchAssociatedPullRequestCandidate = {
  repositoryFullName: string | null;
  number: number | null;
  title: string | null;
  url: string | null;
  state: GitHubPRState | null;
  isDraft: boolean | null;
  reviewDecision: ReviewDecision | null;
  openedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  observedAt: string | null;
};

/** Shared selector output retains the original selected candidate for legacy projections. */
export type BranchAssociatedPullRequestSelection<
  Candidate extends BranchAssociatedPullRequestCandidate,
> = {
  collection: BranchAssociatedPullRequestCollection;
  selected: Candidate | null;
};

/**
 * Build the all-known associated-PR contract without consulting mutable current
 * pointers or cross-PR ingestion order. Observation time is used only to fold
 * repeated snapshots of the same canonical PR, including reopen cycles.
 */
export function selectBranchAssociatedPullRequests<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  candidates: readonly Candidate[],
  provenance: BranchAssociatedPullRequestProvenance
): BranchAssociatedPullRequestSelection<Candidate> {
  const reasons = new Set<BranchAssociatedPullRequestCompletenessReason>();
  const candidatesById = new Map<string, NormalizedCandidate<Candidate>[]>();

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate, reasons);
    if (!normalized) {
      continue;
    }
    const duplicates = candidatesById.get(normalized.item.id) ?? [];
    duplicates.push(normalized);
    candidatesById.set(normalized.item.id, duplicates);
  }

  const normalizedCandidates: NormalizedCandidate<Candidate>[] = [];
  for (const duplicates of candidatesById.values()) {
    const resolved = resolveDuplicateSnapshots(duplicates, reasons);
    if (resolved) {
      normalizedCandidates.push(resolved);
    }
  }
  normalizedCandidates.sort(compareCanonicalPullRequests);

  const active = normalizedCandidates.filter(
    ({ item }) => item.state === GitHubPRState.Open
  );
  if (active.length > 1) {
    reasons.add(BranchAssociatedPullRequestCompletenessReason.MultipleActive);
  }

  const selected = selectCandidate(normalizedCandidates, active, reasons);
  const selectedId = selected?.item.id ?? null;
  const completenessState = completenessFor(
    candidates,
    normalizedCandidates,
    reasons
  );
  return {
    collection: {
      items: normalizedCandidates.map(({ item }) => item),
      selectedId,
      selectionReason: selectionReasonFor(
        candidates,
        selected,
        active,
        reasons
      ),
      completeness: {
        state: completenessState,
        reasons: [...reasons].sort(),
        provenance,
      },
    },
    selected: selected?.candidate ?? null,
  };
}

type NormalizedCandidate<
  Candidate extends BranchAssociatedPullRequestCandidate,
> = {
  candidate: Candidate;
  item: BranchAssociatedPullRequest;
  observedEpoch: number | null;
  terminalEpoch: number | null;
};

function normalizeCandidate<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  candidate: Candidate,
  reasons: Set<BranchAssociatedPullRequestCompletenessReason>
): NormalizedCandidate<Candidate> | null {
  const repositoryFullName = normalizedRepositoryIdentity(
    candidate.repositoryFullName
  );
  if (!(repositoryFullName && isValidPullRequestNumber(candidate.number))) {
    reasons.add(BranchAssociatedPullRequestCompletenessReason.InvalidIdentity);
    return null;
  }

  const lifecycle = normalizedLifecycle(candidate);
  if (!lifecycle) {
    reasons.add(BranchAssociatedPullRequestCompletenessReason.InvalidLifecycle);
    return null;
  }
  if (hasInvalidTimestamp(candidate)) {
    reasons.add(BranchAssociatedPullRequestCompletenessReason.InvalidTimestamp);
  }
  const terminalEpoch = terminalEpochFor(candidate, lifecycle);
  if (lifecycle !== GitHubPRState.Open && terminalEpoch === null) {
    reasons.add(
      BranchAssociatedPullRequestCompletenessReason.MissingTerminalTimestamp
    );
  }

  const id = `${repositoryFullName}#${candidate.number}`;
  return {
    candidate,
    item: {
      id,
      repositoryFullName,
      number: candidate.number,
      title: candidate.title,
      url: candidate.url,
      state: lifecycle,
      isDraft: candidate.isDraft,
      reviewDecision: candidate.reviewDecision,
      openedAt: validIso(candidate.openedAt),
      closedAt: validIso(candidate.closedAt),
      mergedAt: validIso(candidate.mergedAt),
    },
    observedEpoch: isoEpoch(candidate.observedAt),
    terminalEpoch,
  };
}

function resolveDuplicateSnapshots<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  duplicates: readonly NormalizedCandidate<Candidate>[],
  reasons: Set<BranchAssociatedPullRequestCompletenessReason>
): NormalizedCandidate<Candidate> | null {
  if (duplicates.length === 1) {
    return duplicates[0] ?? null;
  }
  const ordered = [...duplicates].sort(compareSnapshotRecency);
  const newest = ordered[0];
  if (!newest) {
    return null;
  }
  const hasUnrankableConflict = ordered.slice(1).some((snapshot) => {
    const observationsCannotOrder =
      newest.observedEpoch === null || snapshot.observedEpoch === null;
    const observationsAreTied = newest.observedEpoch === snapshot.observedEpoch;
    return (
      (observationsCannotOrder || observationsAreTied) &&
      !equivalentLifecycleSnapshot(newest.item, snapshot.item)
    );
  });
  if (hasUnrankableConflict) {
    reasons.add(
      BranchAssociatedPullRequestCompletenessReason.ConflictingDuplicate
    );
    return null;
  }
  return mergeCompatibleSnapshots(ordered);
}

function selectCandidate<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  candidates: readonly NormalizedCandidate<Candidate>[],
  active: readonly NormalizedCandidate<Candidate>[],
  reasons: ReadonlySet<BranchAssociatedPullRequestCompletenessReason>
): NormalizedCandidate<Candidate> | null {
  if (active.length === 1 && !hasSelectionBlockingEvidence(reasons)) {
    return active[0] ?? null;
  }
  if (active.length > 0 || hasSelectionBlockingEvidence(reasons)) {
    return null;
  }
  if (
    reasons.has(
      BranchAssociatedPullRequestCompletenessReason.MissingTerminalTimestamp
    )
  ) {
    return null;
  }
  const terminal = candidates
    .filter(({ terminalEpoch }) => terminalEpoch !== null)
    .sort(compareTerminalSelection);
  return terminal[0] ?? null;
}

function selectionReasonFor<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  candidates: readonly Candidate[],
  selected: NormalizedCandidate<Candidate> | null,
  active: readonly NormalizedCandidate<Candidate>[],
  reasons: ReadonlySet<BranchAssociatedPullRequestCompletenessReason>
): BranchAssociatedPullRequestSelectionReason {
  if (selected?.item.state === GitHubPRState.Open) {
    return BranchAssociatedPullRequestSelectionReason.Active;
  }
  if (selected) {
    return BranchAssociatedPullRequestSelectionReason.MostRecentTerminal;
  }
  if (candidates.length === 0 && reasons.size === 0) {
    return BranchAssociatedPullRequestSelectionReason.None;
  }
  if (active.length > 1 || reasons.size > 0) {
    return BranchAssociatedPullRequestSelectionReason.Ambiguous;
  }
  return BranchAssociatedPullRequestSelectionReason.None;
}

function completenessFor<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  candidates: readonly Candidate[],
  normalized: readonly NormalizedCandidate<Candidate>[],
  reasons: ReadonlySet<BranchAssociatedPullRequestCompletenessReason>
): BranchAssociatedPullRequestCompletenessState {
  if (reasons.size === 0) {
    return BranchAssociatedPullRequestCompletenessState.Complete;
  }
  if (candidates.length > 0 && normalized.length === 0) {
    return BranchAssociatedPullRequestCompletenessState.Unavailable;
  }
  return BranchAssociatedPullRequestCompletenessState.Incomplete;
}

function normalizedRepositoryIdentity(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = normalizeRepoFullName(value);
  const segments = normalized.split("/");
  return segments.length === 2 && segments.every(Boolean) ? normalized : null;
}

function normalizedLifecycle(
  candidate: BranchAssociatedPullRequestCandidate
): GitHubPRState | null {
  if (candidate.isDraft === true && candidate.state !== GitHubPRState.Open) {
    return null;
  }
  if (candidate.isDraft === true && validIso(candidate.mergedAt)) {
    return null;
  }
  if (validIso(candidate.mergedAt)) {
    return GitHubPRState.Merged;
  }
  if (
    !Object.values(GitHubPRState).includes(candidate.state as GitHubPRState)
  ) {
    return null;
  }
  return candidate.state;
}

function terminalEpochFor(
  candidate: BranchAssociatedPullRequestCandidate,
  lifecycle: GitHubPRState
): number | null {
  if (lifecycle === GitHubPRState.Merged) {
    return isoEpoch(candidate.mergedAt);
  }
  if (lifecycle === GitHubPRState.Closed) {
    return isoEpoch(candidate.closedAt);
  }
  return null;
}

function compareCanonicalPullRequests<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  left: NormalizedCandidate<Candidate>,
  right: NormalizedCandidate<Candidate>
): number {
  return (
    compareCodeUnits(
      left.item.repositoryFullName,
      right.item.repositoryFullName
    ) || left.item.number - right.item.number
  );
}

function compareTerminalSelection<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  left: NormalizedCandidate<Candidate>,
  right: NormalizedCandidate<Candidate>
): number {
  return (
    (right.terminalEpoch ?? Number.NEGATIVE_INFINITY) -
      (left.terminalEpoch ?? Number.NEGATIVE_INFINITY) ||
    compareCanonicalPullRequests(left, right)
  );
}

function compareSnapshotRecency<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  left: NormalizedCandidate<Candidate>,
  right: NormalizedCandidate<Candidate>
): number {
  return (
    (right.observedEpoch ?? Number.NEGATIVE_INFINITY) -
      (left.observedEpoch ?? Number.NEGATIVE_INFINITY) ||
    compareCodeUnits(JSON.stringify(left.item), JSON.stringify(right.item))
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function hasSelectionBlockingEvidence(
  reasons: ReadonlySet<BranchAssociatedPullRequestCompletenessReason>
): boolean {
  return [
    BranchAssociatedPullRequestCompletenessReason.ConflictingDuplicate,
    BranchAssociatedPullRequestCompletenessReason.InvalidIdentity,
    BranchAssociatedPullRequestCompletenessReason.InvalidLifecycle,
    BranchAssociatedPullRequestCompletenessReason.MultipleActive,
  ].some((reason) => reasons.has(reason));
}

function validIso(value: string | null): string | null {
  return isoEpoch(value) === null ? null : value;
}

function isoEpoch(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) {
    return null;
  }
  return new Date(epoch).toISOString() === value ? epoch : null;
}

function isValidPullRequestNumber(value: number | null): value is number {
  return Number.isInteger(value) && (value ?? 0) > 0;
}

function hasInvalidTimestamp(
  candidate: BranchAssociatedPullRequestCandidate
): boolean {
  return [
    candidate.openedAt,
    candidate.closedAt,
    candidate.mergedAt,
    candidate.observedAt,
  ].some((value) => value !== null && isoEpoch(value) === null);
}

function equivalentLifecycleSnapshot(
  left: BranchAssociatedPullRequest,
  right: BranchAssociatedPullRequest
): boolean {
  return (
    left.state === right.state &&
    left.isDraft === right.isDraft &&
    left.openedAt === right.openedAt &&
    left.closedAt === right.closedAt &&
    left.mergedAt === right.mergedAt
  );
}

function mergeCompatibleSnapshots<
  Candidate extends BranchAssociatedPullRequestCandidate,
>(
  ordered: readonly NormalizedCandidate<Candidate>[]
): NormalizedCandidate<Candidate> {
  const newest = ordered[0];
  if (!newest) {
    throw new Error("Cannot merge an empty pull-request snapshot set");
  }
  const title = firstPresent(ordered, ({ item }) => item.title);
  const url = firstPresent(ordered, ({ item }) => item.url);
  const reviewDecision = firstPresent(
    ordered,
    ({ item }) => item.reviewDecision
  );
  return {
    ...newest,
    candidate: { ...newest.candidate, title, url, reviewDecision },
    item: {
      ...newest.item,
      title,
      url,
      reviewDecision,
    },
  };
}

function firstPresent<Value, Candidate>(
  values: readonly Candidate[],
  select: (candidate: Candidate) => Value | null
): Value | null {
  for (const value of values) {
    const selected = select(value);
    if (selected !== null) {
      return selected;
    }
  }
  return null;
}
