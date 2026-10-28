import { type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  type BranchMaterializationResult,
  BranchMaterializationStatus,
  materializeSessionBranchAggregate,
} from "./branch-links";
import {
  type BranchMaterializationRetryClaim,
  BranchMaterializationRetryState,
  claimDueBranchMaterializationRetries,
  isRetryableBranchMaterializationCause,
  parseBranchMaterializationRetryAggregate,
  rescheduleBranchMaterializationRetry,
  revalidateCurrentBranchMaterializationRetryClaim,
  settleSuccessfulBranchMaterializationRetry,
  settleTerminalBranchMaterializationRetry,
  terminalReasonFromBranchMaterializationCause,
} from "./branch-materialization-retry";
import {
  BranchMaterializationRetryEventOutcome,
  BranchMaterializationRetryTerminalReason,
  classifyBranchMaterializationRetryFailure,
  emitBranchMaterializationRetryEvent,
} from "./branch-materialization-retry-monitor";
import { BranchMaterializationRetryPolicy } from "./branch-materialization-retry-policy";
import { isPullRequestHeadAggregateMissingPrIdentity } from "./branch-ref-aggregate";
import { resolveRepositoryAuthorityByNames } from "./shared";

export const BranchMaterializationRetryDrainBudget = {
  RuntimeMs: 300_000,
  SafetyMarginMs: 30_000,
  // ISS-10332: 7 since a claim carrying a desktop priority seeds it after
  // materializing, one more round trip.
  WorstCaseDbRoundTripsPerClaim: 7,
  WorstCaseDbRoundTripMs: 1000,
} as const;

const WORST_CASE_CLAIM_MS =
  BranchMaterializationRetryDrainBudget.WorstCaseDbRoundTripsPerClaim *
  BranchMaterializationRetryDrainBudget.WorstCaseDbRoundTripMs;
const MAX_CLAIMS_PER_DRAIN = Math.max(
  1,
  Math.floor(
    (BranchMaterializationRetryDrainBudget.RuntimeMs -
      BranchMaterializationRetryDrainBudget.SafetyMarginMs) /
      WORST_CASE_CLAIM_MS
  )
);
const DEFAULT_DRAIN_LIMIT = MAX_CLAIMS_PER_DRAIN;
const MAX_CLAIMS_PER_ORG_PER_DRAIN = 5;

export type BranchMaterializationRetryDrainSummary = {
  claimed: number;
  settled: number;
  succeeded: number;
  rescheduled: number;
  terminal: number;
  deadLettered: number;
  stale: number;
  failed: number;
};

type BranchMaterializationRetryClaimEvaluation =
  | { status: "stale_claim" }
  | {
      status: "terminal";
      reason: BranchMaterializationRetryTerminalReason;
    }
  | {
      status: "evaluated";
      materialization: BranchMaterializationResult;
    };

/** Drain a bounded serial claim batch with no provider work inside the route. */
export async function drainBranchMaterializationRetries(
  now = new Date(),
  limit = DEFAULT_DRAIN_LIMIT,
  readNowMs: () => number = Date.now
): Promise<BranchMaterializationRetryDrainSummary> {
  const startedAtMs = readNowMs();
  const boundedLimit = Math.min(MAX_CLAIMS_PER_DRAIN, Math.max(1, limit));
  const summary = emptySummary();
  const claimCountsByOrg = new Map<string, number>();

  while (
    summary.claimed < boundedLimit &&
    hasTimeForNextClaim(startedAtMs, readNowMs())
  ) {
    let [claim] = await claimNextFairBranchRetry(now, claimCountsByOrg);
    if (!claim && claimCountsByOrg.size > 0) {
      claimCountsByOrg.clear();
      [claim] = await claimNextFairBranchRetry(now, claimCountsByOrg);
    }
    if (!claim) {
      break;
    }
    summary.claimed++;
    claimCountsByOrg.set(
      claim.organizationId,
      (claimCountsByOrg.get(claim.organizationId) ?? 0) + 1
    );
    try {
      await processClaim(claim, now, summary);
    } catch (error) {
      await recordUnexpectedFailure(claim, error, now, summary);
    }
  }

  return summary;
}

function claimNextFairBranchRetry(
  now: Date,
  claimCountsByOrg: Map<string, number>
): Promise<BranchMaterializationRetryClaim[]> {
  const excludedOrganizationIds = [...claimCountsByOrg]
    .filter(([, count]) => count >= MAX_CLAIMS_PER_ORG_PER_DRAIN)
    .map(([organizationId]) => organizationId);
  return withDb.tx((tx) =>
    claimDueBranchMaterializationRetries(tx, now, 1, {
      excludedOrganizationIds,
    })
  );
}

