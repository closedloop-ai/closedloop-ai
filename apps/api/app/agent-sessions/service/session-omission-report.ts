/**
 * ISS-8781: name every `externalSessionId` a row-level-ack batch withheld from
 * `acceptedSessionIds`, with the cause that withheld it.
 *
 * THE POPULATION IS DERIVED, NEVER ACCUMULATED. `payload.sessions` minus the ids
 * the batch echoes is precisely what the desktop experiences as omission, so it
 * is the only oracle that cannot go stale. Attribution is layered on top of that
 * set rather than being the set: every withheld id no cause claims lands in
 * `Unattributed` and is reported anyway, so a SIXTH omission path added later is
 * loud by construction instead of silent by default.
 *
 * That default is not hypothetical — it is how this defect was born. The ticket's
 * original table named three causes; two more (`monitored_activity_retry_required`
 * and `budget_deferred`) were added afterwards and inherited its silence, and an
 * id-list accumulated at each known omission site would have inherited it again.
 *
 * BOUNDS ARE PER CAUSE, NEVER PER BATCH — see
 * {@link MAX_OMITTED_SESSION_IDS_PER_CAUSE}.
 *
 * Sibling-extraction precedent: `activity-tiling-strip.ts`,
 * `degraded-metadata-merge.ts`, `status-fold-telemetry.ts`. This logic lives in
 * its own module because `upsert-sessions-batch.ts` carries no
 * `noExcessiveLinesPerFile` grandfather entry and must not earn one.
 */
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import type { UpsertSessionsContext } from "./records";
import { boundSampledIdentifier } from "./sampled-identifier";
import type { UpsertSessionSliceResult } from "./session-slice-result";
import { SessionSyncMetric } from "./session-sync-metrics";
import {
  SessionGateHoldReason,
  type SessionHoldReason,
  WireDataRevisionSkipReason,
} from "./wire-data-revision";

/**
 * Why one `externalSessionId` was absent from `acceptedSessionIds`.
 *
 * The first four mirror `SessionHoldReason` one-for-one and are resolved from it
 * by {@link resolveOmissionCause}, so the two cannot drift. The last four are
 * decided by the batch, which is the only layer that knows them: a slice that
 * threw, a slice that COMMITTED but is ineligible for acknowledgement, a session
 * the runtime budget never reached, and the fail-safe bucket.
 */
export const SessionOmissionCause = {
  /** FEA-3474: the chunk does not belong to the staged pending assembly. */
  ForeignChunk: "foreign_chunk",
  /** ISS-8271: a desktop sentinel revision — the row is mid-derivation. */
  RevisionPending: "revision_pending",
  /** ISS-8271: a revision above `MAX_SUPPORTED_DATA_REVISION`. */
  RevisionTooNew: "revision_too_new",
  /** ISS-8131: a revision-less payload arrived mid chunk sequence. */
  SequenceAssembling: "sequence_assembling",
  /** The slice threw and was isolated so it could not reject its batch. */
  SliceThrew: "slice_threw",
  /**
   * The slice COMMITTED and is still withheld: a monitored-activity target is
   * unresolved, so the desktop must retain the row for an idempotent retry.
   * The session data IS in the cloud — this is the cause ISS-8781 was filed
   * over, and the only one where "withheld" does not mean "not stored".
   */
  MonitoredActivityRetryRequired: "monitored_activity_retry_required",
  /** ISS-8186: the runtime budget ended the loop before reaching this id. */
  BudgetDeferred: "budget_deferred",
  /**
   * Withheld with no cause this build recognizes — the fail-safe, and the whole
   * reason the population is derived rather than accumulated. A non-zero count
   * here means a NEW omission path exists that nothing attributes, which is a
   * bug in this module's inputs and not in the batch that reported it.
   */
  Unattributed: "unattributed",
} as const;
export type SessionOmissionCause =
  (typeof SessionOmissionCause)[keyof typeof SessionOmissionCause];

