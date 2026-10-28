/**
 * ISS-8619 (PRD-699 §7.6): the ingest slice's GATING phase — every decision that
 * runs BEFORE a column is written, split out of `upsert-session-slice.ts`.
 *
 * Two entry points, deliberately not one, because they sit on opposite sides of
 * the identity phase and that ORDER is load-bearing:
 *
 *   • {@link resolveRevisionAdmission} is payload-only — no DB read, no lock —
 *     so the caller runs it FIRST, keeping a held row's deliberate `ack_omitted`
 *     retries a genuine no-op instead of re-acquiring locks that serialize real
 *     writers (ISS-8271, davetho #6120).
 *   • {@link resolveSessionSliceGate} needs the stored row, so it runs after
 *     `resolveSessionSliceIdentity`.
 *
 * Both return a discriminated union whose no-write arm IS the slice result, so a
 * refusal cannot be discarded by a caller that forgot to check it: there is no
 * shape to read the admitted fields out of until the refusal has been narrowed
 * away.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { isBelowPgTimestampFloor } from "@repo/api/src/types/pg-timestamp-floor";
import {
  isRecognizedSessionStatus,
  LEGACY_WAITING_WIRE_STATUS,
  normalizeSessionStatus,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import {
  SessionTimestampField,
  SessionTimestampOutOfRangeError,
} from "@/lib/desktop-agent-sessions-errors";
import type { resolveChunkGating } from "./chunk-revision-gating";
import {
  resolveGuardedStatus,
  resolveSessionFreshnessGates,
} from "./field-regression-guards";
import { emptyMonitoredActivityOutcomeCounts } from "./monitored-session-activity-persistence";
import {
  type PendingChunkAckContractPatch,
  resolvePendingChunkAckContractPatch,
} from "./pending-chunk-ack-contract";
import { resolveSessionPullRequestEvidence } from "./persist-session-children";
import { resolveChunkGatingUnderHoldCeiling } from "./sequence-assembling-hold-ceiling";
import type { SessionSliceIdentity } from "./session-slice-identity";
import type { UpsertSessionSliceResult } from "./session-slice-result";
import { SessionSyncMetric } from "./session-sync-metrics";
import { resolveIngestAwaitingInputSince } from "./upsert-arm-detail";
import {
  resolveSessionWireDataRevisionDisposition,
  SessionGateHoldReason,
  type SessionHoldReason,
} from "./wire-data-revision";

/**
 * Everything the admitted phases downstream read out of gating: the folded
 * status vocabulary, the chunk gate's verdicts, and the freshness gates. Nothing
 * here has touched a column yet — a caller holding this has decided WHAT it may
 * write, not written it.
 */
export type SessionSliceGate = {
  /**
   * The revision {@link resolveRevisionAdmission} admitted, carried through so
   * the write phase reads it off the gate rather than off the raw payload — the
   * sentinel and too-new spellings never exist past admission.
   */
  effectiveDataRevision: number | null | undefined;
  freshness: ReturnType<typeof resolveSessionFreshnessGates>;
  guardedStatus: SessionStatus;
  incomingAwaitingInputSince: Date | null;
  incomingSessionUpdatedAt: Date;
  incomingStatus: SessionStatus;
  /**
   * ISS-8602: the staged-sequence columns, INCLUDING the producer's ack
   * contract. One patch rather than two so a caller that SPREADS it cannot take
   * the marker without the band that says whether the sweep may ever reap it.
   * The create arm does not spread — it names its columns, and resolves the band
   * from `rowLevelAck` below.
   */
  pendingChunkPatch: ReturnType<
    typeof resolveChunkGating
  >["pendingChunkPatch"] &
    PendingChunkAckContractPatch;
  /**
   * ISS-8602: whether the BATCH asked for the row-level ack. Carried on the gate
   * because the ISS-8604 create arm re-runs `resolveChunkGating` with every
   * stored field forced absent, so it can stage a marker this gate refused — and
   * it must then name the band itself rather than inherit an empty patch.
   */
  rowLevelAck: boolean;
  shouldCommitRevision: boolean;
  shouldReplace: boolean;
  shouldUpdateTokenEventCosts: boolean;
  unmodelledStatus: UpsertSessionSliceResult["unmodelledStatus"];
};