async function processClaim(
  claim: BranchMaterializationRetryClaim,
  now: Date,
  summary: BranchMaterializationRetryDrainSummary
): Promise<void> {
  if (claim.validationReason) {
    await settleTerminalClaim(claim, claim.validationReason, now, summary);
    return;
  }
  const evaluation = await withDb.tx((tx) =>
    evaluateCurrentBranchMaterializationRetryClaim(tx, claim)
  );
  if (evaluation.status === "stale_claim") {
    summary.stale++;
    return;
  }
  if (evaluation.status === "terminal") {
    await settleTerminalClaim(claim, evaluation.reason, now, summary);
    return;
  }

  const { materialization } = evaluation;
  if (materialization.status === BranchMaterializationStatus.Materialized) {
    await withDb.tx((tx) =>
      countSettlement(
        settleSuccessfulBranchMaterializationRetry(tx, claim),
        summary,
        "succeeded"
      )
    );
    return;
  }

  if (isRetryableBranchMaterializationCause(materialization.cause)) {
    await withDb.tx((tx) => settleRetryableClaimInTx(tx, claim, now, summary));
    return;
  }
  const terminalReason = terminalReasonFromBranchMaterializationCause(
    materialization.cause
  );
  await settleTerminalClaim(claim, terminalReason, now, summary);
}

async function evaluateCurrentBranchMaterializationRetryClaim(
  tx: TransactionClient,
  claim: BranchMaterializationRetryClaim
): Promise<BranchMaterializationRetryClaimEvaluation> {
  const writeGuard = await revalidateCurrentBranchMaterializationRetryClaim(
    tx,
    claim
  );
  if (writeGuard.status !== "current") {
    return writeGuard;
  }

  const aggregate = parseBranchMaterializationRetryAggregate(
    writeGuard.branchRef
  );
  if (
    !(
      aggregate &&
      aggregateMatchesClaimIdentity(aggregate, claim) &&
      !isPullRequestHeadAggregateMissingPrIdentity(aggregate)
    )
  ) {
    return {
      status: "terminal",
      reason: BranchMaterializationRetryTerminalReason.CorruptState,
    };
  }

  const authorityByFullName = await resolveRepositoryAuthorityByNames(
    tx,
    claim.organizationId,
    [aggregate.repositoryFullName]
  );
  const materialization = await materializeSessionBranchAggregate(tx, {
    organizationId: claim.organizationId,
    projectId: writeGuard.projectId,
    sessionArtifactId: claim.sourceArtifactId,
    aggregate,
    repositoryAuthority: authorityByFullName.get(aggregate.repositoryFullName),
  });
  return { status: "evaluated", materialization };
}

async function settleRetryableClaimInTx(
  tx: TransactionClient,
  claim: BranchMaterializationRetryClaim,
  now: Date,
  summary: BranchMaterializationRetryDrainSummary
): Promise<void> {
  const nextAttemptAt = nextRetryAt(claim, now);
  if (
    claim.attempts >= BranchMaterializationRetryPolicy.MaxAttempts ||
    nextAttemptAt === null
  ) {
    await settleDeadLetterClaimInTx(tx, claim, now, summary);
    return;
  }

  await countSettlement(
    rescheduleBranchMaterializationRetry(tx, claim, nextAttemptAt, now),
    summary,
    "rescheduled"
  );
}

function recordUnexpectedFailure(
  claim: BranchMaterializationRetryClaim,
  processingError: unknown,
  now: Date,
  summary: BranchMaterializationRetryDrainSummary
): Promise<void> {
  summary.failed++;
  log.error("[branch-materialization-retry] Claim processing failed", {
    organizationId: claim.organizationId,
    retryId: claim.id,
    sourceArtifactId: claim.sourceArtifactId,
    repositoryFullName: claim.repositoryFullName,
    branchName: claim.branchName,
    claimGeneration: claim.claimGeneration,
    failureCategory: classifyBranchMaterializationRetryFailure(processingError),
    recovery:
      claim.attempts >= BranchMaterializationRetryPolicy.MaxAttempts
        ? "dead_letter"
        : "claim_lease",
  });
  if (claim.attempts < BranchMaterializationRetryPolicy.MaxAttempts) {
    return Promise.resolve();
  }
  return withDb.tx((tx) => settleDeadLetterClaimInTx(tx, claim, now, summary));
}

async function settleTerminalClaim(
  claim: BranchMaterializationRetryClaim,
  reason: BranchMaterializationRetryTerminalReason,
  now: Date,
  summary: BranchMaterializationRetryDrainSummary
): Promise<void> {
  await withDb.tx((tx) =>
    settleTerminalClaimInTx(tx, claim, reason, now, summary)
  );
}

