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
  formatAllLanesVerdictLine,
  formatLaneBurndownLine,
  formatLaneDrainedWithDeadLettersLine,
  formatLaneFullySyncedLine,
  formatLaneRemainingUnknownLine,
  OldestPendingBasis as OldestPendingBasisValues,
  remainderIsMeasured,
  type SyncBurndownSnapshot,
  type SyncLaneBurndown,
  SyncLaneDeadLetteredBasis,
  SyncLaneDrainState,
  SyncLaneId,
  SyncLaneRemainderBasis,
} from "../../shared/sync-burndown-contract.js";
import type { SessionCursorBoundary } from "../agent-sync/agent-session-sync-cursor-prefix.js";
import type { OutboxResumeOutcome } from "../agent-sync/session-outbox-engine-state.js";
import { SessionResumeHealth } from "../agent-sync/session-resume-health.js";
import type {
  SyncBurndownQuery,
  SyncBurndownStoreSample,
} from "../database/sync-burndown-store.js";
import type { SignedInUserIdentity } from "../util/user-identity.js";
import type {
  LaneActivity,
  SyncBurndownLaneInput,
} from "./sync-burndown-lane-input.js";
import {
  type SyncLaneStallReport,
  SyncLaneStallWatcher,
} from "./sync-burndown-stall-detectors.js";

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
  /**
   * ISS-7096: the signed-in pair, so the invocation lane's remainder leaves out
   * template sessions another identity owns, which promotion never sends. Null
   * filters nothing, matching promotion.
   */
  getIdentity: () => SignedInUserIdentity | null;
  /**
   * ISS-10429: the row the session lane's durable cursor is waiting on, read
   * from the lane's in-memory queues. Optional: without it the session lane
   * reports no boundary, and `detectCursorStall` keeps the verdict it had
   * before ISS-10429.
   */
  readSessionCursorBoundary?: () => SessionCursorBoundary | null;
  /** Per-lane live gates: is the lane actually able to deliver right now? */
  isSessionLaneRunning: () => boolean;
  isInvocationLaneRunning: () => boolean;
  isTranscriptLaneRunning: () => boolean;
  isComponentLaneRunning: () => boolean;
  /**
   * ISS-8768: does this machine's persisted consent say THIS LANE should be
   * delivering? Read SEPARATELY from the `running` gates above, because it is the
   * only thing that separates a shut gate a user ASKED for from one that closed
   * on them — see {@link SyncLaneStallWatcher}, which consumes this.
   *
   * PER-LANE, and that is load-bearing rather than tidiness: the lanes do not
   * share one consent axis. `metadata` tier permits session metadata while
   * DELIBERATELY keeping transcripts local, so a single machine-wide predicate
   * reports a metadata-tier user's transcript lane as consented-but-gated and
   * pages them for the configuration they chose — the exact noise this detector's
   * consent check exists to prevent.
   *
   * Required rather than optional so a new construction site has to answer it: an
   * option defaulting to `false` would silently disarm the detector.
   */
  isLaneDeliveryConsented: (lane: SyncLaneId) => boolean;
  log: (level: SyncBurndownLogLevel, message: string) => void;
  /**
   * A lane is completing work its durable cursor is not recording. A raw log is
   * not an alert, so this routes to the caller's existing monitored sink rather
   * than inventing one here.
   */
  onLaneStall?: (report: SyncLaneStallReport) => void;
  /**
   * ISS-9246: the whole sample, for promotion to telemetry. Fires on EVERY
   * sample, unlike {@link SyncBurndownReporterOptions.log}, whose emission
   * policy is deliberately periodic-and-on-transition so an operator's log is
   * not flooded. A gauge has the opposite requirement: the metrics pipeline is
   * cumulative, so a series that skips a sample is carried forward at its last
   * value, and a lane that quietly drained would keep publishing a backlog it no
   * longer has.
   */
  onSample?: (snapshot: SyncBurndownSnapshot) => void;
  intervalMs?: number;
  now?: () => Date;
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
  /**
   * Compared too: on an unpaired machine every key is null for every identity,
   * yet the identity decides which template sessions the invocation lane owes.
   */
  identity: SignedInUserIdentity | null;
};