type SessionSliceGateOutcome =
  | { refusal: UpsertSessionSliceResult; gate?: never }
  | { refusal?: never; gate: SessionSliceGate };

type RevisionAdmission =
  | { held: UpsertSessionSliceResult }
  | { held?: never; effectiveDataRevision: number | null | undefined };

// ISS-8271: decide what the client-supplied revision MEANS before the apply
// gates on it. A desktop sentinel or too-new revision must not reach
// `resolveChunkGating` — `-1` would read as "stale" and `0` as a real value,
// both wrong — and must never land on the column. `held` writes nothing and
// leaves the session out of `persistedSessionIds`, so an opted-in desktop
// re-sends it under the bounded ack_omitted budget once the row heals; this
// replaces the batch-wide validation 400 that dead-lettered the session
// permanently (see `wire-data-revision.ts` for the full disposition rules).
// A batch that did NOT opt into the row-level ack never reaches this arm —
// `assertHoldExpressible` rejects it up front (`upsert-sessions-batch.ts`).
//
// Pure payload-only decision — no DB read, no lock — so the caller runs it
// FIRST, before ref/advisory locks, keeping a held row's deliberate
// ack_omitted retries a genuine no-op (davetho, #6120). Telemetry is NOT
// emitted here: the caller tallies `heldRevisionReason` into one batch
// aggregate, because held rows are re-sent by design and a per-row emission
// would be caller-drivable log amplification (whitlockk, #6120).
export function resolveRevisionAdmission(
  session: SyncedAgentSession
): RevisionAdmission {
  const disposition = resolveSessionWireDataRevisionDisposition(session);
  if (disposition.kind !== "skip") {
    return { effectiveDataRevision: disposition.revision };
  }
  return {
    held: buildNoWriteSliceResult(
      resolveUnmodelledStatus(session.status),
      disposition.reason
    ),
  };
}

/**
 * The status fold, the chunk gate and its refusals, the storable-timestamp
 * assertion, and the freshness gates — in that order, which is the order the
 * apply has always run them in and which each step depends on:
 *
 *   • the refusals come before the timestamp assertion so a held, foreign, or
 *     assembling session keeps its deliberate no-write result instead of
 *     throwing (ISS-8735); and
 *   • the assertion comes before the freshness gates so the counters they emit
 *     — which fire inside the transaction and are NOT rolled back with it —
 *     never count a slice that cannot commit.
 */