/**
 * How many withheld session ids ONE CAUSE may name in the report.
 *
 * The cap exists because `payload.sessions` carries no `.max()` and the payload
 * is deterministic and re-sent on every retry, so an unbounded id list is
 * caller-drivable log amplification — the bound four standing review decisions on
 * this path already require (ISS-8069, ISS-8330, ISS-8881, and ISS-8271 citing
 * whitlockk on #6120). It is the `MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST` shape.
 *
 * PER CAUSE, NOT PER BATCH, and that is not a detail. A batch-wide cap satisfies
 * the amplification bound identically and still destroys the report: a routine
 * flood of `foreign_chunk` skips would evict the single
 * `monitored_activity_retry_required` id, which is the only id anyone is ever
 * looking for. Counts stay EXACT under either design — it is the id list that is
 * sampled — so the difference is invisible to every test except the one written
 * to catch it.
 */
export const MAX_OMITTED_SESSION_IDS_PER_CAUSE = 20;

/**
 * The one message BOTH levels write, so a single log query finds the whole
 * withheld population and the LEVEL is what separates the two halves of it.
 */
const OMISSION_LOG_MESSAGE =
  "Desktop agent sessions withheld from the ack echo";

/**
 * The two levels this report writes at, split by whether a cause is worth an
 * operator's attention.
 *
 * `apps/api/AGENTS.md` reserves warn for partial failures, rejected scopes, and
 * other events that need someone to look. Most omissions are none of those:
 * `apps/api/app/agent-sessions/AGENTS.md` records that a chunked same-revision
 * snapshot makes every later slice arrive FOREIGN by design, and a
 * `revision_pending` hold is ordinary desktop behaviour while a row is
 * mid-derivation — so one undifferentiated warn made steady-state chunked sync
 * page on every request, which is how a warn stops being read at all.
 */
const OmissionLogLevel = {
  /** A fault, a row the desktop is stuck re-sending, or an omission nothing explains. */
  Warn: "warn",
  /** A routine hold that the next sync resolves on its own. */
  Debug: "debug",
} as const;
type OmissionLogLevel =
  (typeof OmissionLogLevel)[keyof typeof OmissionLogLevel];

/**
 * Which level each cause is written at.
 *
 * AN EXHAUSTIVE `Record`, and that is the whole point: a cause added to
 * {@link SessionOmissionCause} fails `tsc` here rather than defaulting into one
 * side. A `Set` or array naming "the routine ones" would compile unchanged and
 * silently classify the new cause as the other half — the side-inventory defect
 * the root `AGENTS.md` names, and precisely the class this module exists to
 * prevent.
 */
const OMISSION_CAUSE_LOG_LEVEL: Record<SessionOmissionCause, OmissionLogLevel> =
  {
    // Nobody acts on these. Chunked snapshots make later slices foreign by
    // design, both revision holds clear when the desktop's own derivation lands,
    // an assembling sequence completes on its next chunk, and a budget-deferred
    // tail is re-sent by the next request.
    [SessionOmissionCause.ForeignChunk]: OmissionLogLevel.Debug,
    [SessionOmissionCause.RevisionPending]: OmissionLogLevel.Debug,
    [SessionOmissionCause.RevisionTooNew]: OmissionLogLevel.Debug,
    [SessionOmissionCause.SequenceAssembling]: OmissionLogLevel.Debug,
    [SessionOmissionCause.BudgetDeferred]: OmissionLogLevel.Debug,
    // A slice fault; a session that IS in the cloud and that the desktop must
    // keep re-sending anyway; and an omission this build cannot explain at all.
    [SessionOmissionCause.SliceThrew]: OmissionLogLevel.Warn,
    [SessionOmissionCause.MonitoredActivityRetryRequired]:
      OmissionLogLevel.Warn,
    [SessionOmissionCause.Unattributed]: OmissionLogLevel.Warn,
  };

