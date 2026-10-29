import { log } from "@repo/observability/log";
import { BranchMaterializationRetryReason } from "./branch-materialization-retry-policy";

/** Stable event name for the production monitor attached to this retry lane. */
export const BRANCH_MATERIALIZATION_RETRY_EVENT =
  "session_branch_materialization_retry";

/** Closed terminal reason vocabulary accepted by the monitor contract. */
export const BranchMaterializationRetryTerminalReason = {
  AttemptsExhausted: "attempts_exhausted",
  ConflictingAuthority: "conflicting_authority",
  CorruptState: "corrupt_state",
  CrossOrganization: "cross_organization",
  DefaultBranch: "default_branch",
  IdentityMismatch: "identity_mismatch",
  /** ISS-8148: the retry horizon elapsed and the branch was still never pushed. */
  NotPushed: "not_pushed",
  SourceMissing: "source_missing",
} as const;
export type BranchMaterializationRetryTerminalReason =
  (typeof BranchMaterializationRetryTerminalReason)[keyof typeof BranchMaterializationRetryTerminalReason];

/** Safe lifecycle projection emitted with retry monitor events. */
export const BranchMaterializationRetryEventOutcome = {
  Queued: "queued",
  Terminal: "terminal",
  DeadLetter: "dead_letter",
} as const;
export type BranchMaterializationRetryEventOutcome =
  (typeof BranchMaterializationRetryEventOutcome)[keyof typeof BranchMaterializationRetryEventOutcome];

export type BranchMaterializationRetryEvent = {
  organizationId: string;
  retryId: string;
  sourceArtifactId: string;
  repositoryFullName: string;
  branchName: string;
  outcome: BranchMaterializationRetryEventOutcome;
  attempts: number;
  reason:
    | BranchMaterializationRetryReason
    | BranchMaterializationRetryTerminalReason;
};

/** Emit the allowlisted monitor event without normalizing corrupt counters. */
export function emitBranchMaterializationRetryEvent(
  event: BranchMaterializationRetryEvent
): boolean {
  if (
    !(
      nonEmpty(event.organizationId) &&
      nonEmpty(event.retryId) &&
      nonEmpty(event.sourceArtifactId) &&
      nonEmpty(event.repositoryFullName) &&
      nonEmpty(event.branchName) &&
      validOutcome(event.outcome) &&
      validOutcomeReason(event.outcome, event.reason) &&
      Number.isSafeInteger(event.attempts)
    ) ||
    event.attempts < 0
  ) {
    return false;
  }

  const payload = {
    organizationId: event.organizationId,
    retryId: event.retryId,
    sourceArtifactId: event.sourceArtifactId,
    repositoryFullName: event.repositoryFullName,
    branchName: event.branchName,
    outcome: event.outcome,
    attempts: event.attempts,
    reason: event.reason,
  };
  if (event.outcome === BranchMaterializationRetryEventOutcome.Queued) {
    log.warn(BRANCH_MATERIALIZATION_RETRY_EVENT, payload);
    return true;
  }
  log.error(BRANCH_MATERIALIZATION_RETRY_EVENT, payload);
  return true;
}