export function resolveSessionSliceGate(
  input: Readonly<{
    computeTargetId: string;
    effectiveDataRevision: number | null | undefined;
    existing: SessionSliceIdentity["existing"];
    organizationId: string;
    rowLevelAck: boolean;
    session: SyncedAgentSession;
    syncTimestamp: Date;
  }>
): SessionSliceGateOutcome {
  const { existing, session } = input;
  // ISS-5648: THE ingest fold. ISS-4654's backfill collapsed the stored
  // `completed`/`abandoned` rows once, but this path stored the client's status
  // verbatim, so a version-skewed Desktop build (pre-#4092 producer) regrew the
  // population on its next sync and gate 3 could never stay met. Folding here
  // keeps the accept-tolerance intact — nothing is rejected — while stopping the
  // retired spelling at the column.
  //
  // TWO folds, for two different sources of the spelling:
  //   • the INCOMING value, which a straggler build is still emitting; and
  //   • the value `resolveGuardedStatus` RESOLVES TO, which is the persisted
  //     spelling untouched whenever terminal-wins fires. Without the outer fold
  //     a row that already stores `completed` (one the backfill missed, or one a
  //     straggler wrote after it ran) rewrites itself on every subsequent sync,
  //     which is the self-regrowing condition this issue is about.
  //
  // The fold is an ACCEPTED coercion, so AGENTS.md ("Handling Bad or Nonsensical
  // Data") wants it on a monitored path rather than absorbed. It is REPORTED to
  // the caller instead of emitted here: this slice runs once per session in a
  // client-supplied batch, and per-row emission on a caller-driven path is what
  // `apps/api/AGENTS.md` ("Emission and Abuse Control") forbids. `service.ts`
  // emits one aggregate count for the batch (whitlockk, PR #4786).
  //
  // ISS-5981: the fold is `normalizeSessionStatus`, whose return is typed
  // `SessionStatus` — so "only a lifecycle value reaches the column" is now
  // stated by the type rather than asserted in a comment. It supersedes the
  // retired-only fold, which let `waiting` and every unmodelled spelling through
  // verbatim. An unrecognized status folds to `active`: whether such a row is
  // really still running is then the reaper's and the display staleness
  // derivation's call, which is where that judgment already lives.
  const incomingStatus = normalizeSessionStatus(session.status);
  const resolvedStatus = existing
    ? resolveGuardedStatus(existing.artifact?.status, incomingStatus)
    : incomingStatus;
  const guardedStatus = normalizeSessionStatus(resolvedStatus);
  // ISS-5981: the fail-open branch of the fold. Reported, not emitted, on the
  // same batch-aggregation grounds as the two above.
  const unmodelledStatus = resolveUnmodelledStatus(session.status);
  // Resolved from the RAW incoming status, before the fold erases the `waiting`
  // spelling the anchor keys off.
  const incomingAwaitingInputSince = resolveIngestAwaitingInputSince(
    session,
    existing
  );

  // ISS-11427: a `sequence_assembling` hold past its ceiling comes back as the
  // decision against a FREED marker, so it is neither refused below nor able to
  // seal the staged sequence's union.
  const { decision, holdExpired } = resolveChunkGatingUnderHoldCeiling(
    {
      incomingRevision: input.effectiveDataRevision,
      chunk: session.chunk,
      existingRevision: existing?.dataRevision,
      existingPendingRevision: existing?.pendingChunkRevision,
      existingPendingTotal: existing?.pendingChunkTotal,
      existingPendingReceived: existing?.pendingChunkReceived,
      existingRevisionDiverged: existing?.dataRevisionDiverged,
    },
    {
      holdable: input.rowLevelAck,
      receivedAt: input.syncTimestamp,
      row: existing,
    }
  );
  const {
    shouldReplace,
    isForeignChunk,
    shouldCommitRevision,
    revisionlessMidSequence,
    pendingChunkPatch,
  } = decision;

  const gateRefusal = resolveGateRefusal({
    isForeignChunk,
    revisionlessMidSequence,
    rowLevelAck: input.rowLevelAck,
    unmodelledStatus,
  });
  if (gateRefusal) {
    return { refusal: gateRefusal };
  }

  assertStorableSessionTimestamps(session);
  if (holdExpired) {
    // Emitted after the timestamp assertion, for the reason the freshness
    // counters below are: never count a slice that cannot commit. Once per
    // hold, not per retry — the apply it admits frees the marker.
    emitTelemetryMetric({
      metric: SessionSyncMetric.SequenceAssemblingHoldExpired,
      organizationId: input.organizationId,
      computeTargetId: input.computeTargetId,
      count: 1,
    });
  }

  // FEA-3419 / ISS-4586 / ISS-4688 / ISS-4946: which regression-guarded columns
  // this apply may write, resolved in one place — the shared
  // `updatedAt >= sessionUpdatedAt` watermark, the stricter PR gate both PR
  // lanes share, and whether a clock-poisoned watermark is being repaired.
  // Rationale for every arm lives on `resolveSessionFreshnessGates`.
  const incomingSessionUpdatedAt = new Date(session.updatedAt);
  const {
    hasBlobEvidence,
    hasLinkEvidence,
    hasBlobWrite,
    hasLinkWrite,
    isPrListPageZero,
  } = resolveSessionPullRequestEvidence(session);
  const freshness = resolveSessionFreshnessGates({
    existingSessionUpdatedAt: existing?.sessionUpdatedAt ?? null,
    incomingSessionUpdatedAt,
    receivedAt: input.syncTimestamp,
    hasPullRequestBlobEvidence: hasBlobEvidence,
    hasPullRequestLinkEvidence: hasLinkEvidence,
    hasPullRequestBlobWrite: hasBlobWrite,
    hasPullRequestLinkWrite: hasLinkWrite,
    isPullRequestListPageZero: isPrListPageZero,
  });
  emitFreshnessGateDiagnostics(freshness, input);

  return {
    gate: {
      effectiveDataRevision: input.effectiveDataRevision,
      freshness,
      guardedStatus,
      incomingAwaitingInputSince,
      incomingSessionUpdatedAt,
      incomingStatus,
      // ISS-8602: the ack contract is folded into the marker patch here, at the
      // one place that already holds both the gate's decision and the batch's
      // `rowLevelAck`, so the write phase spreads all four columns or none.
      pendingChunkPatch: {
        ...pendingChunkPatch,
        ...resolvePendingChunkAckContractPatch(
          pendingChunkPatch,
          input.rowLevelAck
        ),
      },
      rowLevelAck: input.rowLevelAck,
      shouldCommitRevision,
      shouldReplace,
      shouldUpdateTokenEventCosts: freshness.shouldUpdateGuardedColumns,
      unmodelledStatus,
    },
  };
}

