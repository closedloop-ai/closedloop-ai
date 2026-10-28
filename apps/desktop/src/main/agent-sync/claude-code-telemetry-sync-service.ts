/**
 * @file claude-code-telemetry-sync-service.ts
 * @description ISS-10717 — the desktop→cloud Claude Code telemetry LANE.
 *
 * ISS-7352 shipped fourteen `claude_code_*` tables into desktop SQLite and every
 * one of them was write-only: the only readers were the writer and two delete
 * paths. This lane is what makes the corpus leave the machine.
 *
 * ── Shape: CURSOR, not outbox ───────────────────────────────────────────────
 * `main/sync/AGENTS.md` requires an outbox-shaped lane to compose
 * `durable-outbox.ts`. This lane is not outbox-shaped and deliberately so: the
 * payload is DERIVED state. The `claude_code_*` rows are the durable obligation
 * and a rollup can always be recomputed from them, so a queue row would hold
 * nothing the source does not already hold, while adding a second thing that can
 * go stale. What it keeps instead is a per-session delivered watermark
 * (`claude_code_telemetry_sync_cursor`).
 *
 * ── Invariants it does honour ───────────────────────────────────────────────
 * 1. The watermark advances ONLY on a verified server ack — never on send.
 * 2. The cursor's `source_key` is target-scoped, so signing into a different
 *    compute target does not inherit the previous target's deliveries.
 * 4. Only a payload rejection is attributable to the session and may burn its
 *    budget. A transport error, a 5xx, a 429, an unauthenticated tick, an
 *    unavailable protocol are all lane-wide and defer with the budget intact.
 *
 * ── The completeness signal rides with the data ─────────────────────────────
 * Every request carries the machine's current drop counters alongside the
 * session rollup, rather than on a lane of their own. A consumer that has the
 * rollup therefore always has the counters that qualify it, and never has to
 * join two deliveries that may have landed at different times or not at all.
 *
 * RIDING ALONG IS NOT ENOUGH ON ITS OWN, and this is the one case where the
 * counters get a delivery of their own. A loss that happens BEFORE any signal row
 * is persisted — a receiver-backpressure eviction, a wholly unusable export, an
 * all-rejected batch — moves a counter and dirties no session. With nothing owed,
 * a passenger-only lane sends nothing, the counter never leaves the machine, and
 * cloud reads that machine as COMPLETE: silent loss presenting as success. So a
 * tick with no dirty session still delivers, counters-only, whenever
 * `dropped_count` is past the `synced_count` the cloud acknowledged.
 */