function isSameScope(a: SyncBurndownScope, b: SyncBurndownScope): boolean {
  return (
    a.sessionSourceKey === b.sessionSourceKey &&
    a.invocationSourceKey === b.invocationSourceKey &&
    a.componentSourceKey === b.componentSourceKey &&
    a.transcriptComputeTargetId === b.transcriptComputeTargetId &&
    a.identity?.userId === b.identity?.userId &&
    a.identity?.organizationId === b.identity?.organizationId
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
  /**
   * The four stall conditions and the per-lane episode state each keeps across
   * samples (ISS-9823). A collaborator rather than four more fields here: the
   * reporter samples and reports a burn-down, and judging a lane against a
   * stall condition is its own responsibility with its own tally, latch and
   * throttle rules — see `sync-burndown-stall-detectors.ts`.
   */
  private readonly stallWatcher: SyncLaneStallWatcher;
  private sessionBatchSuccesses = 0;
  private sessionBytesSent = 0;
  /**
   * ISS-7401: outbox rows acks reported clearing since the last sample, or
   * `null` while NO accepted batch in this window reported a count at all.
   * Starts unmeasured on purpose: a zero here is published as a measured
   * "cleared nothing", so a window nobody counted must not manufacture one.
   */
  private sessionRowsCleared: number | null = null;
  private invocationPartsSent = 0;
  private componentRecordsSent = 0;
  /**
   * ISS-9823: whether the session lane's resume read is currently failing.
   *
   * A LEVEL, deliberately NOT a per-window counter and deliberately NOT cleared
   * by {@link resetActivityCounters}: that resets what one sampling window
   * observed, and this condition outlives a window by construction — clearing it
   * there would erase the fault between every sample and report the lane drained
   * again on the next one. It is cleared at the LIFECYCLE boundary only, and by
   * the lane's own `Seeded` outcome; the compute-target boundary deliberately
   * leaves it alone (see `discardCrossTargetBaselines`), because that boundary
   * is observed a window late and can only erase the incoming target's own
   * already-reported fault.
   */
  private readonly sessionResumeHealth = new SessionResumeHealth();
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
    this.stallWatcher = new SyncLaneStallWatcher({
      warn: (message) => options.log(SyncBurndownLogLevel.Warn, message),
      onLaneStall: options.onLaneStall,
      isLaneDeliveryConsented: (lane) => options.isLaneDeliveryConsented(lane),
      // Read per sample, not captured, so a reconfigured interval reaches the
      // throttle that computes its window from it.
      intervalMs: () => options.intervalMs ?? SYNC_BURNDOWN_INTERVAL_MS,
    });
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
    this.stallWatcher.clear();
    // ISS-9823: a LIFECYCLE boundary, so the level goes with everything else
    // this run observed. Not a per-window reset — see the field's docstring. A
    // fault that outlives the stop re-latches on the restarted lane's first
    // hydration tick, because a failed read re-arms `hydratedSourceKey`.
    this.sessionResumeHealth.clear();
    this.resetActivityCounters();
  }

  /**
   * ISS-9823 tee: what the session lane's once-per-identity resume hydration
   * answered on this pass.
   *
   * Folded into a level rather than counted. `ReadFailed` sets it, `Seeded`
   * clears it, and `Discarded` leaves it alone — a superseded identity is an
   * ordinary account or compute-target switch, and treating it as a fault would
   * report a blocked lane on every sign-in.
   */
  recordSessionResumeOutcome(outcome: OutboxResumeOutcome): void {
    this.sessionResumeHealth.record(outcome);
  }

  /**
   * Tee from the session lane's EXISTING per-batch transport telemetry. Counts
   * accepted batches and the bytes every batch put on the wire — including
   * failed and dead-lettered ones, because a batch that cost bytes and delivered
   * nothing is precisely the re-send amplification this is here to expose.
   */
  recordSessionBatch(input: {
    accepted: boolean;
    payloadBytes: number;
    /**
     * ISS-7401/ISS-7957: rows the ack's outbox delete ACTUALLY REMOVED — the
     * delete's own count, NOT the number of ids it was asked about. Those two
     * disagree exactly when an ack names an id whose row is already gone, and
     * this field used to carry the ack length. It is carried to the alert, and
     * the cursor-stall detector reads it only when the session lane's cursor
     * boundary also moved (ISS-10429). Optional: a caller that does not measure
     * one leaves it unmeasured rather than asserting zero deliveries.
     */
    durablyClearedRows?: number;
  }): void {
    if (Number.isFinite(input.payloadBytes) && input.payloadBytes > 0) {
      this.sessionBytesSent += input.payloadBytes;
    }
    if (!input.accepted) {
      return;
    }
    this.sessionBatchSuccesses += 1;
    const clearedRows = input.durablyClearedRows;
    // An OMITTED count leaves the window UNMEASURED; a REPORTED zero promotes it
    // to a measured zero. Collapsing the two publishes a caller that counted
    // nothing as one that measured no deliveries — the alarming reading, on the
    // alert whose whole job is telling those two populations apart. Non-finite
    // and negative are refused rather than tallied, same shape as the byte
    // counter above, so a nonsense value can never become part of a total.
    if (
      typeof clearedRows === "number" &&
      Number.isFinite(clearedRows) &&
      clearedRows >= 0
    ) {
      this.sessionRowsCleared = (this.sessionRowsCleared ?? 0) + clearedRows;
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
      identity: this.options.getIdentity(),
    };
    try {
      const store = await source.readSyncBurndown({
        sessionSourceKey: scope.sessionSourceKey,
        invocationSourceKey: scope.invocationSourceKey,
        invocationTemplateSourceKey: this.options.invocationTemplateSourceKey,
        componentSourceKey: scope.componentSourceKey,
        transcriptComputeTargetId: scope.transcriptComputeTargetId,
        identity: scope.identity,
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
      identity: this.options.getIdentity(),
    };
    return isSameScope(this.previousScope, current) ? this.previous : null;
  }

  private resetActivityCounters(): void {
    this.sessionBatchSuccesses = 0;
    this.sessionBytesSent = 0;
    // Back to UNMEASURED, not to zero: the next window has counted nothing yet.
    this.sessionRowsCleared = null;
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
    // Every stall episode re-baselines, the resume one included (ISS-9823):
    // an episode counted under the previous identity cannot be continued under
    // this one. That is a different question from the LEVEL below, which is
    // NOT cleared — an episode re-baseline delays an alert by a threshold's
    // worth of samples, whereas clearing the level would publish `drained` for
    // a lane already known to be wedged.
    this.stallWatcher.clear();
    // ISS-9823 review: the resume level is deliberately NOT cleared here. This
    // runs at SAMPLE time, one 60s window after the switch it is reacting to,
    // while the outcome is teed at the sync lane's own 5s tick — so the fault
    // most likely to be on the level by now is the INCOMING target's, recorded
    // by its first hydration. Clearing erased it and published `drained` for a
    // lane already known to be wedged, which is a whole window of the exact
    // false "up to date" this ticket exists to remove. Not clearing errs the
    // other way and does so safely: a healthy incoming target reports
    // `remaining_unknown` until its own hydration answers `Seeded`, which is one
    // tick away because a failed read re-arms `hydratedSourceKey`.
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
      this.buildSessionLane(
        store,
        nowMs,
        { durable: sessionCursor, sourceKey: scope.sessionSourceKey },
        deadLetteredBasisFor(
          scope.sessionSourceKey,
          SyncLaneDeadLetteredBasis.QueueStatusCount
        )
      ),
      this.buildInvocationLane(
        store,
        nowMs,
        deadLetteredBasisFor(
          scope.invocationSourceKey,
          SyncLaneDeadLetteredBasis.QueueStatusCount
        )
      ),
      this.buildTranscriptLane(store, nowMs),
      this.buildComponentLane(
        store,
        nowMs,
        componentCursor,
        deadLetteredBasisFor(
          scope.componentSourceKey,
          SyncLaneDeadLetteredBasis.AbandonedIdLedger
        )
      ),
    ];
    return { sampledAtIso: now.toISOString(), lanes };
  }

  private buildSessionLane(
    store: SyncBurndownStoreSample,
    nowMs: number,
    cursor: {
      durable:
        | { observedTopUpdatedAt: string | null; updatedAt: string }
        | undefined;
      sourceKey: string | null;
    },
    deadLetteredBasis: SyncLaneDeadLetteredBasis
  ): SyncLaneBurndown {
    const counts = store.sessionOutbox;
    const boundary = this.options.readSessionCursorBoundary?.() ?? null;
    const activity: LaneActivity = {
      workCompleted: this.sessionBatchSuccesses,
      bytesSent: this.sessionBytesSent,
      // ISS-7401: the only lane that durably deletes its own queue rows on ack.
      queueRowsCleared: this.sessionRowsCleared,
    };
    return this.finishLane({
      lane: SyncLaneId.SessionMetadata,
      running: this.options.isSessionLaneRunning(),
      remainderBasis: counts.remainderBasis,
      itemsRemaining: counts.pending,
      readyItemsRemaining: counts.readyPending,
      unmeasuredRows: counts.unmeasuredRows,
      // The session outbox stores no payload size, so bytes-remaining is
      // genuinely unknown here rather than zero.
      bytesRemaining: null,
      chunksRemaining: null,
      deadLetteredCount: counts.deadLettered,
      deadLetteredBasis,
      // ISS-9823: the only lane that can answer `true`. A failing resume read
      // abandons every pass before `enqueueIncrementalUpdates`, so `pending`
      // stays 0 on a caught-up device and every count below agrees the lane is
      // drained while nothing is leaving the machine.
      resumeBlocked: this.sessionResumeHealth.isResumeBlocked(),
      oldestPendingSinceIso: counts.oldestPendingSinceIso,
      oldestPendingBasis: OldestPendingBasisValues.PendingSince,
      tracksDurableCursor: true,
      cursorValue: cursor.durable?.observedTopUpdatedAt ?? null,
      cursorWrittenAtIso: cursor.durable?.updatedAt ?? null,
      // A boundary read under another identity describes a different queue
      // from the one this sample counted, so it is reported as unknown.
      cursorBoundaryValue:
        boundary?.sourceKey === cursor.sourceKey ? boundary.value : null,
      activity,
      nowMs,
      // ISS-7096: another environment's parked rows — reported, never owed.
      parkedCount: counts.parkedPending,
      // ISS-7246: sessions with nothing substantive to send yet — same posture.
      withheldCount: counts.withheld,
    });
  }

  private buildInvocationLane(
    store: SyncBurndownStoreSample,
    nowMs: number,
    deadLetteredBasis: SyncLaneDeadLetteredBasis
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
      remainderBasis: counts.remainderBasis,
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
      deadLetteredBasis,
      // ISS-9823: structural `false` — this lane runs no once-per-identity
      // resume hydration, so it has no such read to fail.
      resumeBlocked: false,
      oldestPendingSinceIso: counts.oldestPendingSinceIso,
      oldestPendingBasis: OldestPendingBasisValues.PendingSince,
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
      // ISS-7246: this lane never writes `withheld` (only the session lane
      // withholds), but reporting what the fold measured keeps a row carrying
      // that status from being counted nowhere.
      withheldCount: counts.withheld,
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
      // Unscoped ledger reads — this lane has no source key to be missing, so
      // its remainder is always read.
      remainderBasis: SyncLaneRemainderBasis.Counted,
      itemsRemaining: counts.inFlightFiles + counts.strandedIdleFiles,
      unmeasuredRows: counts.unmeasuredRows,
      bytesRemaining: counts.bytesRemaining,
      chunksRemaining: null,
      deadLetteredCount: counts.deadFiles,
      deadLetteredBasis: SyncLaneDeadLetteredBasis.QueueStatusCount,
      // ISS-9823: structural `false` — no once-per-identity resume read here.
      resumeBlocked: false,
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
      | undefined,
    deadLetteredBasis: SyncLaneDeadLetteredBasis
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
      remainderBasis: counts.remainderBasis,
      itemsRemaining: counts.rowsRemaining,
      bytesRemaining: null,
      chunksRemaining: null,
      // Durable dead-letters, read from `sync_state.dead_lettered_ids` — the
      // lane's in-memory boundary tracker is process-scoped, but the ids it
      // ABANDONED are persisted, and a lane that gave up is not caught up.
      deadLetteredCount: counts.deadLetteredCount,
      deadLetteredBasis,
      // ISS-9823: structural `false` — no once-per-identity resume read here.
      resumeBlocked: false,
      oldestPendingSinceIso: null,
      oldestPendingBasis: OldestPendingBasisValues.NoPerItemTimestamp,
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

  private finishLane(input: SyncBurndownLaneInput): SyncLaneBurndown {
    // "Never started" vs "started but idle" is tracked by OBSERVATION: a lane
    // seen running even once this launch can never fall back to `never_started`,
    // so a lane that goes offline reports `idle_not_running` — the honest
    // distinction between "has not looked yet" and "has stopped trying".
    if (input.running) {
      this.everRunningLanes.add(input.lane);
    }
    const unmeasuredRows = input.unmeasuredRows ?? 0;
    // ISS-10082: every remainder a lane could not read is published as `null` —
    // the value this contract already defines as "unknown" and every consumer
    // already handles — rather than as the placeholder zero the store returns.
    // Applied here rather than per lane so a lane added later cannot opt out.
    const measured = remainderIsMeasured(input.remainderBasis);
    const itemsRemaining = measured ? input.itemsRemaining : null;
    const readyItemsRemaining = measured
      ? (input.readyItemsRemaining ?? null)
      : null;
    // ISS-10082 review: the same placeholder, one column over. `parkedPending`
    // and `withheld` are folds over rows the store never read, and each field's
    // own contract says an absent count reads as unknown and NEVER as zero — so
    // an unread lane must not report "no parked work" for a partition nobody
    // counted.
    // `unmeasuredRows` is deliberately left at `0`: it is typed non-nullable and
    // the `null` remainder above already forces the verdict.
    const parkedCount = measured ? (input.parkedCount ?? null) : null;
    const withheldCount = measured ? (input.withheldCount ?? null) : null;
    const state = classifyLaneDrainState({
      started: this.everRunningLanes.has(input.lane),
      gateOpen: input.running,
      resumeBlocked: input.resumeBlocked,
      itemsRemaining,
      deadLetteredCount: input.deadLetteredCount,
      deadLetteredBasis: input.deadLetteredBasis,
      unmeasuredRows,
    });
    return {
      lane: input.lane,
      state,
      resumeBlocked: input.resumeBlocked,
      itemsRemaining,
      itemsRemainingIsLowerBound: input.itemsRemainingIsLowerBound ?? false,
      readyItemsRemaining,
      unmeasuredRows,
      bytesRemaining: measured ? input.bytesRemaining : null,
      chunksRemaining: measured ? input.chunksRemaining : null,
      deadLetteredCount: input.deadLetteredCount,
      deadLetteredBasis: input.deadLetteredBasis,
      remainderBasis: input.remainderBasis,
      oldestPendingSinceIso: input.oldestPendingSinceIso,
      oldestPendingBasis: input.oldestPendingBasis,
      oldestPendingAgeMs: ageMsFrom(input.oldestPendingSinceIso, input.nowMs),
      tracksDurableCursor: input.tracksDurableCursor,
      durableCursorValue: input.cursorValue,
      durableCursorWrittenAtIso: input.cursorWrittenAtIso,
      durableCursorAgeMs: ageMsFrom(input.cursorWrittenAtIso, input.nowMs),
      cursorBoundaryValue: input.cursorBoundaryValue ?? null,
      workCompletedSincePrevious: input.activity.workCompleted,
      bytesSentSincePrevious: input.activity.bytesSent,
      queueRowsClearedSincePrevious: input.activity.queueRowsCleared ?? null,
      parkedCount,
      withheldCount,
    };
  }

  private emit(snapshot: SyncBurndownSnapshot): void {
    // Unconditional and first: the log lines below are rate-limited by design,
    // and a telemetry series must not inherit that policy (ISS-9246).
    this.options.onSample?.(snapshot);
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
    this.stallWatcher.observe({
      previous:
        this.previous?.lanes.find((entry) => entry.lane === lane.lane) ?? null,
      current: lane,
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

/**
 * ISS-9744: the dead-letter basis for a lane whose store read is SCOPED to a
 * source key.
 *
 * With no key, `sync-burndown-store.ts` never queries the DEAD-LETTER
 * population: `readSessionOutbox` and `readSessionParked` are skipped entirely,
 * `readInvocationCounts` returns `EMPTY_INVOCATION_COUNTS` dead-letters down
 * both of its null-key branches (the ISS-8768 template probe on one of them
 * counts the BACKLOG, never the abandoned rows), and
 * `readComponentInventoryCounts` returns `deadLetteredCount: 0` without reading
 * the cursor row. The count is a placeholder, so labelling it as measured would
 * assert a read that never happened, on exactly the unpaired/offline install the
 * gate-shut alert fires for.
 */
function deadLetteredBasisFor(
  sourceKey: string | null,
  measured: SyncLaneDeadLetteredBasis
): SyncLaneDeadLetteredBasis {
  return sourceKey === null ? SyncLaneDeadLetteredBasis.Unmeasured : measured;
}
