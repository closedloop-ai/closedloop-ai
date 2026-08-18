/**
 * @file soak-cycle-record.ts
 * @description Scoring for one soak cycle: reconciles what the mock cloud
 * actually received against the pre-drain baseline, evaluates the four
 * invariants plus crash recovery, and assembles the JSONL row. Everything here
 * is pure with respect to the app under test — it reads accumulated state and
 * produces a record, and never touches a process or the filesystem.
 */

import type { MockCloudStats } from "./mock-cloud-server";
import {
  BATCH_SCOPED_VIOLATION_ID,
  type ContentViolation,
  ContentViolationKind,
  type ReadBackResponse,
  type RelationCounts,
  zeroRelations,
} from "./soak-cloud-content";
import { loadAvg1 } from "./soak-support";
import type {
  CloudContentSummary,
  CloudDeliverySummary,
  CycleContext,
  CycleRecord,
  CycleState,
  Mode,
  OutboxDepths,
} from "./soak-types";

/** How many violation strings a JSONL row carries; the count is always exact. */
const VIOLATION_SAMPLE_SIZE = 10;

/** Phase 5 — one JSONL row, assembled from post-teardown state only. */
export function buildCycleRecord(
  context: CycleContext,
  state: CycleState,
  final: {
    startedAt: string;
    loadAvgStart: number;
    endDepths: OutboxDepths;
    /** ISS-6099 read-back corpus, or `null` when the read-back pass failed. */
    readBack: ReadBackResponse | null;
  }
): CycleRecord {
  const { options, workspace } = context;
  const stats = context.mock.stats();
  const delivery = summarizeCloudDelivery(
    stats,
    workspace.baseline,
    workspace.localSessionIds,
    options.mode
  );
  const content = summarizeCloudContent(
    final.readBack,
    delivery.syncedSet,
    workspace.localSessionsWithEvents,
    stats
  );
  const oomSignatures = [
    ...new Set(state.oomHitSets.flatMap((hits) => [...hits])),
  ];
  const durationMs = Date.now() - context.startMs;
  const invariants = evaluateInvariants(
    state,
    delivery,
    content,
    options.mode,
    oomSignatures
  );
  appendInvariantFailReasons(state, delivery, content, invariants);

  const syncedInWindow = delivery.syncedSet.size;
  return {
    cycle: context.cycleIndex,
    mode: options.mode,
    startedAt: final.startedAt,
    endedAt: new Date().toISOString(),
    durationMs,
    loadAvgStart: final.loadAvgStart,
    loadAvgEnd: loadAvg1(),
    outboxStart: workspace.startDepths.pending,
    outboxEnd: final.endDepths.pending,
    outboxDeadLetteredEnd: final.endDepths.deadLettered,
    invocationOutboxStart: workspace.startDepths.invocationPending,
    invocationOutboxEnd: final.endDepths.invocationPending,
    baselineSessionCount: workspace.baseline.length,
    localSessionCount: workspace.localSessionIds.length,
    syncedSessionCount: delivery.syncedSet.size,
    lostSessionCount: delivery.lost.length,
    lostSessionSample: delivery.lost.slice(0, 10),
    extraSyncedCount: delivery.extraSynced.length,
    unknownSyncedSample: delivery.extraSynced.slice(0, 10),
    backfilledSyncedCount: delivery.backfilled.length,
    rawSessionReceives: stats.rawSessionReceives,
    resendWaste: delivery.resendWaste,
    maxReceivesForOneSession: delivery.maxReceives,
    redeliveredSessionCount: delivery.redeliveredSessionCount,
    staleRevisionDeliveryCount: delivery.staleRevisionDeliveries.length,
    staleRevisionDeliverySample: delivery.staleRevisionDeliveries.slice(0, 10),
    unrevisionedDeliveryCount: delivery.unrevisionedDeliveryCount,
    gzipBatches: stats.gzipBatches,
    identityBatches: stats.identityBatches,
    helloCount: stats.helloCount,
    refreshCount: stats.refreshCount,
    invocationPartReceives: stats.invocationPartReceives,
    componentBatchReceives: stats.componentBatchReceives,
    unknownPaths: stats.unknownPaths,
    incompleteChunkSessions: stats.incompleteChunkSessions.slice(0, 10),
    dbHostKills: state.dbHostKills,
    dbHostRecovered: state.dbHostRecovered,
    appKills: state.appKills,
    appRelaunched: state.appRelaunched,
    oomSignatures,
    unexpectedAppExit: state.unexpectedAppExit,
    monotonicViolations: state.monotonicViolations.slice(0, 20),
    drainCompleted: state.drainCompleted,
    sessionsSyncedPerMinute:
      durationMs > 0
        ? Number(((syncedInWindow / durationMs) * 60_000).toFixed(1))
        : null,
    pageReads: {
      ok: state.pageReads.ok,
      errors: state.pageReads.errors,
      timeouts: state.pageReads.timeouts,
      empty: state.pageReads.empty,
      short: state.pageReads.short,
      expectedTotal: state.pageReads.expectedTotal,
      shortestTotal: state.pageReads.shortestTotal,
      p50Ms: percentile(state.pageReads.latenciesMs, 0.5),
      maxMs: state.pageReads.latenciesMs.length
        ? Math.max(...state.pageReads.latenciesMs)
        : null,
    },
    content: {
      deliveredSessions: content.deliveredSessions,
      relationTotals: content.relationTotals,
      violationCount: content.violationCount,
      violationSample: content.violations
        .slice(0, VIOLATION_SAMPLE_SIZE)
        .map(
          (violation) =>
            `${violation.kind}:${violation.externalSessionId}:${violation.detail}`
        ),
      relationDropSessions: content.relationDropSessions.slice(
        0,
        VIOLATION_SAMPLE_SIZE
      ),
      readBackSessions: content.readBackSessions,
      readBackComplete: content.readBackComplete,
      readBackSampleBodies: content.readBackSampleBodies,
      readBackSampleBytes: content.readBackSampleBytes,
      readBackSampleTruncated: content.readBackSampleTruncated,
    },
    invariants,
    failReasons: state.failReasons,
    notes: state.notes,
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ];
}