import {
  type DesktopClaudeCodeDropCounterInput,
  type DesktopClaudeCodeSessionTelemetryInput,
  DesktopClaudeCodeTelemetrySyncAckReason,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import {
  type DesktopClaudeCodeTelemetryClientResult,
  DesktopClaudeCodeTelemetryClientResultKind,
} from "../dashboard/desktop-claude-code-telemetry-client.js";
import { boundClaudeCodeTelemetryPayload } from "../otel/claude-code-telemetry-payload-bound.js";
import type { ClaudeCodeDropCounterSnapshot } from "../otel/claude-code-telemetry-rollup.js";
import {
  type DesktopAccountAdmission,
  isSameDesktopAccountAdmission,
} from "../session/desktop-account-admission.js";

/** Tick cadence. Slower than the outbox lanes: this corpus is not interactive. */
const SYNC_INTERVAL_MS = 15_000;
/** Sessions examined per tick. */
const SESSION_PAGE_LIMIT = 5;
/** Attempts a SESSION-attributable rejection may burn before it is passed. */
const MAX_PERMANENT_ATTEMPTS = 3;
/**
 * `session_not_found` acks a session may accumulate before it is passed.
 *
 * Much larger than the rejection ceiling because the race it bounds is ORDINARY
 * — the session lane creates the cloud row and runs on its own schedule — and
 * at a 15s tick this is roughly five minutes of patience. It is bounded at all
 * because the candidate query is oldest-owed-first: a session whose cloud row
 * will never exist (a local session deleted before it ever synced, or one the
 * session lane itself abandoned) would otherwise sit at the head of every page
 * forever and starve every session that CAN be delivered.
 */
const MAX_SESSION_ABSENT_ATTEMPTS = 20;
/**
 * Consecutive LANE-WIDE `retry` results one session may sit at the head of the
 * page for before the tick steps over it.
 *
 * NOT a budget and it abandons nothing. A `retry` is by definition not
 * attributable to the session, so nothing may be charged for it — but `retry` is
 * also what a 5xx becomes, and a 5xx can be a property of THIS payload rather
 * than of the server: an ingest that throws on one session's row answers
 * `IngestionFailed` for that session and 200 for the next. Because the candidate
 * query is oldest-owed-first and the tick stops at the first lane-wide result,
 * such a session returned to the head every tick forever and took the rest of
 * the corpus with it.
 *
 * Stepping over it costs nothing when the failure really is lane-wide: the next
 * session fails the same way, and the tick still ends — just one page later
 * instead of one session in. The skipped session keeps its cursor, stays owed,
 * and is retried on the next tick, so no data is lost either way. The counter is
 * in memory only: a restart reasonably retries from the head.
 */
const MAX_CONSECUTIVE_LANE_RETRIES_AT_HEAD = 3;
/**
 * How long a FAILED counters-only delivery waits before it is attempted again.
 *
 * It bounds one skew case and nothing else: an API old enough to still require
 * `session` in the envelope answers a counters-only body with a 400, and without
 * a cooldown this lane would re-post it every 15s for as long as that skew lasts.
 * It never abandons — invariant 3 — the counter stays owed and one attempt per
 * cooldown keeps it eventually deliverable the moment the API catches up.
 *
 * In memory, like `laneRetriesAtHead`: a restart reasonably retries at once, and
 * the durable obligation is the `synced_count` column, not this clock.
 */
const COUNTERS_ONLY_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

/** The source-key prefix, target-scoped per invariant 2. */
export const CLAUDE_CODE_TELEMETRY_SYNC_SOURCE_KEY = "claude_code_telemetry";

/**
 * The delivery key for one compute target.
 *
 * A consumer matching these must use `startsWith` on
 * `` `${CLAUDE_CODE_TELEMETRY_SYNC_SOURCE_KEY}:` ``, never SQL `LIKE` — `_` is a
 * single-character wildcard there and the prefix contains three of them.
 */
export function buildClaudeCodeTelemetrySyncSourceKey(
  computeTargetId: string
): string {
  return `${CLAUDE_CODE_TELEMETRY_SYNC_SOURCE_KEY}:${computeTargetId}`;
}

/** One session this lane may deliver. */
export type ClaudeCodeTelemetryPendingSession = {
  sessionId: string;
  session: DesktopClaudeCodeSessionTelemetryInput;
  /** The watermark to persist on a verified ack. */
  observedTo: string;
};

/**
 * The durable store this lane drives. An interface rather than a direct import
 * so the whole state machine can be driven against an in-memory double, and so
 * the db-host wiring stays the only place that knows about Prisma.
 */
export type ClaudeCodeTelemetrySyncStore = {
  /** Sessions whose corpus has moved past their acknowledged watermark. */
  loadPendingSessions(
    sourceKey: string,
    limit: number
  ): Promise<ClaudeCodeTelemetryPendingSession[]>;
  /** The machine's current drop counters, and whether any is still owed. */
  loadDropCounters(): Promise<ClaudeCodeDropCounterSnapshot>;
  /**
   * Advance the counters' delivery watermark to the totals a verified ack just
   * accepted. Called ONLY after such an ack, for the same reason the session
   * watermark is (invariant 1).
   */
  markDropCountersDelivered(
    counters: readonly DesktopClaudeCodeDropCounterInput[]
  ): Promise<void>;
  /** Advance the watermark. Called ONLY after a verified ack. */
  recordDelivered(
    sourceKey: string,
    sessionId: string,
    observedTo: string
  ): Promise<void>;
  /**
   * Charge one server-attributable rejection and report the new total. The
   * counter is DURABLE rather than in-memory: an in-process abandon list would
   * grow with the session corpus, forget itself on restart, and let a session
   * the cloud will never accept occupy a slot in every page forever.
   */
  recordRejection(sourceKey: string, sessionId: string): Promise<number>;
  /**
   * Charge one `session_not_found` deferral and report the new total. Durable
   * for the same reason the rejection counter is: an in-process tally would
   * forget itself on restart and the bound would never be reached.
   */
  recordSessionAbsent(sourceKey: string, sessionId: string): Promise<number>;
  /**
   * Pass a session the cloud has refused to its ceiling: advance the watermark
   * so it leaves the owed set, and record WHY on the row so the pass is visible
   * rather than a silent disappearance.
   */
  recordAbandoned(
    sourceKey: string,
    sessionId: string,
    observedTo: string,
    reason: string
  ): Promise<void>;
};

/** Recorded on a cursor row the cloud repeatedly refused. */
export const ClaudeCodeTelemetrySyncLocalError = {
  PayloadRejected: "payload_rejected",
  /**
   * The cloud never grew a row for this session. Recorded rather than retried
   * forever, so the pass is visible on the row instead of being a session that
   * quietly consumes a page slot for the life of the install.
   */
  SessionAbsent: "session_absent",
} as const;
export type ClaudeCodeTelemetrySyncLocalError =
  (typeof ClaudeCodeTelemetrySyncLocalError)[keyof typeof ClaudeCodeTelemetrySyncLocalError];

export type ClaudeCodeTelemetrySyncServiceOptions = {
  store: () => ClaudeCodeTelemetrySyncStore | null;
  isReady: () => boolean;
  /** The live Desktop account generation, not a retained compute target or key. */
  getAccountAdmission?: () => DesktopAccountAdmission | null;
  getComputeTargetId: () => string | null;
  sendSession: (
    input: {
      /** Omitted on a counters-only delivery, which names no session. */
      session?: DesktopClaudeCodeSessionTelemetryInput;
      dropCounters: readonly DesktopClaudeCodeDropCounterInput[];
    },
    canStillSend?: () => boolean
  ) => Promise<DesktopClaudeCodeTelemetryClientResult>;
  now?: () => number;
  log: (message: string) => void;
  intervalMs?: number;
  sessionPageLimit?: number;
};

export class ClaudeCodeTelemetrySyncService {
  private timer: NodeJS.Timeout | null = null;
  private tick: Promise<void> | null = null;
  /**
   * Consecutive lane-wide `retry` results per session, in memory only. Swept
   * against the page each drain, so it cannot grow with the corpus.
   */
  private readonly laneRetriesAtHead = new Map<string, number>();
  /** Epoch ms before which no counters-only delivery is attempted. */
  private countersOnlyRetryAfter = 0;
  private readonly options: ClaudeCodeTelemetrySyncServiceOptions;

  constructor(options: ClaudeCodeTelemetrySyncServiceOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const interval = this.options.intervalMs ?? SYNC_INTERVAL_MS;
    this.timer = setInterval(() => this.kick(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  refresh(): void {
    // biome-ignore lint/complexity/noVoid: refresh keeps its existing ignored completion contract.
    void this.kick();
  }

  /**
   * Run a tick unless one is already in flight.
   *
   * A tick can outlast the interval — the page is up to five sessions, each a
   * network round trip — so overlapping runs would double-send and race the
   * cursor. The in-flight promise, rather than a boolean, is what lets the
   * rejection handler run before the next tick is admitted. The returned
   * promise includes that guard reset and is shared by overlapping callers.
   */
  private kick(): Promise<void> {
    if (this.tick) {
      return this.tick;
    }
    this.tick = this.syncOnce().finally(() => {
      this.tick = null;
    });
    return this.tick;
  }

  async syncOnce(): Promise<void> {
    const store = this.options.store();
    const computeTargetId = this.options.getComputeTargetId();
    const admission = this.options.getAccountAdmission?.() ?? null;
    if (
      !(store && computeTargetId && this.options.isReady()) ||
      (this.options.getAccountAdmission && !admission)
    ) {
      return;
    }
    const canStillSend = () =>
      this.options.isReady() &&
      this.options.getComputeTargetId() === computeTargetId &&
      (!this.options.getAccountAdmission ||
        isSameDesktopAccountAdmission(
          admission,
          this.options.getAccountAdmission()
        ));
    try {
      await this.drain(store, computeTargetId, canStillSend);
    } catch (error) {
      this.options.log(
        `tick failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async drain(
    store: ClaudeCodeTelemetrySyncStore,
    computeTargetId: string,
    canStillSend: () => boolean
  ): Promise<void> {
    const sourceKey = buildClaudeCodeTelemetrySyncSourceKey(computeTargetId);
    const limit = this.options.sessionPageLimit ?? SESSION_PAGE_LIMIT;
    const pending = await store.loadPendingSessions(sourceKey, limit);
    if (!canStillSend()) {
      return;
    }
    const counters = await store.loadDropCounters();
    if (!canStillSend()) {
      return;
    }
    if (pending.length === 0) {
      // The lane has nothing session-shaped owed. That is exactly the tick on
      // which a loss recorded before any signal row existed would otherwise be
      // stranded, so the counters get their own delivery here.
      await this.deliverDropCountersOnly(store, counters, canStillSend);
      return;
    }
    const dropCounters = counters.counters;
    this.pruneLaneRetries(pending);
    for (const entry of pending) {
      // Re-checked before EVERY send, not once per tick: readiness and the
      // signed-in compute target can both change mid-drain, and a send under a
      // target the user has left would write this machine's corpus into the
      // wrong org's cursor.
      if (!canStillSend()) {
        return;
      }
      const outcome = await this.deliver(
        store,
        sourceKey,
        entry,
        dropCounters,
        canStillSend
      );
      if (outcome === LaneOutcome.Stop) {
        return;
      }
    }
  }

  /**
   * Deliver the machine's drop counters with no session attached.
   *
   * Only when something is actually owed: `undelivered` is false in the steady
   * state, so an idle lane posts nothing. A failure charges no budget — there is
   * no session to charge — and abandons nothing; it only sets a cooldown so a
   * version-skewed API cannot be re-asked every tick.
   */
  private async deliverDropCountersOnly(
    store: ClaudeCodeTelemetrySyncStore,
    counters: ClaudeCodeDropCounterSnapshot,
    canStillSend: () => boolean
  ): Promise<void> {
    if (!counters.undelivered || counters.counters.length === 0) {
      return;
    }
    const now = this.options.now ?? Date.now;
    if (now() < this.countersOnlyRetryAfter) {
      return;
    }
    if (!canStillSend()) {
      return;
    }
    const result = await this.options.sendSession(
      {
        dropCounters: counters.counters,
      },
      canStillSend
    );
    if (
      !canStillSend() ||
      result.kind === DesktopClaudeCodeTelemetryClientResultKind.Deferred
    ) {
      return;
    }
    if (
      result.kind === DesktopClaudeCodeTelemetryClientResultKind.Ack &&
      result.ack.accepted
    ) {
      this.countersOnlyRetryAfter = 0;
      await store.markDropCountersDelivered(counters.counters);
      return;
    }
    this.countersOnlyRetryAfter = now() + COUNTERS_ONLY_RETRY_COOLDOWN_MS;
    this.options.log(
      `claude code telemetry drop-counter delivery deferred (${result.kind}${
        "status" in result && result.status ? ` ${result.status}` : ""
      })`
    );
  }

  /**
   * Forget the retry tally for every session no longer on the page.
   *
   * The map is keyed by session id from an external corpus, so it is swept
   * rather than left to accumulate: a session that drops off the page has either
   * been delivered or is no longer owed, and either way its tally is spent.
   */
  private pruneLaneRetries(
    pending: readonly ClaudeCodeTelemetryPendingSession[]
  ): void {
    const live = new Set(pending.map((entry) => entry.sessionId));
    for (const sessionId of this.laneRetriesAtHead.keys()) {
      if (!live.has(sessionId)) {
        this.laneRetriesAtHead.delete(sessionId);
      }
    }
  }

  /** Whether the tick stops here or moves to the next owed session. */
  private async deliver(
    store: ClaudeCodeTelemetrySyncStore,
    sourceKey: string,
    entry: ClaudeCodeTelemetryPendingSession,
    dropCounters: readonly DesktopClaudeCodeDropCounterInput[],
    canStillSend: () => boolean
  ): Promise<LaneOutcome> {
    const result = await this.options.sendSession(
      {
        // Bounded to the route's byte cap HERE, with the counters that ride along,
        // because the route weighs the whole envelope. The client reads a 413 as
        // lane-wide on the stated assumption that the producer already bounds its
        // own body against this shared cap; this is what makes that true.
        session: boundClaudeCodeTelemetryPayload({
          session: entry.session,
          dropCounters,
        }),
        dropCounters,
      },
      canStillSend
    );
    if (
      !canStillSend() ||
      result.kind === DesktopClaudeCodeTelemetryClientResultKind.Deferred
    ) {
      return LaneOutcome.Stop;
    }
    if (
      result.kind === DesktopClaudeCodeTelemetryClientResultKind.Unavailable
    ) {
      // LANE-WIDE and not payload-shaped: no origin, no credential, no compute
      // target, or an API that does not serve this protocol. Nothing on the page
      // can succeed, so the tick ends with every budget untouched.
      this.options.log(
        `claude code telemetry sync deferred (${result.kind}${
          result.status ? ` ${result.status}` : ""
        })`
      );
      return LaneOutcome.Stop;
    }
    if (result.kind === DesktopClaudeCodeTelemetryClientResultKind.Retry) {
      // Also lane-wide, and NOTHING IS CHARGED — but a 5xx can be a property of
      // this payload rather than of the server, so a session is not allowed to
      // hold the head of an oldest-owed-first queue indefinitely. Step over it
      // after MAX_CONSECUTIVE_LANE_RETRIES_AT_HEAD and let the page drain; it
      // keeps its cursor and is owed again next tick.
      const attempts = (this.laneRetriesAtHead.get(entry.sessionId) ?? 0) + 1;
      this.laneRetriesAtHead.set(entry.sessionId, attempts);
      this.options.log(
        `claude code telemetry sync deferred (${result.kind}${
          result.status ? ` ${result.status}` : ""
        }) on ${entry.sessionId}, attempt ${attempts}`
      );
      return attempts >= MAX_CONSECUTIVE_LANE_RETRIES_AT_HEAD
        ? LaneOutcome.Continue
        : LaneOutcome.Stop;
    }
    this.laneRetriesAtHead.delete(entry.sessionId);
    if (
      result.kind === DesktopClaudeCodeTelemetryClientResultKind.Ack &&
      result.ack.reason ===
        DesktopClaudeCodeTelemetrySyncAckReason.SessionNotFound
    ) {
      // NOT a rejection. The cloud has no row for this session yet because the
      // SESSION lane creates it and runs independently — an ordinary race, not
      // a defect in this payload, so the REJECTION budget and the watermark are
      // both untouched. It is still bounded on its own counter: see
      // MAX_SESSION_ABSENT_ATTEMPTS.
      const deferrals = await store.recordSessionAbsent(
        sourceKey,
        entry.sessionId
      );
      if (deferrals >= MAX_SESSION_ABSENT_ATTEMPTS) {
        await store.recordAbandoned(
          sourceKey,
          entry.sessionId,
          entry.observedTo,
          ClaudeCodeTelemetrySyncLocalError.SessionAbsent
        );
        this.options.log(
          `claude code telemetry sync passed a session the cloud never grew a row for, after ${deferrals} deferrals`
        );
      }
      return LaneOutcome.Continue;
    }
    if (
      result.kind === DesktopClaudeCodeTelemetryClientResultKind.Rejected ||
      !result.ack.accepted
    ) {
      const attempts = await store.recordRejection(sourceKey, entry.sessionId);
      if (attempts >= MAX_PERMANENT_ATTEMPTS) {
        await store.recordAbandoned(
          sourceKey,
          entry.sessionId,
          entry.observedTo,
          ClaudeCodeTelemetrySyncLocalError.PayloadRejected
        );
        this.options.log(
          `claude code telemetry sync passed a session after ${attempts} rejections`
        );
      }
      return LaneOutcome.Continue;
    }
    // INVARIANT 1: the watermark moves only here, after a verified ack.
    await store.recordDelivered(sourceKey, entry.sessionId, entry.observedTo);
    if (!canStillSend()) {
      return LaneOutcome.Stop;
    }
    // The counters rode along in this same accepted envelope, so their watermark
    // is advanced by the same ack. Without this the ride-along path would never
    // mark anything delivered and every idle tick would re-post counters the
    // cloud already holds.
    await store.markDropCountersDelivered(dropCounters);
    return LaneOutcome.Continue;
  }
}

/**
 * The lane's store methods as the db-host sync source exposes them — OPTIONAL,
 * so a db host that predates `claude_code_telemetry_sync_cursor` exposes none of
 * them and {@link resolveClaudeCodeTelemetrySyncStore} answers null rather than
 * throwing on the first tick.
 */
export type ClaudeCodeTelemetrySyncSource = {
  loadClaudeCodeTelemetryPendingSessions(
    sourceKey: string,
    limit: number
  ): Promise<ClaudeCodeTelemetryPendingSession[]>;
  loadClaudeCodeTelemetryDropCounters(): Promise<ClaudeCodeDropCounterSnapshot>;
  markClaudeCodeTelemetryDropCountersDelivered(
    counters: readonly DesktopClaudeCodeDropCounterInput[]
  ): Promise<void>;
  recordClaudeCodeTelemetryDelivered(
    sourceKey: string,
    sessionId: string,
    observedTo: string
  ): Promise<void>;
  recordClaudeCodeTelemetryRejection(
    sourceKey: string,
    sessionId: string
  ): Promise<number>;
  recordClaudeCodeTelemetrySessionAbsent(
    sourceKey: string,
    sessionId: string
  ): Promise<number>;
  recordClaudeCodeTelemetryAbandoned(
    sourceKey: string,
    sessionId: string,
    observedTo: string,
    reason: string
  ): Promise<void>;
};

/** Narrow a partially-capable sync source to this lane's store, or null. */
export function resolveClaudeCodeTelemetrySyncStore(
  source: Partial<ClaudeCodeTelemetrySyncSource> | null
): ClaudeCodeTelemetrySyncStore | null {
  if (
    !(
      source?.loadClaudeCodeTelemetryPendingSessions &&
      source.loadClaudeCodeTelemetryDropCounters &&
      source.markClaudeCodeTelemetryDropCountersDelivered &&
      source.recordClaudeCodeTelemetryDelivered &&
      source.recordClaudeCodeTelemetryRejection &&
      source.recordClaudeCodeTelemetrySessionAbsent &&
      source.recordClaudeCodeTelemetryAbandoned
    )
  ) {
    return null;
  }
  const ready = source as ClaudeCodeTelemetrySyncSource;
  return {
    loadPendingSessions: (sourceKey, limit) =>
      ready.loadClaudeCodeTelemetryPendingSessions(sourceKey, limit),
    loadDropCounters: () => ready.loadClaudeCodeTelemetryDropCounters(),
    markDropCountersDelivered: (counters) =>
      ready.markClaudeCodeTelemetryDropCountersDelivered(counters),
    recordDelivered: (sourceKey, sessionId, observedTo) =>
      ready.recordClaudeCodeTelemetryDelivered(
        sourceKey,
        sessionId,
        observedTo
      ),
    recordRejection: (sourceKey, sessionId) =>
      ready.recordClaudeCodeTelemetryRejection(sourceKey, sessionId),
    recordSessionAbsent: (sourceKey, sessionId) =>
      ready.recordClaudeCodeTelemetrySessionAbsent(sourceKey, sessionId),
    recordAbandoned: (sourceKey, sessionId, observedTo, reason) =>
      ready.recordClaudeCodeTelemetryAbandoned(
        sourceKey,
        sessionId,
        observedTo,
        reason
      ),
  };
}

/** Whether a delivery ends the tick or lets it move to the next owed session. */
const LaneOutcome = {
  Continue: "continue",
  Stop: "stop",
} as const;
type LaneOutcome = (typeof LaneOutcome)[keyof typeof LaneOutcome];
