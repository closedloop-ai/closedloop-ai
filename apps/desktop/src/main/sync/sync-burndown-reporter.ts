/**
 * @file sync-burndown-reporter.ts
 * @description The periodic desktop→cloud sync BURN-DOWN sampler (ISS-5387).
 *
 * Answers the two questions the per-action sync logs never could: **how much is
 * still owed to the cloud**, and **am I actually caught up?** It samples the
 * lane stores on a slow timer, diffs each sample against the previous one, and
 * emits per-lane burn-down lines, a truthful per-lane and all-lanes "fully
 * synced" signal, and a warning when a lane is doing work its durable cursor is
 * not recording.
 *
 * ## It reads; it never participates
 *
 * The reporter is a pure OBSERVER. It adds no query to any lane's hot path: the
 * store side is a set of grouped aggregates on the reader pool, run inside one
 * read-scoped snapshot transaction
 * (`main/database/sync-burndown-store.ts`), and the per-pass activity counters
 * are fed by TEES on hooks the composition already wired — the session lane's
 * existing `onSyncBatchTelemetry`, and one increment each on the component and
 * invocation send paths. A lane's behaviour is byte-identical whether or not
 * this reporter exists.
 *
 * ## Why the cursor is on every line
 *
 * ISS-5347: the component-inventory lane logged `synced N agent component(s) to
 * cloud inventory` 1,713 times in a day while its `sync_state` row stayed frozen
 * at `data_revision 65` for three days. Reads kept working; only the durable
 * persist had died. An item-counting burn-down would have shown the same
 * reassuring numbers all day. So every lane's line carries its DURABLE cursor
 * and that cursor's age, and {@link SyncBurndownReporter} raises a warning the
 * moment observed work and a motionless cursor coincide.
 *
 * ## Emission policy — periodic AND on transition, never per item
 *
 * - While a lane is `draining`, one line per tick. There is work; the operator
 *   wants the trend.
 * - When a lane's state CHANGES, one line for the transition, including the
 *   `fully synced` / `NOT fully synced (dead-lettered)` verdicts.
 * - When every lane is settled, silence — no heartbeat spam into a log that has
 *   nothing to report. The all-lanes verdict is emitted once as a baseline on
 *   the first sample and thereafter only when the answer CHANGES, so it re-arms:
 *   new work moves a lane back to `draining` and the next drain emits again.
 * - Per-chunk and per-item lines already exist elsewhere. This adds none.
 */

import {
  areAllLanesFullySynced,
  classifyLaneDrainState,
  detectCursorStall,
  detectNoProgressStall,
  formatAllLanesVerdictLine,
  formatCursorStallLine,
  formatLaneBurndownLine,
  formatLaneDrainedWithDeadLettersLine,
  formatLaneFullySyncedLine,
  formatLaneRemainingUnknownLine,
  formatNoProgressStallLine,
  type OldestPendingBasis,
  OldestPendingBasis as OldestPendingBasisValues,
  type SyncBurndownSnapshot,
  type SyncLaneBurndown,
  SyncLaneDrainState,
  SyncLaneId,
  SyncLaneStallKind,
} from "../../shared/sync-burndown-contract.js";
import type {
  SyncBurndownQuery,
  SyncBurndownStoreSample,
} from "../database/sync-burndown-store.js";

/** Default sample cadence. Slow on purpose: this is a trend, not a heartbeat. */
export const SYNC_BURNDOWN_INTERVAL_MS = 60_000;

/** The store read the reporter needs, as reachable through the db-host proxy. */
export type SyncBurndownSource = {
  readSyncBurndown?: (
    query: SyncBurndownQuery
  ) => Promise<SyncBurndownStoreSample>;
};

/** Severity for the reporter's own output. Mirrors the gateway logger's levels. */
export const SyncBurndownLogLevel = {
  Info: "info",
  Warn: "warn",
} as const;
export type SyncBurndownLogLevel =
  (typeof SyncBurndownLogLevel)[keyof typeof SyncBurndownLogLevel];