/** One cause's share of a batch's withheld population. */
type SessionOmissionBucket = {
  cause: SessionOmissionCause;
  /** EXACT — never sampled, never capped. */
  count: number;
  /** Bounded in cardinality by the cap and in bytes by `boundSampledIdentifier`. */
  sessionIds: string[];
  /** True when `count` exceeds what `sessionIds` names, so a reader is never handed a partial list that looks whole. */
  sampleTruncated: boolean;
};

/**
 * The per-slice attributions one batch collected, keyed on `externalSessionId`.
 *
 * A MAP, not an array: nothing bounds a payload against carrying the same id
 * twice, and a positional list would attribute the duplicate twice while a plain
 * array difference would mis-attribute it entirely.
 */
export type SessionOmissionTally = {
  /**
   * Attribute one attempted session's outcome. Last write wins for a repeated
   * id. A `null` cause — what {@link resolveOmissionCause} returns for a slice
   * whose id IS echoed — records nothing, so the caller stays a single
   * unbranched statement inside a loop already at the complexity ceiling.
   */
  record(externalSessionId: string, cause: SessionOmissionCause | null): void;
  readonly attributions: ReadonlyMap<string, SessionOmissionCause>;
};

export function createSessionOmissionTally(): SessionOmissionTally {
  const attributions = new Map<string, SessionOmissionCause>();
  return {
    attributions,
    record(externalSessionId, cause) {
      if (cause === null) {
        return;
      }
      attributions.set(externalSessionId, cause);
    },
  };
}

/**
 * What one completed slice's outcome means for the ack echo: a cause, or `null`
 * when the id IS echoed and nothing was withheld.
 *
 * Reads exactly the three fields `upsertSessionsBatch` gates the echo on, so the
 * attribution and the omission cannot disagree — if this returns non-null, that
 * gate withheld the id, and the derived population will contain it.
 */
export function resolveOmissionCause(
  outcome: Pick<
    UpsertSessionSliceResult,
    "heldRevisionReason" | "persisted" | "retryRequired"
  >
): SessionOmissionCause | null {
  if (outcome.persisted) {
    return outcome.retryRequired
      ? SessionOmissionCause.MonitoredActivityRetryRequired
      : null;
  }
  return resolveHoldCause(outcome.heldRevisionReason);
}

/**
 * Report the batch's withheld population, once: one log line per LEVEL that has
 * buckets, plus one scalar metric emission per CAUSE. Silent when nothing was
 * withheld, so the metric measures omission rather than sync traffic.
 *
 * BEST-EFFORT, AND NEVER THROWING — the same guard and the same reason as
 * `createStatusFoldTally().emit`. This runs from the batch `finally` ahead of
 * `flushObservedRepositories`, `reportStrippedTilings`, and
 * `reportDegradedMetadata`, so a throw here would skip all three and replace
 * whatever real ingest error was already unwinding. Each log line and each
 * metric emission is guarded ON ITS OWN, as `emitFoldCount` guards each of its
 * emissions, so one broken sink cannot suppress the rest.
 *
 * CALL IT AFTER THE WATERMARK STAMPS, not before. `batchSucceeded` is set while
 * the loop is still unwinding, so a report that ran first could describe an ack
 * echo the request never sent: a `stampIngestSyncWatermark` failure makes the
 * handler answer `ingestion_failed`, with no `acceptedSessionIds` for anything
 * to have been withheld from.
 *
 * ONE EMISSION PER CAUSE, carrying `cause` and `count` and nothing else — the
 * shape `emitHeldRevisionCounts` and `reportDroppedUsageBuckets` already keep.
 * `emitTelemetryMetric` is `JSON.stringify` into a single log line, so a nested
 * `causes` array cannot be summed per cause by the PRD-159 log-metric generator
 * this report is waiting on. The sampled ids ride the log line only, which is
 * where a human reads them.
 *
 * TWO GATES, BOTH LOAD-BEARING, and neither is redundant with the other.
 *
 * `rowLevelAck` — a batch that did not ask for the echo
 * (`wantsAcceptedSessionIds` absent, a build older than #4862) is answered
 * `{accepted: true}` with no echo at all, so the desktop durably clears every id
 * it sent. "Withheld" is meaningless there and reporting it would be a pure
 * false positive on every legacy delivery — including a foreign chunk, which is
 * genuinely absent from `persistedSessionIds` and acked anyway.
 *
 * `batchSucceeded` — when every attempted slice threw, `settleSliceFailures`
 * rethrows and the handler answers `ingestion_failed`. There is no ack, so there
 * is no ack to be omitted from, and a report would describe an outcome that did
 * not happen while inflating the very signal an operator would use to tell a
 * poison row from an outage.
 */