/**
 * ISS-6098 — split "delivered but not in the pending-outbox baseline" into the
 * two things it was conflating.
 *
 * The baseline is the PENDING OUTBOX (2,938 rows on the reference snapshot),
 * but backfill enumerates sessions independently of the outbox BY DESIGN
 * (operator ruling, 2026-08-12). The 2,962-session snapshot therefore delivered
 * 24 sessions the baseline never contained, every cycle, on every build — the
 * constant `extra_synced:24` that made the signal structural rather than
 * behavioural. That was the ORACLE encoding the wrong population, not the build
 * misbehaving.
 *
 * The assertion is kept and narrowed rather than deleted:
 *  - delivered, absent from the baseline, PRESENT in the local corpus → a
 *    legitimate backfill enumeration, reported as `backfilled` and not a fail;
 *  - delivered, absent from BOTH → still `extraSynced`, still a fail reason. An
 *    id the cloud received that exists nowhere locally is a fabricated session,
 *    and nothing about this ruling makes that acceptable.
 *
 * Deliberately untouched: `cleanDupSessions` below, which reads
 * `deliveriesBySession` and is the ONLY duplicate-delivery signal. It is a
 * different axis from population membership and this narrowing cannot mask it
 * (ISS-6101).
 */
function summarizeCloudDelivery(
  stats: MockCloudStats,
  baseline: string[],
  localSessionIds: string[],
  mode: Mode
): CloudDeliverySummary {
  const baselineSet = new Set(baseline);
  const localSet = new Set(localSessionIds);
  const syncedSet = new Set(stats.syncedSessionIds);
  const lost = baseline.filter((id) => !syncedSet.has(id));
  const outsideBaseline = stats.syncedSessionIds.filter(
    (id) => !baselineSet.has(id)
  );
  const backfilled = outsideBaseline.filter((id) => localSet.has(id));
  const extraSynced = outsideBaseline.filter((id) => !localSet.has(id));
  const maxReceives = Math.max(0, ...Object.values(stats.receivesBySession));
  // The real cloud dedupes idempotently, so duplicate COMPLETE deliveries
  // measure waste rather than corruption — but in a CLEAN cycle (no injected
  // kill to justify a re-send) the SAME payload fully delivered twice is a DUP
  // violation.
  //
  // ISS-6101: keyed on (session, dataRevision), NOT on session alone. The cloud
  // upsert REPLACES a session whose `dataRevision` differs, so a second delivery
  // carrying a newer revision is a required re-sync, not a duplicate — and the
  // boot data-revision rebuild produces exactly that in every cycle: it
  // re-derives the corpus mid-drain, re-enqueues each changed session, and the
  // already-delivered ones are legitimately sent again at the new revision. The
  // session-level count is still reported (`redeliveredSessionCount`) so that
  // volume stays visible instead of being scored away.
  const cleanDupSessions =
    mode === "clean"
      ? Object.entries(stats.deliveriesBySessionRevision).filter(
          ([, count]) => count > 1
        )
      : [];
  const redeliveredSessions = Object.values(stats.deliveriesBySession).filter(
    (count) => count > 1
  );
  return {
    syncedSet,
    lost,
    extraSynced,
    backfilled,
    maxReceives,
    // Waste is the raw receives BEYOND what the deliveries actually cost. The
    // subtrahend is `deliveredReceiveUnits` (chunk-aware), not the delivery
    // count: this mock always negotiates activity chunking, so an N-chunk
    // session delivered once with no retry at all would otherwise be scored as
    // N-1 units of waste and swamp the real re-send signal.
    resendWaste: stats.rawSessionReceives - stats.deliveredReceiveUnits,
    cleanDupSessions,
    redeliveredSessionCount: redeliveredSessions.length,
    staleRevisionDeliveries: stats.staleRevisionDeliveries,
    unrevisionedDeliveryCount: Object.values(
      stats.unrevisionedDeliveriesBySession
    ).reduce((total, count) => total + count, 0),
  };
}