/** What a detected stall reports to the monitored sink. */
export type SyncLaneStallReport = {
  lane: SyncLaneId;
  workCompletedSincePrevious: number;
  durableCursorAgeMs: number | null;
  deadLetteredCount: number;
  /**
   * ISS-5973: WHY the stall was raised. OPTIONAL so a sink built against the
   * pre-ISS-5973 shape keeps compiling and keeps working; a consumer that does
   * not recognise the value must fall back to the cursor-frozen wording rather
   * than drop the alert.
   */
  kind?: SyncLaneStallKind;
  /**
   * ISS-5973: items the lane still owed when the stall was raised, where the
   * lane counts a queue. `null` when the lane has no per-item queue or the count
   * was unmeasurable — never a fabricated 0.
   */
  itemsRemaining?: number | null;
  /**
   * ISS-5973: true when {@link itemsRemaining} is a FLOOR, because the lane's
   * probe is bounded and hit its cap. Carried into the alert so a 3,500-session
   * backlog cannot be reported as an exact, reassuring `200`. OPTIONAL and
   * defaulting to exact, for the same version-skew reason as {@link kind}.
   */
  itemsRemainingIsLowerBound?: boolean;
};

export type SyncBurndownReporterOptions = {
  /** The live SQLite sync source, or null until the db host is ready. */
  getSource: () => SyncBurndownSource | null;
  /** `agent_sessions:<computeTargetId>`, or null with no live target. */
  getSessionSourceKey: () => string | null;
  /** `agent_component_invocations:<computeTargetId>` — the DELIVERY key. */
  getInvocationSourceKey: () => string | null;
  /** The unscoped template key the invocation lane clones from. */
  invocationTemplateSourceKey: string;
  /** `agent_components:<revision>:<computeTargetId>`, or null. */
  getComponentSourceKey: () => string | null;
  /**
   * The RAW compute target id the transcript lane settles against. The
   * transcript ledger has no `source_key`, so this is what separates archives
   * already delivered for the current target from those a previous target
   * settled and this one is still owed.
   */
  getTranscriptComputeTargetId: () => string | null;
  /** Per-lane live gates: is the lane actually able to deliver right now? */
  isSessionLaneRunning: () => boolean;
  isInvocationLaneRunning: () => boolean;
  isTranscriptLaneRunning: () => boolean;
  isComponentLaneRunning: () => boolean;
  /**
   * Is the trace-comment lane able to deliver? Its gate is the single most
   * likely reason for a backlog on this lane: no first-party session or no API
   * origin and every pending comment simply sits there, which is
   * `idle_not_running`, not `drained`.
   */
  isTraceCommentLaneRunning: () => boolean;
  log: (level: SyncBurndownLogLevel, message: string) => void;
  /**
   * A lane is completing work its durable cursor is not recording. A raw log is
   * not an alert, so this routes to the caller's existing monitored sink rather
   * than inventing one here.
   */
  onLaneStall?: (report: SyncLaneStallReport) => void;
  intervalMs?: number;
  now?: () => Date;
};

type LaneActivity = {
  /** Units the lane was observed completing since the last sample. */
  workCompleted: number;
  /** Bytes the lane put on the wire since the last sample, or null when uncounted. */
  bytesSent: number | null;
};

/**
 * The identity every count in one sample belongs to. Captured ONCE per sample
 * and threaded through, never re-read after an await: the compute target can
 * change mid-sample, and a snapshot that queried target A's queues but labelled
 * them with target B's keys is a fabricated reading, not a stale one.
 */
type SyncBurndownScope = {
  sessionSourceKey: string | null;
  invocationSourceKey: string | null;
  componentSourceKey: string | null;
  transcriptComputeTargetId: string | null;
};

function isSameScope(a: SyncBurndownScope, b: SyncBurndownScope): boolean {
  return (
    a.sessionSourceKey === b.sessionSourceKey &&
    a.invocationSourceKey === b.invocationSourceKey &&
    a.componentSourceKey === b.componentSourceKey &&
    a.transcriptComputeTargetId === b.transcriptComputeTargetId
  );
}

function ageMsFrom(iso: string | null, nowMs: number): number | null {
  if (iso === null) {
    return null;
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    // A timestamp that will not parse cannot be aged. `null` reads as "unknown"
    // in the formatter, which is the truth; a fabricated `0` would read as
    // "brand new" and is exactly the reassuring lie this reporter exists to stop.
    return null;
  }
  return Math.max(0, nowMs - parsed);
}

function positiveDelta(
  previous: number | null | undefined,
  current: number
): number {
  if (previous === null || previous === undefined) {
    return 0;
  }
  return Math.max(0, previous - current);
}

/**
 * The periodic burn-down sampler. One instance per application; `start()` and
 * `stop()` are idempotent and the timer is `unref`'d, so a missed `stop()` can
 * never be the reason the process refuses to exit.
 */