async function settleTerminalClaimInTx(
  tx: TransactionClient,
  claim: BranchMaterializationRetryClaim,
  reason: BranchMaterializationRetryTerminalReason,
  now: Date,
  summary: BranchMaterializationRetryDrainSummary
): Promise<void> {
  const result = await settleTerminalBranchMaterializationRetry(
    tx,
    claim,
    BranchMaterializationRetryState.Terminal,
    reason,
    now
  );
  if (result === "stale_claim") {
    summary.stale++;
    return;
  }

  summary.settled++;
  summary.terminal++;
  emitTerminalEvent(
    claim,
    BranchMaterializationRetryEventOutcome.Terminal,
    reason
  );
}

async function settleDeadLetterClaimInTx(
  tx: TransactionClient,
  claim: BranchMaterializationRetryClaim,
  now: Date,
  summary: BranchMaterializationRetryDrainSummary
): Promise<void> {
  const reason = BranchMaterializationRetryTerminalReason.AttemptsExhausted;
  const result = await settleTerminalBranchMaterializationRetry(
    tx,
    claim,
    BranchMaterializationRetryState.DeadLetter,
    reason,
    now
  );
  if (result === "stale_claim") {
    summary.stale++;
    return;
  }

  summary.settled++;
  summary.deadLettered++;
  emitTerminalEvent(
    claim,
    BranchMaterializationRetryEventOutcome.DeadLetter,
    reason
  );
}

async function countSettlement(
  resultPromise: Promise<"settled" | "stale_claim">,
  summary: BranchMaterializationRetryDrainSummary,
  counter: "succeeded" | "rescheduled"
): Promise<void> {
  const result = await resultPromise;
  if (result === "stale_claim") {
    summary.stale++;
    return;
  }
  summary.settled++;
  summary[counter]++;
}

function emitTerminalEvent(
  claim: BranchMaterializationRetryClaim,
  outcome: BranchMaterializationRetryEventOutcome,
  reason: BranchMaterializationRetryTerminalReason
): void {
  const emitted = emitBranchMaterializationRetryEvent({
    organizationId: claim.organizationId,
    retryId: claim.id,
    sourceArtifactId: claim.sourceArtifactId,
    repositoryFullName: claim.repositoryFullName,
    branchName: claim.branchName,
    outcome,
    attempts: claim.attempts,
    reason,
  });
  if (!emitted) {
    log.error(
      "[branch-materialization-retry] Rejected invalid terminal event",
      {
        organizationId: claim.organizationId,
        retryId: claim.id,
        sourceArtifactId: claim.sourceArtifactId,
        claimGeneration: claim.claimGeneration,
      }
    );
  }
}

/**
 * Null means the retry horizon is spent and the caller must dead-letter.
 *
 * `createdAt` is the horizon ANCHOR, not merely an audit stamp: it dates the
 * row's current scheduling lifetime, which is why an enqueue that revives a
 * terminal row restarts it alongside `attempts` (ISS-8229). Anchoring on a
 * stamp that moved every reschedule instead would make the horizon unreachable.
 */
function nextRetryAt(
  claim: BranchMaterializationRetryClaim,
  now: Date
): Date | null {
  const fallbackDelayMs = Math.min(
    BranchMaterializationRetryPolicy.MaxFallbackDelayMs,
    BranchMaterializationRetryPolicy.BaseDelayMs *
      2 ** Math.max(0, claim.attempts - 1)
  );
  const candidate = new Date(now.getTime() + fallbackDelayMs);
  const horizon =
    claim.createdAt.getTime() + BranchMaterializationRetryPolicy.MaxHorizonMs;
  return candidate.getTime() <= horizon ? candidate : null;
}

function aggregateMatchesClaimIdentity(
  aggregate: {
    repositoryFullName: string;
    branchName: string;
  },
  claim: BranchMaterializationRetryClaim
): boolean {
  return (
    aggregate.repositoryFullName === claim.repositoryFullName &&
    aggregate.branchName === claim.branchName
  );
}

function emptySummary(): BranchMaterializationRetryDrainSummary {
  return {
    claimed: 0,
    settled: 0,
    succeeded: 0,
    rescheduled: 0,
    terminal: 0,
    deadLettered: 0,
    stale: 0,
    failed: 0,
  };
}

function hasTimeForNextClaim(startedAtMs: number, currentMs: number): boolean {
  const usableRuntimeMs =
    BranchMaterializationRetryDrainBudget.RuntimeMs -
    BranchMaterializationRetryDrainBudget.SafetyMarginMs;
  return currentMs - startedAtMs + WORST_CASE_CLAIM_MS <= usableRuntimeMs;
}