/**
 * ISS-6099 — reconcile the READ-BACK corpus against the delivered set.
 *
 * The read-back is what makes this an oracle over data rather than over
 * arrivals: the harness asks the cloud for what it was given and checks the
 * answer covers every session the envelope bookkeeping says was delivered. A
 * `null` `readBack` means the read-back pass itself failed, which is recorded as
 * an incomplete read-back — never as a clean one.
 */
function summarizeCloudContent(
  readBack: ReadBackResponse | null,
  syncedSet: Set<string>,
  localSessionsWithEvents: string[],
  stats: MockCloudStats
): CloudContentSummary {
  // Start from the canonical zero-valued shape, not `{} as RelationCounts`: on
  // a failed read-back the latter serializes as `{}` and every field the type
  // promises reads back `undefined`. A relation with no rows is a zero, and an
  // unavailable read-back is a zero total — neither is an absent key.
  const relationTotals = zeroRelations();
  const violations: ContentViolation[] = [];
  for (const version of stats.unexpectedSchemaVersions) {
    violations.push({
      externalSessionId: BATCH_SCOPED_VIOLATION_ID,
      kind: ContentViolationKind.SchemaVersionMismatch,
      detail: `batch declared schemaVersion ${version}`,
    });
  }
  if (stats.batchesMissingSchemaVersion > 0) {
    // An absent `schemaVersion` is not a milder version of a wrong one: the
    // ingest schema pins the field with `z.literal(...)`, so omitting it is
    // rejected there just as a wrong number is. Scored as the same violation
    // kind for that reason.
    violations.push({
      externalSessionId: BATCH_SCOPED_VIOLATION_ID,
      kind: ContentViolationKind.SchemaVersionMismatch,
      detail: `${stats.batchesMissingSchemaVersion} batch(es) declared no usable schemaVersion`,
    });
  }
  if (!readBack) {
    return {
      deliveredSessions: 0,
      relationTotals,
      violations,
      violationCount: violations.length,
      relationDropSessions: [],
      readBackSessions: 0,
      readBackComplete: false,
      readBackSampleBodies: 0,
      readBackSampleBytes: 0,
      readBackSampleTruncated: false,
    };
  }
  // The read-back arrives as parsed JSON over HTTP, so its shape is a runtime
  // fact rather than a compile-time one. A malformed or older response degrades
  // to "no violations reported" instead of throwing here and taking the whole
  // cycle record — which would turn a diagnostic gap into a lost measurement.
  const reportedViolations = Array.isArray(readBack.violations)
    ? readBack.violations
    : [];
  const reportedViolationCount =
    typeof readBack.violationCount === "number"
      ? readBack.violationCount
      : reportedViolations.length;
  violations.push(...reportedViolations);
  const withEvents = new Set(localSessionsWithEvents);
  const returned = new Set<string>();
  const relationDropSessions: string[] = [];
  for (const entry of readBack.index) {
    returned.add(entry.externalSessionId);
    for (const [relation, count] of Object.entries(entry.relations)) {
      const key = relation as keyof RelationCounts;
      relationTotals[key] += count;
    }
    if (
      entry.relations.events === 0 &&
      withEvents.has(entry.externalSessionId)
    ) {
      relationDropSessions.push(entry.externalSessionId);
    }
  }
  // Every session the envelope path recorded as delivered must come back. A
  // session counted as synced whose content the cloud cannot return is exactly
  // the envelope-vs-content gap this ticket exists to close.
  const missingFromReadBack = [...syncedSet].filter((id) => !returned.has(id));
  for (const id of missingFromReadBack) {
    violations.push({
      externalSessionId: id,
      kind: ContentViolationKind.MissingFromReadBack,
      detail: "delivered but absent from the read-back corpus",
    });
  }
  return {
    deliveredSessions: readBack.index.length,
    relationTotals,
    violations,
    // The read-back's own count is EXACT even when its list was truncated at
    // the cap, so a violation storm can never make a cycle look cleaner.
    violationCount:
      violations.length - reportedViolations.length + reportedViolationCount,
    relationDropSessions,
    readBackSessions: returned.size,
    readBackComplete: missingFromReadBack.length === 0 && syncedSet.size > 0,
    readBackSampleBodies: readBack.sample.length,
    readBackSampleBytes: readBack.sampleBytes,
    readBackSampleTruncated: readBack.sampleTruncated === true,
  };
}