export class SyncBurndownReporter {
  private readonly options: SyncBurndownReporterOptions;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private sampling = false;
  private previous: SyncBurndownSnapshot | null = null;
  private previousStore: SyncBurndownStoreSample | null = null;
  /**
   * The last all-lanes verdict emitted, or `null` before the first sample. It
   * starts `null` rather than `false` on purpose: booting into a NOT-synced
   * state is itself the answer to "am I caught up?", and a `false` seed would
   * swallow it as "no change" and say nothing at all.
   */
  private previousAllSynced: boolean | null = null;
  private readonly emittedState = new Map<SyncLaneId, SyncLaneDrainState>();
  private readonly everRunningLanes = new Set<SyncLaneId>();
  /** Lanes whose stall has already been reported to the monitored sink this episode. */
  private readonly stalledLanes = new Set<SyncLaneId>();
  /**
   * ISS-5973: consecutive samples in which each lane was `Draining` and completed
   * zero work. Bounded by the lane set, so it cannot grow without bound.
   */
  private readonly zeroWorkSamples = new Map<SyncLaneId, number>();
  /** Lanes whose NO-PROGRESS stall has already been reported this episode. */
  private readonly noProgressLanes = new Set<SyncLaneId>();
  private sessionBatchSuccesses = 0;
  private sessionBytesSent = 0;
  private invocationPartsSent = 0;
  private componentRecordsSent = 0;
  /** The identity the previous sample's counts and baselines belong to. */
  private previousScope: SyncBurndownScope | null = null;
  /**
   * Bumped on every `start()` and `stop()`. A sample captures it before its
   * await and discards its own result if it no longer matches, so a read still
   * in flight when the reporter stops can never repopulate the state `stop()`
   * just cleared or attribute pre-stop activity to a later run.
   */
  private lifecycle = 0;