/** Collapse arbitrary thrown values before they reach persistent telemetry. */
export function classifyBranchMaterializationRetryFailure(
  error: unknown
): "error" | "non_error" {
  return error instanceof Error ? "error" : "non_error";
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validOutcome(
  value: string
): value is BranchMaterializationRetryEventOutcome {
  return Object.values(BranchMaterializationRetryEventOutcome).includes(
    value as BranchMaterializationRetryEventOutcome
  );
}

function validOutcomeReason(
  outcome: BranchMaterializationRetryEventOutcome,
  reason:
    | BranchMaterializationRetryReason
    | BranchMaterializationRetryTerminalReason
): boolean {
  if (outcome === BranchMaterializationRetryEventOutcome.Queued) {
    return reason === BranchMaterializationRetryReason.AuthorityUnavailable;
  }
  return isBranchMaterializationRetryTerminalReason(reason);
}

/**
 * ISS-8229: what a terminal reason is ABOUT, which is what decides whether a
 * later payload for the same identity may revive the row.
 *
 * `Condition` names a state of the world outside the retry row — which branch a
 * repository calls default, whether two authorities disagree, whether a push has
 * been observed. Every one of those can stop being true, so pinning the row
 * terminal converts a transient deferral into a permanent drop: the identity is
 * refused by `buildBranchRetryBulkWriteRow` on every subsequent sync and its
 * Branch artifact can never be created.
 *
 * `Identity` names the row, its source artifact, or the caller-supplied
 * identity itself. Replaying the same identity re-derives the same answer, so
 * reviving one would reopen exactly the churn the terminal state exists to stop.
 */
export const BranchMaterializationRetryTerminalClass = {
  Condition: "condition",
  Identity: "identity",
} as const;
export type BranchMaterializationRetryTerminalClass =
  (typeof BranchMaterializationRetryTerminalClass)[keyof typeof BranchMaterializationRetryTerminalClass];

/**
 * Exhaustive by construction: a new terminal reason fails `tsc` here until it is
 * deliberately classified, rather than defaulting into either behaviour.
 */
const BRANCH_TERMINAL_REASON_CLASS: Record<
  BranchMaterializationRetryTerminalReason,
  BranchMaterializationRetryTerminalClass
> = {
  // The retry horizon elapsed. Already revivable before ISS-8229.
  [BranchMaterializationRetryTerminalReason.AttemptsExhausted]:
    BranchMaterializationRetryTerminalClass.Condition,
  // Two authorities disagreed on the provider repository id, or one observation
  // claimed both an authority and unavailability. Reconciles.
  [BranchMaterializationRetryTerminalReason.ConflictingAuthority]:
    BranchMaterializationRetryTerminalClass.Condition,
  // The stored row is not the shape this lane can act on.
  [BranchMaterializationRetryTerminalReason.CorruptState]:
    BranchMaterializationRetryTerminalClass.Identity,
  // The source artifact belongs to another organization. A tenancy boundary is
  // never re-evaluated into permission.
  [BranchMaterializationRetryTerminalReason.CrossOrganization]:
    BranchMaterializationRetryTerminalClass.Identity,
  // The branch was the repository's default AT THAT MOMENT. Defaults move.
  [BranchMaterializationRetryTerminalReason.DefaultBranch]:
    BranchMaterializationRetryTerminalClass.Condition,
  // The caller-supplied repository identity did not resolve or did not agree
  // with itself. Replaying it resolves the same way.
  [BranchMaterializationRetryTerminalReason.IdentityMismatch]:
    BranchMaterializationRetryTerminalClass.Identity,
  // No evidence yet proved the branch reached the remote. A later push does.
  //
  // CLASSIFICATION ONLY — no row currently carries this reason, so nothing reads
  // this entry (whitlockk, #6140). What stops it is the DRAIN's ordering: it tests
  // `isRetryableBranchMaterializationCause` BEFORE terminal mapping and that
  // predicate accepts `NotPushed` (ISS-8148), so the reason never reaches a
  // settle call; and a horizon-expired or attempt-expired retry is persisted as
  // `attempts_exhausted` by `settleDeadLetterClaimInTx`, not as its own reason.
  //
  // ISS-8284 removed the third fact this comment used to cite. The storage
  // vocabulary NO LONGER omits `not_pushed`: migration
  // 20260917153000_iss8284_branch_materialization_retry_reason_not_pushed added
  // it, because `terminalReasonFromBranchMaterializationCause()` can return this
  // member and only an early return in a different file kept it away from a
  // column that would have refused it. The database is now a superset of this
  // vocabulary, so a future persistence path cannot be refused by storage — but
  // that widening did not itself create one, and this entry stays the
  // classification the value would take on the day one is added.
  [BranchMaterializationRetryTerminalReason.NotPushed]:
    BranchMaterializationRetryTerminalClass.Condition,
  // The source session artifact is gone. The enqueue's own eligibility join
  // already refuses these, so revival could not write anything either.
  [BranchMaterializationRetryTerminalReason.SourceMissing]:
    BranchMaterializationRetryTerminalClass.Identity,
};

export function isBranchMaterializationRetryTerminalReason(
  value: unknown
): value is BranchMaterializationRetryTerminalReason {
  return (
    typeof value === "string" &&
    Object.values(BranchMaterializationRetryTerminalReason).includes(
      value as BranchMaterializationRetryTerminalReason
    )
  );
}

/**
 * Whether a persisted terminal `reason` column may be revived by a fresh
 * enqueue. Membership is checked before the lookup so an unrecognized column
 * value can never index the classification table.
 */
export function isRevivableBranchMaterializationTerminalReason(
  reason: unknown
): boolean {
  return (
    isBranchMaterializationRetryTerminalReason(reason) &&
    BRANCH_TERMINAL_REASON_CLASS[reason] ===
      BranchMaterializationRetryTerminalClass.Condition
  );
}