function evaluateInvariants(
  state: CycleState,
  delivery: CloudDeliverySummary,
  content: CloudContentSummary,
  mode: Mode,
  oomSignatures: string[]
): CycleRecord["invariants"] {
  return {
    noOom: oomSignatures.length === 0 && !state.unexpectedAppExit,
    monotonicDrain:
      state.drainCompleted && state.monotonicViolations.length === 0,
    noLoss: state.drainCompleted ? delivery.lost.length === 0 : false,
    noDup: mode === "clean" ? delivery.cleanDupSessions.length === 0 : true,
    // ISS-6100: answering is not enough — an empty or short answer is a failure.
    readsAnswer:
      state.pageReads.timeouts === 0 &&
      state.pageReads.errors === 0 &&
      state.pageReads.empty === 0 &&
      state.pageReads.short === 0,
    // `readBackComplete` is a PRECONDITION, not a peer: when the read-back
    // failed, no content was examined at all, and the violations the mock still
    // holds simply never crossed the wire. Reporting `contentIntact: true` there
    // would be the JSONL row asserting a cycle's content was sound on the
    // strength of having looked at none of it.
    contentIntact:
      content.readBackComplete &&
      content.violationCount === 0 &&
      content.relationDropSessions.length === 0,
    readBackComplete: content.readBackComplete,
    crashRecovered: resolveCrashRecovered(
      mode,
      state.dbHostRecovered,
      state.appRelaunched
    ),
  };
}