  constructor(options: SyncBurndownReporterOptions) {
    this.options = options;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.lifecycle += 1;
    const intervalMs = this.options.intervalMs ?? SYNC_BURNDOWN_INTERVAL_MS;
    this.timer = setInterval(() => {
      // `sampleOnce` swallows its own failures, so this can only settle. The
      // explicit no-op catch is belt-and-braces: an unhandled rejection from a
      // DIAGNOSTIC timer must never be able to take the app down.
      this.sampleOnce().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  /**
   * Stop sampling and forget everything this run observed. The state is NOT
   * kept for a later `start()`: baselines, emitted-state latches, and activity
   * counters all describe a lifecycle that has ended, and carrying them across a
   * restart would either suppress a fresh transition as "no change" or credit
   * pre-stop work to the new run's first diff.
   */
  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lifecycle += 1;
    this.previous = null;
    this.previousStore = null;
    this.previousScope = null;
    this.previousAllSynced = null;
    this.emittedState.clear();
    this.everRunningLanes.clear();
    this.stalledLanes.clear();
    this.zeroWorkSamples.clear();
    this.noProgressLanes.clear();
    this.resetActivityCounters();
  }

  /**
   * Tee from the session lane's EXISTING per-batch transport telemetry. Counts
   * accepted batches and the bytes every batch put on the wire — including
   * failed and dead-lettered ones, because a batch that cost bytes and delivered
   * nothing is precisely the re-send amplification this is here to expose.
   */
  recordSessionBatch(input: { accepted: boolean; payloadBytes: number }): void {
    if (Number.isFinite(input.payloadBytes) && input.payloadBytes > 0) {
      this.sessionBytesSent += input.payloadBytes;
    }
    if (input.accepted) {
      this.sessionBatchSuccesses += 1;
    }
  }

  /** Tee from the invocation lane's send path: one part attempted. */
  recordInvocationPartSent(): void {
    this.invocationPartsSent += 1;
  }

  /** Tee from the component-inventory lane's send path: N records attempted. */
  recordComponentRecordsSent(count: number): void {
    if (Number.isFinite(count) && count > 0) {
      this.componentRecordsSent += count;
    }
  }

  /**
   * Take one sample and emit whatever it warrants. Safe to call directly (tests
   * drive it this way); overlapping calls are coalesced so a slow read can never
   * stack samples on top of each other.
   */
  async sampleOnce(): Promise<void> {
    if (this.sampling) {
      return;
    }
    const source = this.options.getSource();
    if (!source?.readSyncBurndown) {
      // No db host yet. Consume nothing and reset nothing: the counters keep
      // accumulating so the first real sample reports the work that happened
      // while the store was unavailable, rather than silently discarding it.
      return;
    }
    this.sampling = true;
    const lifecycle = this.lifecycle;
    // Resolve the sample's identity ONCE, before the read. `buildSnapshot` is
    // handed this same object rather than re-reading the getters after the
    // await, so every count, cursor, and lane label in one snapshot belongs to
    // one target.
    const scope: SyncBurndownScope = {
      sessionSourceKey: this.options.getSessionSourceKey(),
      invocationSourceKey: this.options.getInvocationSourceKey(),
      componentSourceKey: this.options.getComponentSourceKey(),
      transcriptComputeTargetId: this.options.getTranscriptComputeTargetId(),
    };
    try {
      const store = await source.readSyncBurndown({
        sessionSourceKey: scope.sessionSourceKey,
        invocationSourceKey: scope.invocationSourceKey,
        invocationTemplateSourceKey: this.options.invocationTemplateSourceKey,
        componentSourceKey: scope.componentSourceKey,
        transcriptComputeTargetId: scope.transcriptComputeTargetId,
        // ISS-5973: the backoff boundary the outbox reads split ready work from
        // deferred work on. Resolved from the reporter's own clock, so a test can
        // pin it and so every lane in one sample uses one instant.
        nowIso: (this.options.now?.() ?? new Date()).toISOString(),
      });
      if (lifecycle !== this.lifecycle) {
        // The reporter was stopped (or restarted) while this read was in
        // flight. Its result describes the previous lifecycle; publishing it
        // would resurrect state `stop()` cleared.
        return;
      }
      if (
        this.previousScope !== null &&
        !isSameScope(this.previousScope, scope)
      ) {
        this.discardCrossTargetBaselines();
      }
      const snapshot = this.buildSnapshot(store, scope);
      this.emit(snapshot);
      this.previous = snapshot;
      this.previousStore = store;
      this.previousScope = scope;
      this.resetActivityCounters();
    } catch {
      // A failed diagnostic read must never disturb a sync lane. The counters
      // are deliberately NOT reset, so the work they hold is reported by the
      // next successful sample instead of being lost.
    } finally {
      this.sampling = false;
    }
  }

  /**
   * The most recent sample, or `null` when there is not one to report.
   *
   * ISS-5477 reads this to decide whether the renderer may switch its read
   * source to the cloud, so the `null` cases are load-bearing rather than
   * incidental: before the first sample, after `stop()`, and after a compute
   * target change (`discardCrossTargetBaselines`) there is no honest answer to
   * "is this account caught up?" — and an absent answer must never be read as a
   * drained one. The consumer treats `null` as UNKNOWN and stays local.
   *
   * Strictly an accessor: it takes no sample, so a reader can never make this
   * observer participate in the lanes it measures.
   */
  getLatestSnapshot(): SyncBurndownSnapshot | null {
    if (this.previous === null || this.previousScope === null) {
      return null;
    }
    // Re-check the identity the snapshot was taken under. `previous` survives
    // between samples, so after an account switch it still describes the OLD
    // compute target's queues — and reporting one account's drained verdict for
    // another is exactly the mis-attribution `main/sync/AGENTS.md` invariant 2
    // forbids. Getter calls only; this issues no store read.
    const current: SyncBurndownScope = {
      sessionSourceKey: this.options.getSessionSourceKey(),
      invocationSourceKey: this.options.getInvocationSourceKey(),
      componentSourceKey: this.options.getComponentSourceKey(),
      transcriptComputeTargetId: this.options.getTranscriptComputeTargetId(),
    };
    return isSameScope(this.previousScope, current) ? this.previous : null;
  }

  private resetActivityCounters(): void {
    this.sessionBatchSuccesses = 0;
    this.sessionBytesSent = 0;
    this.invocationPartsSent = 0;
    this.componentRecordsSent = 0;
  }

  /**
   * The compute target changed between samples. Every per-pass counter and
   * every baseline now on hand was accumulated under the PREVIOUS target, and
   * the tees that fed them carry no target of their own — so diffing across the
   * boundary would pair target A's completed-work counts with target B's cursor
   * state and could raise a stall under the wrong telemetry identity. There is
   * no honest way to attribute that work, so it is dropped rather than
   * reassigned, and the next sample re-baselines against the new target.
   */
  private discardCrossTargetBaselines(): void {
    this.previous = null;
    this.previousStore = null;
    this.previousAllSynced = null;
    this.emittedState.clear();
    this.stalledLanes.clear();
    this.zeroWorkSamples.clear();
    this.noProgressLanes.clear();
    this.resetActivityCounters();
  }

  private buildSnapshot(
    store: SyncBurndownStoreSample,
    scope: SyncBurndownScope
  ): SyncBurndownSnapshot {
    const now = this.options.now?.() ?? new Date();
    const nowMs = now.getTime();
    const sessionCursor =
      scope.sessionSourceKey === null
        ? undefined
        : store.cursorsBySourceKey[scope.sessionSourceKey];
    const componentCursor =
      scope.componentSourceKey === null
        ? undefined
        : store.cursorsBySourceKey[scope.componentSourceKey];

    const lanes: SyncLaneBurndown[] = [
      this.buildSessionLane(store, nowMs, sessionCursor),
      this.buildInvocationLane(store, nowMs),
      this.buildTranscriptLane(store, nowMs),
      this.buildComponentLane(store, nowMs, componentCursor),
      this.buildTraceCommentLane(store, nowMs),
    ];
    return { sampledAtIso: now.toISOString(), lanes };
  }

  private buildSessionLane(
    store: SyncBurndownStoreSample,
    nowMs: number,
    cursor:
      | { observedTopUpdatedAt: string | null; updatedAt: string }
      | undefined
  ): SyncLaneBurndown {
    const counts = store.sessionOutbox;
    const activity: LaneActivity = {
      workCompleted: this.sessionBatchSuccesses,
      bytesSent: this.sessionBytesSent,
    };
    return this.finishLane({
      lane: SyncLaneId.SessionMetadata,
      running: this.options.isSessionLaneRunning(),
      itemsRemaining: counts.pending,
      readyItemsRemaining: counts.readyPending,
      unmeasuredRows: counts.unmeasuredRows,
      // The session outbox stores no payload size, so bytes-remaining is
      // genuinely unknown here rather than zero.
      bytesRemaining: null,
      chunksRemaining: null,
      deadLetteredCount: counts.deadLettered,
      oldestPendingSinceIso: counts.oldestPendingEnqueuedAtIso,
      oldestPendingBasis: OldestPendingBasisValues.EnqueuedAt,
      tracksDurableCursor: true,
      cursorValue: cursor?.observedTopUpdatedAt ?? null,
      cursorWrittenAtIso: cursor?.updatedAt ?? null,
      activity,
      nowMs,
    });
  }

  private buildInvocationLane(
    store: SyncBurndownStoreSample,
    nowMs: number
  ): SyncLaneBurndown {
    const counts = store.invocationOutbox;
    // Remaining is parts already materialized PLUS sessions still awaiting
    // materialization: an empty delivery queue with templates left to clone is
    // not drained. Both are scoped to this lane's own keys and predicate, so a
    // template row can never be counted as a delivery backlog.
    const itemsRemaining = counts.pendingParts + counts.pendingTemplateSessions;
    return this.finishLane({
      lane: SyncLaneId.InvocationParts,
      running: this.options.isInvocationLaneRunning(),
      itemsRemaining,
      // The template probe is bounded, so when it caps out this total is a
      // FLOOR. The store already knows; dropping that here is what turned a
      // 3,500-session backlog into a reassuring `items=200`.
      itemsRemainingIsLowerBound: counts.pendingTemplateSessionsTruncated,
      // Templates carry no retry deadline of their own — a session awaiting
      // materialization is eligible the moment it is counted — so the lane's
      // eligible-now depth is the ready PARTS plus all of them.
      readyItemsRemaining: counts.readyPending + counts.pendingTemplateSessions,
      unmeasuredRows: counts.unmeasuredRows,
      bytesRemaining: counts.pendingPayloadBytes,
      chunksRemaining: counts.pendingParts,
      deadLetteredCount: counts.deadLettered,
      oldestPendingSinceIso: counts.oldestPendingEnqueuedAtIso,
      oldestPendingBasis: OldestPendingBasisValues.EnqueuedAt,
      // This lane's cursors live in `agent_component_invocation_sync_cursors`,
      // not `sync_state`; it keeps no watermark of the kind reported here.
      tracksDurableCursor: false,
      cursorValue: null,
      cursorWrittenAtIso: null,
      activity: {
        workCompleted: this.invocationPartsSent,
        // Byte cost is counted by the store, not on the send path — no wire
        // counter exists here, so claiming one would be a fabrication.
        bytesSent: null,
      },
      nowMs,
    });
  }

  private buildTranscriptLane(
    store: SyncBurndownStoreSample,
    nowMs: number
  ): SyncLaneBurndown {
    const counts = store.transcript;
    const previous = this.previousStore?.transcript;
    // This lane has no send-path tee, so its per-pass numbers are derived from
    // the ledger itself: files that stopped being in flight, and bytes that
    // stopped being outstanding. The archive protocol appends by byte offset,
    // so a shrinking remainder IS bytes delivered.
    return this.finishLane({
      lane: SyncLaneId.TranscriptArchive,
      running: this.options.isTranscriptLaneRunning(),
      itemsRemaining: counts.inFlightFiles + counts.strandedIdleFiles,
      unmeasuredRows: counts.unmeasuredRows,
      bytesRemaining: counts.bytesRemaining,
      chunksRemaining: null,
      deadLetteredCount: counts.deadFiles,
      oldestPendingSinceIso: counts.oldestInFlightUpdatedAtIso,
      oldestPendingBasis: OldestPendingBasisValues.LastStateChange,
      // Durable state here is a per-file byte offset, not a `sync_state` row.
      tracksDurableCursor: false,
      cursorValue: null,
      cursorWrittenAtIso: null,
      activity: {
        workCompleted: positiveDelta(
          previous?.inFlightFiles,
          counts.inFlightFiles
        ),
        bytesSent: positiveDelta(
          previous?.bytesRemaining,
          counts.bytesRemaining
        ),
      },
      nowMs,
    });
  }

  private buildComponentLane(
    store: SyncBurndownStoreSample,
    nowMs: number,
    cursor:
      | { observedTopUpdatedAt: string | null; updatedAt: string }
      | undefined
  ): SyncLaneBurndown {
    // A cursor SWEEP keeps no queue table, but it is NOT unmeasurable: the rows
    // sitting past its keyset are countable with the lane's own predicate, and
    // that count is what makes a first backfill visible. Reporting `null` here
    // used to collapse to "nothing owed" in the classifier, so a gate-open lane
    // mid-backfill landed in `drained` and the app printed ALL LANES FULLY
    // SYNCED while thousands of components had never been sent. `null` now
    // survives as `remaining_unknown`, and is reached only when the lane has no
    // compute target to measure against.
    const counts = store.componentInventory;
    return this.finishLane({
      lane: SyncLaneId.ComponentInventory,
      running: this.options.isComponentLaneRunning(),
      itemsRemaining: counts.rowsRemaining,
      bytesRemaining: null,
      chunksRemaining: null,
      // Durable dead-letters, read from `sync_state.dead_lettered_ids` — the
      // lane's in-memory boundary tracker is process-scoped, but the ids it
      // ABANDONED are persisted, and a lane that gave up is not caught up.
      deadLetteredCount: counts.deadLetteredCount,
      oldestPendingSinceIso: null,
      oldestPendingBasis: OldestPendingBasisValues.EnqueuedAt,
      tracksDurableCursor: true,
      cursorValue: cursor?.observedTopUpdatedAt ?? null,
      cursorWrittenAtIso: cursor?.updatedAt ?? null,
      activity: {
        workCompleted: this.componentRecordsSent,
        bytesSent: null,
      },
      nowMs,
    });
  }

  /**
   * The fifth lane (`main/sync/AGENTS.md`). It has no send-path tee and no
   * durable cursor: its queue lives on the entity row, so depth is the pending
   * status count and per-pass progress is that count shrinking.
   *
   * `deadLetteredCount` is a REAL, permanent zero here, not an unmeasured one:
   * this lane has no give-up state at all, so a comment the server keeps
   * rejecting retries every 10 seconds forever and shows as `draining`
   * indefinitely rather than ever reaching `drained_with_dead_letters`. An
   * operator will never get an "abandoned" line from this lane — a backlog that
   * never shrinks is the signal to read.
   */
  private buildTraceCommentLane(
    store: SyncBurndownStoreSample,
    nowMs: number
  ): SyncLaneBurndown {
    const counts = store.traceComments;
    const previous = this.previousStore?.traceComments;
    const itemsRemaining = counts.pendingComments + counts.pendingReplyComments;
    const previousRemaining =
      previous === undefined
        ? null
        : previous.pendingComments + previous.pendingReplyComments;
    return this.finishLane({
      lane: SyncLaneId.TraceComments,
      running: this.options.isTraceCommentLaneRunning(),
      itemsRemaining,
      unmeasuredRows: counts.unmeasuredRows,
      bytesRemaining: null,
      chunksRemaining: null,
      deadLetteredCount: 0,
      oldestPendingSinceIso: counts.oldestPendingCreatedAtIso,
      oldestPendingBasis: OldestPendingBasisValues.EnqueuedAt,
      tracksDurableCursor: false,
      cursorValue: null,
      cursorWrittenAtIso: null,
      activity: {
        workCompleted: positiveDelta(previousRemaining, itemsRemaining),
        bytesSent: null,
      },
      nowMs,
    });
  }

  private finishLane(input: {
    lane: SyncLaneId;
    running: boolean;
    itemsRemaining: number | null;
    itemsRemainingIsLowerBound?: boolean;
    /**
     * Eligible-now depth. Omitted by the lanes that keep no per-row retry
     * deadline, where it stays `null` — "cannot tell", never "none ready".
     */
    readyItemsRemaining?: number | null;
    unmeasuredRows?: number;
    bytesRemaining: number | null;
    chunksRemaining: number | null;
    deadLetteredCount: number;
    oldestPendingSinceIso: string | null;
    oldestPendingBasis: OldestPendingBasis;
    tracksDurableCursor: boolean;
    cursorValue: string | null;
    cursorWrittenAtIso: string | null;
    activity: LaneActivity;
    nowMs: number;
  }): SyncLaneBurndown {
    // "Never started" vs "started but idle" is tracked by OBSERVATION: a lane
    // seen running even once this launch can never fall back to `never_started`,
    // so a lane that goes offline reports `idle_not_running` — the honest
    // distinction between "has not looked yet" and "has stopped trying".
    if (input.running) {
      this.everRunningLanes.add(input.lane);
    }
    const unmeasuredRows = input.unmeasuredRows ?? 0;
    const state = classifyLaneDrainState({
      started: this.everRunningLanes.has(input.lane),
      gateOpen: input.running,
      itemsRemaining: input.itemsRemaining,
      deadLetteredCount: input.deadLetteredCount,
      unmeasuredRows,
    });
    return {
      lane: input.lane,
      state,
      itemsRemaining: input.itemsRemaining,
      itemsRemainingIsLowerBound: input.itemsRemainingIsLowerBound ?? false,
      readyItemsRemaining: input.readyItemsRemaining ?? null,
      unmeasuredRows,
      bytesRemaining: input.bytesRemaining,
      chunksRemaining: input.chunksRemaining,
      deadLetteredCount: input.deadLetteredCount,
      oldestPendingSinceIso: input.oldestPendingSinceIso,
      oldestPendingBasis: input.oldestPendingBasis,
      oldestPendingAgeMs: ageMsFrom(input.oldestPendingSinceIso, input.nowMs),
      tracksDurableCursor: input.tracksDurableCursor,
      durableCursorValue: input.cursorValue,
      durableCursorWrittenAtIso: input.cursorWrittenAtIso,
      durableCursorAgeMs: ageMsFrom(input.cursorWrittenAtIso, input.nowMs),
      workCompletedSincePrevious: input.activity.workCompleted,
      bytesSentSincePrevious: input.activity.bytesSent,
    };
  }

  private emit(snapshot: SyncBurndownSnapshot): void {
    for (const lane of snapshot.lanes) {
      this.emitLane(lane);
    }
    this.emitAllLanesVerdict(snapshot);
  }

  private emitLane(lane: SyncLaneBurndown): void {
    const previousState = this.emittedState.get(lane.lane);
    const stateChanged = previousState !== lane.state;
    if (stateChanged || lane.state === SyncLaneDrainState.Draining) {
      this.options.log(SyncBurndownLogLevel.Info, formatLaneBurndownLine(lane));
    }
    if (stateChanged) {
      this.emitLaneVerdict(lane);
      this.emittedState.set(lane.lane, lane.state);
    }
    this.maybeWarnCursorStall(lane);
    this.maybeWarnNoProgress(lane);
  }

  /**
   * ISS-5973: the lane is running, still owes work, and is completing none of it.
   *
   * Kept separate from {@link maybeWarnCursorStall} rather than folded into it:
   * the two detectors have mutually exclusive preconditions (that one requires
   * work completed > 0, this one requires exactly 0), they latch independently,
   * and an operator acts on them differently — a frozen cursor means uploads are
   * landing but not being recorded, a no-progress lane means nothing is being
   * uploaded at all.
   */
  private maybeWarnNoProgress(lane: SyncLaneBurndown): void {
    const previousLane =
      this.previous?.lanes.find((entry) => entry.lane === lane.lane) ?? null;
    const isZeroWorkSample =
      lane.state === SyncLaneDrainState.Draining &&
      (lane.workCompletedSincePrevious ?? 0) <= 0;
    if (!isZeroWorkSample) {
      // Progress, or the lane left `Draining`. Re-arm so a stall that recurs
      // after a genuine advance is reported again.
      this.zeroWorkSamples.delete(lane.lane);
      this.noProgressLanes.delete(lane.lane);
      return;
    }
    const consecutiveZeroWorkSamples =
      (this.zeroWorkSamples.get(lane.lane) ?? 0) + 1;
    this.zeroWorkSamples.set(lane.lane, consecutiveZeroWorkSamples);
    if (
      !detectNoProgressStall({
        previous: previousLane,
        current: lane,
        consecutiveZeroWorkSamples,
      })
    ) {
      return;
    }
    this.options.log(
      SyncBurndownLogLevel.Warn,
      formatNoProgressStallLine(lane)
    );
    if (this.noProgressLanes.has(lane.lane)) {
      // Already reported this episode; the warn line above still carries the
      // trend every sample, but the monitored signal fires once.
      return;
    }
    this.noProgressLanes.add(lane.lane);
    this.options.onLaneStall?.({
      lane: lane.lane,
      workCompletedSincePrevious: 0,
      durableCursorAgeMs: lane.durableCursorAgeMs,
      deadLetteredCount: lane.deadLetteredCount,
      kind: SyncLaneStallKind.NoProgress,
      itemsRemaining: lane.itemsRemaining,
      itemsRemainingIsLowerBound: lane.itemsRemainingIsLowerBound,
    });
  }

  private emitLaneVerdict(lane: SyncLaneBurndown): void {
    if (lane.state === SyncLaneDrainState.Drained) {
      this.options.log(
        SyncBurndownLogLevel.Info,
        formatLaneFullySyncedLine(lane)
      );
      return;
    }
    if (lane.state === SyncLaneDrainState.DrainedWithDeadLetters) {
      this.options.log(
        SyncBurndownLogLevel.Warn,
        formatLaneDrainedWithDeadLettersLine(lane)
      );
      return;
    }
    if (lane.state === SyncLaneDrainState.RemainingUnknown) {
      this.options.log(
        SyncBurndownLogLevel.Warn,
        formatLaneRemainingUnknownLine(lane)
      );
    }
  }

  private maybeWarnCursorStall(lane: SyncLaneBurndown): void {
    const previousLane =
      this.previous?.lanes.find((entry) => entry.lane === lane.lane) ?? null;
    if (!detectCursorStall({ previous: previousLane, current: lane })) {
      // The cursor moved (or the lane went quiet). Re-arm, so a stall that
      // recurs after a genuine advance is reported again instead of being
      // suppressed by the previous episode's latch.
      this.stalledLanes.delete(lane.lane);
      return;
    }
    this.options.log(SyncBurndownLogLevel.Warn, formatCursorStallLine(lane));
    if (this.stalledLanes.has(lane.lane)) {
      // Already reported this episode. The warn line above still goes to the
      // log every sample (it is the trend), but the monitored signal fires once
      // per episode so a multi-hour stall is one alert, not one an interval.
      return;
    }
    this.stalledLanes.add(lane.lane);
    this.options.onLaneStall?.({
      lane: lane.lane,
      workCompletedSincePrevious: lane.workCompletedSincePrevious ?? 0,
      durableCursorAgeMs: lane.durableCursorAgeMs,
      deadLetteredCount: lane.deadLetteredCount,
      kind: SyncLaneStallKind.CursorFrozen,
      itemsRemaining: lane.itemsRemaining,
      itemsRemainingIsLowerBound: lane.itemsRemainingIsLowerBound,
    });
  }

  private emitAllLanesVerdict(snapshot: SyncBurndownSnapshot): void {
    const allSynced = areAllLanesFullySynced(snapshot.lanes);
    if (allSynced === this.previousAllSynced) {
      return;
    }
    this.previousAllSynced = allSynced;
    this.options.log(
      allSynced ? SyncBurndownLogLevel.Info : SyncBurndownLogLevel.Warn,
      formatAllLanesVerdictLine(snapshot.lanes)
    );
  }
}