export function reportSessionOmissions(
  context: UpsertSessionsContext,
  tally: SessionOmissionTally,
  input: {
    attemptedSessionCount: number;
    batchSucceeded: boolean;
    persistedSessionIds: readonly string[];
    rowLevelAck: boolean;
    sessions: readonly { externalSessionId: string }[];
  }
): void {
  if (!(input.rowLevelAck && input.batchSucceeded)) {
    return;
  }
  const buckets = collectOmissionBuckets(tally, input);
  if (buckets.length === 0) {
    return;
  }
  logOmissionsAtLevel(context, OmissionLogLevel.Warn, buckets);
  logOmissionsAtLevel(context, OmissionLogLevel.Debug, buckets);
  for (const bucket of buckets) {
    emitOmissionCount(context, bucket);
  }
}

/**
 * Fold the DERIVED withheld set into one bucket per cause.
 *
 * The withheld set is `sessions` minus `persistedSessionIds`, deduplicated on
 * the id: a payload that repeats an id describes ONE session the desktop is
 * still holding, so counting it twice would overstate the population against the
 * wire's own meaning.
 */
function collectOmissionBuckets(
  tally: SessionOmissionTally,
  input: {
    attemptedSessionCount: number;
    persistedSessionIds: readonly string[];
    sessions: readonly { externalSessionId: string }[];
  }
): SessionOmissionBucket[] {
  const persisted = new Set(input.persistedSessionIds);
  const buckets = new Map<SessionOmissionCause, SessionOmissionBucket>();
  const counted = new Set<string>();
  let index = 0;
  for (const session of input.sessions) {
    const externalSessionId = session.externalSessionId;
    const position = index;
    index += 1;
    if (persisted.has(externalSessionId) || counted.has(externalSessionId)) {
      continue;
    }
    counted.add(externalSessionId);
    foldOmission(
      buckets,
      externalSessionId,
      resolveWithheldCause(tally, {
        attemptedSessionCount: input.attemptedSessionCount,
        externalSessionId,
        position,
      })
    );
  }
  return [...buckets.values()];
}

/**
 * The cause for one withheld id: what a slice recorded, else what its POSITION
 * says.
 *
 * A session the loop never reached has no slice outcome to attribute, and the
 * only thing that distinguishes it from a genuinely unexplained omission is that
 * its index sits at or past `attemptedSessionCount` — which is exactly the
 * boundary `reportRuntimeBudgetDeferral` measures the tail from.
 */
function resolveWithheldCause(
  tally: SessionOmissionTally,
  input: {
    attemptedSessionCount: number;
    externalSessionId: string;
    position: number;
  }
): SessionOmissionCause {
  const recorded = tally.attributions.get(input.externalSessionId);
  if (recorded) {
    return recorded;
  }
  return input.position >= input.attemptedSessionCount
    ? SessionOmissionCause.BudgetDeferred
    : SessionOmissionCause.Unattributed;
}

/** Count exactly; sample the id under this cause's own cap. */
function foldOmission(
  buckets: Map<SessionOmissionCause, SessionOmissionBucket>,
  externalSessionId: string,
  cause: SessionOmissionCause
): void {
  const bucket = buckets.get(cause) ?? {
    cause,
    count: 0,
    sessionIds: [],
    sampleTruncated: false,
  };
  bucket.count += 1;
  if (bucket.sessionIds.length < MAX_OMITTED_SESSION_IDS_PER_CAUSE) {
    bucket.sessionIds.push(boundSampledIdentifier(externalSessionId));
  } else {
    bucket.sampleTruncated = true;
  }
  buckets.set(cause, bucket);
}