/**
 * Appends the invariant-derived reasons to the reasons the drain loop already
 * recorded. Order matters: the `drain_incomplete` test reads the accumulated
 * list to avoid double-reporting a budget overrun.
 */
function appendInvariantFailReasons(
  state: CycleState,
  delivery: CloudDeliverySummary,
  content: CloudContentSummary,
  invariants: CycleRecord["invariants"]
): void {
  if (!invariants.noOom) {
    state.failReasons.push("oom_or_unexpected_exit");
  }
  if (
    !(
      state.drainCompleted ||
      state.failReasons.includes("drain_budget_exceeded")
    )
  ) {
    state.failReasons.push("drain_incomplete");
  }
  // The other half of `monotonicDrain`. Without this, a cycle whose outbox depth
  // went UP and then still reached zero has a false `monotonicDrain` invariant
  // but an empty reason list, so the runner prints PASS for a failed invariant.
  if (state.monotonicViolations.length > 0) {
    state.failReasons.push(
      `monotonic_violations:${state.monotonicViolations.length}`
    );
  }
  if (state.drainCompleted && delivery.lost.length > 0) {
    state.failReasons.push(`loss:${delivery.lost.length}`);
  }
  // ISS-6098: the population the oracle asserts membership against is
  // baseline ∪ local-corpus, not the baseline alone — backfill enumerates
  // independently of the outbox by design. A delivered id outside BOTH exists
  // nowhere locally and is still a fail.
  if (delivery.extraSynced.length > 0) {
    state.failReasons.push(`extra_synced:${delivery.extraSynced.length}`);
  }
  if (delivery.cleanDupSessions.length > 0) {
    state.failReasons.push(`dup:${delivery.cleanDupSessions.length}`);
  }
  // ISS-6101: keying duplicates on (session, dataRevision) must not let a
  // revision REGRESSION through. The real upsert is forward-only, so a delivery
  // below a revision already sent for that session is work the cloud would
  // reject — wrong in every mode, crash or not.
  if (delivery.staleRevisionDeliveries.length > 0) {
    state.failReasons.push(
      `stale_revision:${delivery.staleRevisionDeliveries.length}`
    );
  }
  // Re-delivery is legitimate when a revision changed, so it is not a fail
  // reason — but it is the goal's waste signal, so it is recorded on EVERY
  // cycle rather than only surfacing when something else already failed.
  if (delivery.redeliveredSessionCount > 0) {
    state.notes.push(`redelivered:${delivery.redeliveredSessionCount}`);
  }
  if (!invariants.readsAnswer) {
    state.failReasons.push(
      `page_reads: ${state.pageReads.timeouts} timeouts ${state.pageReads.errors} errors ${state.pageReads.empty} empty ${state.pageReads.short} short`
    );
  }
  // ISS-6099: content, not envelopes.
  if (content.violationCount > 0) {
    state.failReasons.push(`content_violations:${content.violationCount}`);
  }
  if (content.relationDropSessions.length > 0) {
    state.failReasons.push(
      `relation_drop:${content.relationDropSessions.length}`
    );
  }
  if (!invariants.readBackComplete) {
    state.failReasons.push(
      `read_back_incomplete:${content.readBackSessions}/${delivery.syncedSet.size}`
    );
  }
}

/** `null` in clean mode: there was no crash, so recovery is not applicable. */
function resolveCrashRecovered(
  mode: Mode,
  dbHostRecovered: boolean | null,
  appRelaunched: boolean | null
): boolean | null {
  if (mode === "dbkill") {
    return dbHostRecovered;
  }
  if (mode === "appkill") {
    return appRelaunched;
  }
  return null;
}
