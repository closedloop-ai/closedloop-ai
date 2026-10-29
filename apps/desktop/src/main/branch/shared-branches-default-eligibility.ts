import {
  BranchCloudHydrationStatus,
  decodeBranchId,
  encodeBranchId,
} from "@repo/api/src/types/branch";
import { RepositoryDefaultReason } from "@repo/api/src/types/repository-default-identity";
import {
  type BranchDefaultEligibilityDiagnostic,
  BranchDefaultEligibilityUnavailableError,
  createBranchDefaultEligibilityDiagnostic,
} from "./branch-default-eligibility-diagnostic.js";

export type BranchDefaultEligibilityCandidateRow = {
  repoFullName: string | null;
  branchName: string;
  hasLocalPublication?: boolean;
};

/**
 * One immutable eligibility result reused across a complete product read.
 *
 * Desktop holds no repository-default authority, so a non-empty snapshot is
 * never authoritative: every candidate that passes the local publication gate
 * is admitted, default branches included, and each cohort report discloses the
 * missing enrichment through `authoritative` and `coverageComplete` (ISS-10864).
 */
export type BranchDefaultEligibilitySnapshot = {
  eligibleBranchIds: ReadonlySet<string>;
  denominatorEligibleBranchIds: ReadonlySet<string>;
  authoritative: boolean;
  coverageComplete: boolean;
  pullRequestCoverageComplete: boolean;
  /** Main-process-only context for the cohort read that rejects this snapshot. */
  diagnostic?: BranchDefaultEligibilityDiagnostic;
};

/** Resolve Product membership, which requires local publication (ISS-8148). */
export function resolveBranchProductEligibilitySnapshot(
  rows: readonly BranchDefaultEligibilityCandidateRow[]
): BranchDefaultEligibilitySnapshot {
  const candidates = uniqueCandidates(rows);
  if (candidates.length === 0) {
    return {
      eligibleBranchIds: new Set(),
      denominatorEligibleBranchIds: new Set(),
      authoritative: true,
      coverageComplete: true,
      pullRequestCoverageComplete: true,
    };
  }
  const eligibleBranchIds = new Set<string>();
  for (const row of candidates) {
    if (row.hasLocalPublication === true) {
      eligibleBranchIds.add(branchId(row.repoFullName, row.branchName));
    }
  }
  return {
    eligibleBranchIds,
    denominatorEligibleBranchIds: new Set(eligibleBranchIds),
    authoritative: false,
    coverageComplete: false,
    pullRequestCoverageComplete: false,
    diagnostic: NO_AUTHORITY_DIAGNOSTIC,
  };
}

/** Filter keyed evidence with the exact snapshot resolved for its operation. */
export function filterEligibleBranchRows<
  Row extends BranchDefaultEligibilityCandidateRow,
>(rows: readonly Row[], snapshot: BranchDefaultEligibilitySnapshot): Row[] {
  return rows.filter((row) =>
    snapshot.eligibleBranchIds.has(branchId(row.repoFullName, row.branchName))
  );
}

/**
 * Assert the read can carry a COHORT NUMBER, which is strictly more than the
 * list needs. `getSharedBranchUsage` is the one caller, and it publishes
 * concrete token and cost totals over the survivors, so the same cohort the KPI
 * band reports as Unavailable must not arrive somewhere else as a measured
 * total (whitlockk review).
 */
export function assertBranchDefaultEligibilityCoverageComplete(
  snapshot: BranchDefaultEligibilitySnapshot
): void {
  if (!snapshot.coverageComplete) {
    throw new BranchDefaultEligibilityUnavailableError(
      snapshot.diagnostic ?? NO_AUTHORITY_DIAGNOSTIC
    );
  }
}

/** Whether every candidate selected into one requested cohort was decided. */
export function isEligibilityCoverageCompleteForCohort(
  snapshot: BranchDefaultEligibilitySnapshot
): boolean {
  return snapshot.authoritative && snapshot.coverageComplete;
}

/** Return each eligible repository/branch key once in deterministic order. */
export function eligibleBranchKeys(
  rows: readonly BranchDefaultEligibilityCandidateRow[],
  snapshot: BranchDefaultEligibilitySnapshot
): BranchDefaultEligibilityCandidateRow[] {
  return uniqueCandidates(filterEligibleBranchRows(rows, snapshot));
}

/** Return the publication-gated divisor keys (ISS-8148: same gate as Product). */
export function denominatorEligibleBranchKeys(
  snapshot: BranchDefaultEligibilitySnapshot
): BranchDefaultEligibilityCandidateRow[] {
  return [...snapshot.denominatorEligibleBranchIds]
    .sort()
    .map((id) => decodeBranchId(id));
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

const NO_AUTHORITY_DIAGNOSTIC = createBranchDefaultEligibilityDiagnostic({
  status: BranchCloudHydrationStatus.NotConnected,
  reasons: [RepositoryDefaultReason.Unknown],
});