/**
 * Map a no-write slice's hold reason onto its cause.
 *
 * EXHAUSTIVE by construction: a `SessionHoldReason` added later fails `tsc` at
 * the `never` assignment below rather than falling into `unattributed` in
 * production, where it would be indistinguishable from the unexplained omission
 * the fail-safe bucket exists to surface.
 */
function resolveHoldCause(
  reason: SessionHoldReason | null | undefined
): SessionOmissionCause {
  if (!reason) {
    return SessionOmissionCause.Unattributed;
  }
  switch (reason) {
    case SessionGateHoldReason.ForeignChunk:
      return SessionOmissionCause.ForeignChunk;
    case SessionGateHoldReason.SequenceAssembling:
      return SessionOmissionCause.SequenceAssembling;
    case WireDataRevisionSkipReason.RevisionPending:
      return SessionOmissionCause.RevisionPending;
    case WireDataRevisionSkipReason.RevisionTooNew:
      return SessionOmissionCause.RevisionTooNew;
    default:
      return reportUnmappedHoldReason(reason);
  }
}

/**
 * The compile-time half of the exhaustive switch, and its runtime fail-safe.
 *
 * `never` is what makes a new hold reason a build failure here. The runtime arm
 * exists because this runs inside the batch's `finally`: a value that reached it
 * anyway (a version-skewed persisted shape, a hand-built fixture) must be
 * counted as unattributed rather than throw and take the watermark stamps with
 * it.
 */
function reportUnmappedHoldReason(reason: never): SessionOmissionCause {
  log.warn("Unmapped desktop agent session hold reason", { reason });
  return SessionOmissionCause.Unattributed;
}

/**
 * Write one level's share of the withheld population, or nothing when that level
 * has none.
 *
 * A batch carrying both kinds emits BOTH lines, each naming only its own
 * buckets: blending them would make each line claim a population it does not
 * name, and would put the routine holds back into the warn the split exists to
 * keep readable.
 */
function logOmissionsAtLevel(
  context: UpsertSessionsContext,
  level: OmissionLogLevel,
  buckets: readonly SessionOmissionBucket[]
): void {
  const causes = buckets.filter(
    (bucket) => OMISSION_CAUSE_LOG_LEVEL[bucket.cause] === level
  );
  if (causes.length === 0) {
    return;
  }
  const fields = {
    causes,
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
    withheldCount: causes.reduce((sum, bucket) => sum + bucket.count, 0),
  };
  reportBestEffort(level, () => {
    if (level === OmissionLogLevel.Warn) {
      log.warn(OMISSION_LOG_MESSAGE, fields);
      return;
    }
    log.debug(OMISSION_LOG_MESSAGE, fields);
  });
}

/**
 * One cause's count, scalar and facetable. The sampled ids are deliberately NOT
 * here — see the note on {@link reportSessionOmissions}.
 */
function emitOmissionCount(
  context: UpsertSessionsContext,
  bucket: SessionOmissionBucket
): void {
  reportBestEffort(bucket.cause, () => {
    emitTelemetryMetric({
      metric: SessionSyncMetric.SessionWithheldFromAck,
      organizationId: context.organizationId,
      computeTargetId: context.computeTargetId,
      cause: bucket.cause,
      count: bucket.count,
    });
  });
}

/**
 * Run one observability side effect without letting it reach the caller.
 *
 * `log.error` for the failure itself rather than `log.warn`, because the call
 * that just threw may BE `log.warn` — reporting through the sink already under
 * suspicion is how a guard turns into the throw it was written to stop.
 */
function reportBestEffort(step: string, emit: () => void): void {
  try {
    emit();
  } catch (error) {
    log.error("Failed to report withheld desktop agent sessions", {
      step,
      error: parseError(error),
    });
  }
}
