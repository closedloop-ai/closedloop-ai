/** Persisted publication lane that can contribute verified gross LOC. */
export const BranchPublicationLocSource = {
  SuccessfulPush: "successful_push",
  MergedPullRequest: "merged_pull_request",
} as const;
export type BranchPublicationLocSource =
  (typeof BranchPublicationLocSource)[keyof typeof BranchPublicationLocSource];

/** One producer-normalized publication LOC observation. */
export type BranchMetricLocContribution = {
  sourceEventId: string;
  /** Stable code-change identity shared by overlapping push and PR evidence. */
  changeIdentity?: string;
  branchId: string;
  occurredAt: string | null;
  additions: number | null;
  deletions: number | null;
  source?: BranchPublicationLocSource;
};

/** Publication evidence omitted from LOC, scoped by its authoritative time. */
export type BranchMetricLocCoverageGap = {
  sourceEventId: string;
  occurredAt: string | null;
  /**
   * Exclusive end of a shortfall that spans an INTERVAL rather than an instant,
   * so every window overlapping `[occurredAt, affectsUntil)` is disclosed and
   * not just the one containing `occurredAt`. Omitted by every instant-shaped
   * gap, including all of desktop's, which keep their existing meaning.
   */
  affectsUntil?: string | null;
};

export type ReconciledBranchPublicationLoc = {
  values: ReconciledBranchPublicationLocContribution[];
  conflicted: boolean;
  malformed: boolean;
};

export type ReconciledBranchPublicationLocContribution = {
  changeIdentity: string;
  branchId: string;
  occurredAt: string | null;
  additions: number;
  deletions: number;
};

/**
 * Deduplicate overlapping publication observations by code-change identity.
 * Matching push/PR facts share one LOC value and use their earliest trustworthy
 * publication time; conflicting LOC or Branch identity removes that change.
 */
export function reconcileBranchPublicationLoc(
  contributions: readonly BranchMetricLocContribution[]
): ReconciledBranchPublicationLoc {
  const byChange = new Map<
    string,
    ReconciledBranchPublicationLocContribution
  >();
  const conflictedChanges = new Set<string>();
  let conflicted = false;
  let malformed = false;

  for (const contribution of contributions) {
    const normalized = normalizeContribution(contribution);
    if (!normalized) {
      malformed = true;
      continue;
    }
    if (conflictedChanges.has(normalized.changeIdentity)) {
      continue;
    }
    const existing = byChange.get(normalized.changeIdentity);
    if (!existing) {
      byChange.set(normalized.changeIdentity, normalized);
      continue;
    }
    if (!sameChange(existing, normalized)) {
      conflicted = true;
      conflictedChanges.add(normalized.changeIdentity);
      byChange.delete(normalized.changeIdentity);
      continue;
    }
    const occurrence = earliestOccurrence(
      existing.occurredAt,
      normalized.occurredAt
    );
    if (occurrence.malformed) {
      malformed = true;
    }
    existing.occurredAt = occurrence.value;
  }

  return {
    values: [...byChange.values()].sort((left, right) =>
      left.changeIdentity.localeCompare(right.changeIdentity)
    ),
    conflicted,
    malformed,
  };
}

/** Sum complete reconciled additions and deletions without per-Branch pairing. */
export function sumBranchPublicationLoc(
  values: readonly ReconciledBranchPublicationLocContribution[]
): number {
  let total = 0;
  for (const value of values) {
    total += value.additions + value.deletions;
  }
  return total;
}

function normalizeContribution(
  contribution: BranchMetricLocContribution
): ReconciledBranchPublicationLocContribution | null {
  if (
    contribution.sourceEventId.trim().length === 0 ||
    contribution.branchId.trim().length === 0 ||
    !isValidNonnegative(contribution.additions) ||
    !isValidNonnegative(contribution.deletions)
  ) {
    return null;
  }
  return {
    changeIdentity: branchPublicationChangeIdentity(contribution),
    branchId: contribution.branchId,
    occurredAt: contribution.occurredAt,
    additions: contribution.additions,
    deletions: contribution.deletions,
  };
}

function sameChange(
  left: ReconciledBranchPublicationLocContribution,
  right: ReconciledBranchPublicationLocContribution
): boolean {
  return (
    left.branchId === right.branchId &&
    left.additions === right.additions &&
    left.deletions === right.deletions
  );
}

function earliestOccurrence(
  left: string | null,
  right: string | null
): { value: string | null; malformed: boolean } {
  const leftMs = parseTimestamp(left);
  const rightMs = parseTimestamp(right);
  if (leftMs === null && rightMs === null) {
    return { value: null, malformed: left !== null || right !== null };
  }
  if (leftMs === null) {
    return { value: right, malformed: left !== null };
  }
  if (rightMs === null) {
    return { value: left, malformed: right !== null };
  }
  return leftMs <= rightMs
    ? { value: left, malformed: false }
    : { value: right, malformed: false };
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isValidNonnegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/**
 * The code-change identity a contribution reconciles under.
 *
 * Exported because the push arm has to group by the SAME identity reconciliation
 * uses.
 *
 * That used to rest on a push and a merged-PR observation of one commit SHARING
 * this identity. Since ISS-10009 part 2 the cloud producer gives a captured push
 * a RANGE identity (`repo:before..after`) and drops the merged-PR row whose head
 * sha a push already names, so the two no longer meet here — the commit is still
 * counted once, upstream rather than in reconciliation.
 */
export function branchPublicationChangeIdentity(
  contribution: BranchMetricLocContribution
): string {
  return (
    contribution.changeIdentity?.trim() ||
    `${contribution.branchId}:${contribution.sourceEventId}`
  );
}

/**
 * Whether reconciliation can place this observation at all.
 *
 * Exported so a caller that groups evidence by lane asks the SAME question
 * {@link reconcileBranchPublicationLoc} asks — a second spelling of "valid"
 * would let a row count as evidence in one place and be dropped in the other.
 */
export function branchPublicationLocIsWellFormed(
  contribution: BranchMetricLocContribution
): boolean {
  return normalizeContribution(contribution) !== null;
}