/**
 * The "nothing was written" result both no-op arms share — the foreign-chunk
 * skip and the ISS-8271 revision hold. One source of truth so a new
 * `UpsertSessionSliceResult` field cannot be added to one arm and missed in the
 * other (cr-15119 bhb_f0).
 *
 * ISS-8781: `heldRevisionReason` is REQUIRED here, and the missing default is
 * the point. Every no-write arm now names why it wrote nothing, so a sixth arm
 * cannot be added without deciding what the omission report should call it —
 * the failure mode that produced this ticket, where the foreign-chunk arm was
 * representable only as a null reason and stayed unattributable for two years.
 *
 * Field rationale, common to both arms:
 * - `unmodelledStatus` is still reported: the discarded payload PROVES a
 *   producer emitted a spelling this build cannot model, which is the only
 *   question that counter answers (ISS-5981).
 * - `droppedContradictorySessionEnd` is NOT, and the asymmetry is the point:
 *   that counter names a write this apply refused, and these arms performed no
 *   write to refuse (ISS-8552). Reporting it here would count a row whose end
 *   was never in danger, the inflated-tally defect the root `AGENTS.md` warns
 *   about. The payload is re-sent, so a genuinely contradictory one is counted
 *   by the delivery that lands.
 * - Nothing was written and no authority resolved, so the slice observed no
 *   repositories, landed no projected index keys, and never reached the tiling
 *   lane whose version mismatch ISS-8603 counts; the session reports its own on
 *   the delivery that lands.
 */
function buildNoWriteSliceResult(
  unmodelledStatus: UpsertSessionSliceResult["unmodelledStatus"],
  heldRevisionReason: SessionHoldReason
): UpsertSessionSliceResult {
  return {
    persisted: false,
    retryRequired: false,
    monitoredActivityOutcomeCounts: emptyMonitoredActivityOutcomeCounts(),
    unmodelledStatus,
    droppedContradictorySessionEnd: false,
    observedRepositoryFullNames: [],
    indexKeyProjections: 0,
    droppedOverflowUsageBuckets: [],
    unstorableCounterFields: [],
    activityTilingSkipReason: null,
    heldRevisionReason,
  };
}

/**
 * The refusals that must be decided BEFORE any write, as one gate — so the slice
 * keeps a single early exit and stays under the cognitive-complexity ceiling it
 * already sits against. Returns the no-write result, or null to proceed.
 *
 * FEA-3474 `isForeignChunk`: a chunk that does not belong to the staged sequence
 * is refused unconditionally — appending its events would contaminate the set
 * the real sequence is assembling.
 *
 * ISS-8131 `revisionlessMidSequence`: a payload carrying no revision writes its
 * children ADDITIVELY (`shouldReplace` is false for it), so letting it through
 * seals a union of two derivations as one authoritative `dataRevision` once the
 * tail acks, and nothing later heals it. HOLD it instead: nothing is written,
 * the staged marker is untouched, the id is withheld from the echo, and the
 * desktop re-sends under its bounded ack_omitted budget. Convergence is the
 * PRECONDITION clearing — the re-send carries a real revision once the local
 * reseal lands, which restarts the sequence normally — or, ISS-11427, the hold
 * reaching its ceiling, which frees the staged marker before this gate runs
 * (`sequence-assembling-hold-ceiling.ts`) so this arm no longer fires.
 *
 * That second one is gated on the echo because a hold is INEXPRESSIBLE without
 * it: a pre-#4862 client reads an omitted id as delivered and durably clears the
 * row, so holding would be silent, permanent loss — strictly worse than a union
 * the desktop can still overwrite. That build falls through to the additive
 * apply, whose marker `resolvePendingChunkPatch` already preserves, so it
 * degrades to "no wipe" rather than to the original stranding bug.
 */
function resolveGateRefusal(input: {
  isForeignChunk: boolean;
  revisionlessMidSequence: boolean;
  rowLevelAck: boolean;
  unmodelledStatus: UpsertSessionSliceResult["unmodelledStatus"];
}): UpsertSessionSliceResult | null {
  if (input.isForeignChunk) {
    return buildNoWriteSliceResult(
      input.unmodelledStatus,
      SessionGateHoldReason.ForeignChunk
    );
  }
  if (input.revisionlessMidSequence && input.rowLevelAck) {
    return buildNoWriteSliceResult(
      input.unmodelledStatus,
      SessionGateHoldReason.SequenceAssembling
    );
  }
  return null;
}

/**
 * ISS-5981: the RAW spelling when this build does not model it, else null — the
 * value `SessionSyncMetric.UnmodelledStatusFolded` samples.
 *
 * Named rather than inlined because both entry points here decide it — the
 * admission arm off the raw payload, the gate arm beside the fold — and the two
 * must not diverge.
 *
 * ISS-10364 retired `waiting` from the recognized vocabulary, but it did not
 * make the spelling surprising — it is the single most-documented legacy
 * status in this file, with its own wire-compatibility constant and explicit
 * handling in the reopen and awaiting-input paths. The telemetry this samples
 * exists to catch a genuinely UNKNOWN producer spelling nothing here
 * understands; alerting on `waiting` would be noise about a case this build
 * models deliberately, not a skew signal.
 */
function resolveUnmodelledStatus(status: string): string | null {
  if (status === LEGACY_WAITING_WIRE_STATUS) {
    return null;
  }
  return isRecognizedSessionStatus(status) ? null : status;
}

/**
 * ISS-8735: refuse a `startedAt`/`updatedAt` the NOT NULL `session_started_at`
 * / `session_updated_at` columns cannot hold, before the write rather than at
 * it.
 *
 * No emission here: the batch's `reportSliceFailures` already carries this
 * error, and its `field`, in one bounded sample per request, and
 * `apps/api/AGENTS.md` forbids per-row emission on a caller-driven path. Where
 * it sits in the gate order, and why, is on {@link resolveSessionSliceGate}.
 */
function assertStorableSessionTimestamps(session: SyncedAgentSession): void {
  for (const field of Object.values(SessionTimestampField)) {
    const value = session[field];
    if (isBelowPgTimestampFloor(Date.parse(value))) {
      throw new SessionTimestampOutOfRangeError(field, value);
    }
  }
}

/**
 * Both emissions fire inside the caller's `withDb.tx`, so they count DECISIONS,
 * not committed outcomes: a later rollback in the same apply (the tx-timeout
 * path, or a propagated unique-race) discards the write but leaves the count,
 * and the desktop's at-least-once retry re-counts on each attempt. Acceptable
 * for a trend counter — these answer "is this happening, and how often", not
 * "how many rows are in this state" — but a monitor built on them must not be
 * read as a row count.
 */
function emitFreshnessGateDiagnostics(
  freshness: ReturnType<typeof resolveSessionFreshnessGates>,
  target: Readonly<{ computeTargetId: string; organizationId: string }>
): void {
  if (freshness.didRepairPoisonedWatermark) {
    // AGENTS.md "Handling Bad or Nonsensical Data": a value that cannot be right
    // is routed to the monitored path, never silently coerced.
    emitTelemetryMetric({
      metric: SessionSyncMetric.PoisonedWatermarkRepaired,
      organizationId: target.organizationId,
      computeTargetId: target.computeTargetId,
      count: 1,
    });
  }
  if (freshness.didPreservePullRequestsOnTie) {
    // ISS-4946: the equal-watermark tie-break just skipped a lane whose own
    // evidence was empty AND that had a write to lose. Usually that snapshot is
    // the stale pre-link half of a pre-3bc26f527 pair and skipping is exactly
    // right — but nothing on the wire separates it from a genuine retraction, and
    // on an ended session the frozen `updatedAt` means no later batch relitigates
    // it. Same reporting rule as the repair above: an accepted loss is monitored,
    // not absorbed silently.
    emitTelemetryMetric({
      metric: SessionSyncMetric.PrStatePreservedOnTie,
      organizationId: target.organizationId,
      computeTargetId: target.computeTargetId,
      count: 1,
    });
  }
}
