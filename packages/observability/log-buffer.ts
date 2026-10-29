// ---------------------------------------------------------------------------
// Bounded, accounted buffer for the agentless Datadog log sink (ISS-7219).
//
// The sink's buffer had no maximum length and `enqueue()` pushed into it
// unconditionally, so a stalled intake grew it without bound while whole
// batches were dropped 100 at a time with nothing but a `console.error` to show
// for it. Both halves are the bug: unbounded growth risks an OOM that loses the
// whole process, and an UNCOUNTED drop makes every log-sourced count a floor
// rather than a measurement — the loss is load-correlated, so the denominator
// goes unknown exactly when an alert is firing.
//
// Storage is a RING, not an array the head is spliced off. A memory bound that
// costs O(capacity) per arrival is not a fix: once the default 10,000-entry
// buffer is full, splicing the head would move every remaining entry for every
// new log, and sustained logging during an intake outage would turn the logger
// into O(capacity x arrivals) work on the request process. Every operation here
// is O(1) in the capacity, or O(batch) in what the caller actually handed over.
//
// TWO counters, because there are two ways entries stop arriving and only one
// of them is a drop. `cumulativeDropped` counts entries that left the pipeline
// for good. Entries still buffered when a drain cycle gives up have NOT left it
// — the next interval usually ships them — so counting them as drops would
// overstate loss. But a serverless runtime freezes the process once
// `waitUntil(log.flush())` resolves, and that backlog evaporates with every drop
// counter reading 0. `cumulativeAbandonedCycles` and the
// `telemetry.undelivered` report are the signal for that window. Neither
// counter alone is a complete account of loss; that is stated rather than
// papered over.
//
// Shed policy is OLDEST-FIRST, deliberately. Two reasons:
//   1. Loss here is load-correlated. The entries arriving while the buffer is
//      full describe the incident an operator is currently in; the entries
//      already sitting in it describe the minutes before it. Keep the incident.
//   2. A failed batch is returned to the FRONT of the buffer, so newest-first
//      shedding would pin the buffer on a batch the intake has already refused
//      and shed every fresh entry behind it for as long as the outage lasts.
//
// This module never routes its own reports through `log.*` — that would queue
// the notice for the very sink that is failing. It writes one structured JSON
// line to the console, which the platform log drain parses into facets
// independently of the HTTP intake path.
// ---------------------------------------------------------------------------

/** Datadog log-intake failure modes, as classified by the flush path. */
export const TelemetryFlushFailure = {
  /** The 10s `AbortSignal.timeout` fired before the intake answered. */
  Timeout: "timeout",
  /** 429/408/5xx — the intake asked to be retried. */
  ServerError: "server_error",
  /** A 4xx the intake will never accept on replay (malformed batch, bad key). */
  ClientError: "client_error",
  /** Network, DNS, or the deliberate `redirect: "error"` refusal. */
  TransportError: "transport_error",
} as const;

export type TelemetryFlushFailure =
  (typeof TelemetryFlushFailure)[keyof typeof TelemetryFlushFailure];

/**
 * Why entries left the pipeline for good.
 *
 * Retryable failures (timeout, 5xx, transport) are NOT drop reasons: the batch
 * stays buffered across flush cycles, and the only thing that ultimately sheds
 * it is capacity. The failure that drove the backlog rides along as `cause` so
 * a `queue_full` report still says "because timeout".
 */
export const TelemetryDropReason = {
  /** Capacity shed — the buffer was at its ceiling when newer entries arrived. */
  QueueFull: "queue_full",
  /** The intake refused the batch with a status replaying cannot fix. */
  IntakeRejected: "intake_rejected",
  /**
   * The intake body could not be built from the entry — circular or otherwise
   * `JSON.stringify`-hostile metadata. The console sink accepts such values, so
   * only the intake copy is lost, and replay cannot help: the same value throws
   * every time.
   */
  Unserializable: "unserializable",
} as const;

export type TelemetryDropReason =
  (typeof TelemetryDropReason)[keyof typeof TelemetryDropReason];

export const TELEMETRY_DROPPED_CATEGORY = "telemetry.dropped";

/**
 * Default buffer ceiling, in entries. At the intake's own 100-entry batch size
 * this is 100 batches of head-room before anything is shed, and at a typical
 * entry size it caps the sink's own footprint in the low tens of megabytes —
 * small enough that the sink cannot be what exhausts the process.
 */
export const MAX_BUFFER_ENTRIES = 10_000;

/**
 * Hard ceiling on the ceiling. The buffer allocates its ring up front, so an
 * operator override is an allocation instruction: without an upper bound a
 * fat-fingered `DD_LOG_BUFFER_MAX_ENTRIES` would either reintroduce the
 * unbounded footprint this module exists to cap or throw a `RangeError` while
 * constructing the ring — at module load, in a module imported almost
 * everywhere. Ten times the default keeps a deliberate raise available.
 */
export const MAX_CONFIGURABLE_BUFFER_ENTRIES = 100_000;

/**
 * Operator override for the ceiling, read raw from the environment exactly as
 * this sink's other levers (`DD_LOGS_DISABLED`, `DD_LOGS_JSON`) are — a box
 * with head-room can hold more of an outage without a deploy.
 *
 * A value that is not a bounded positive integer is not a ceiling; it is a
 * misconfiguration, and acting on it would either shed everything on arrival or
 * restore the unbounded growth this exists to stop. Fall back to the default.
 */
export function resolveMaxBufferEntries(): number {
  const raw = process.env.DD_LOG_BUFFER_MAX_ENTRIES?.trim();
  if (!raw) {
    return MAX_BUFFER_ENTRIES;
  }
  // `Number`, never `Number.parseInt`: parseInt stops at the first character it
  // cannot read, so "1oops" and "1.5" each yield a ONE-entry ceiling — a typo
  // silently sheds all but the newest log instead of falling back. Parse the
  // whole value, and take it only if the whole value is a ceiling.
  const configured = Number(raw);
  if (
    Number.isInteger(configured) &&
    configured >= 1 &&
    configured <= MAX_CONFIGURABLE_BUFFER_ENTRIES
  ) {
    return configured;
  }
  return MAX_BUFFER_ENTRIES;
}

/**
 * Minimum spacing between drop reports. A full buffer sheds once per arriving
 * entry, so an unthrottled report would emit thousands of console lines a
 * second and become its own incident. Coalescing is safe here precisely because
 * the report carries CUMULATIVE totals: a suppressed window loses no count, and
 * the first drop after a quiet period still reports immediately.
 */
export const DROP_REPORT_INTERVAL_MS = 5000;

/**
 * Category for the "a cycle gave up with entries still buffered" signal.
 *
 * Deliberately NOT `telemetry.dropped`. Those entries have not left the
 * pipeline — the next interval may well deliver them — so counting them as
 * drops would overstate loss and break the conservation the drop counter
 * exists to provide. But on a runtime that FREEZES the process after
 * `waitUntil(log.flush())` resolves, they evaporate from memory with nothing
 * recorded, and `cumulativeDropped` reads 0 straight through real loss.
 *
 * This is the signal that is non-zero in that window: alert on the rate of
 * `@telemetryUndelivered.cumulativeAbandonedCycles` and read
 * `@telemetryUndelivered.undeliveredEntries` as the at-risk gauge.
 */
export const TELEMETRY_UNDELIVERED_CATEGORY = "telemetry.undelivered";

export type TelemetryDropStats = {
  /**
   * Entries that left the pipeline for good, all reasons, since process start.
   *
   * DEFINITIVE drops only. Entries still sitting in the buffer after a cycle
   * spent its retry budget are NOT counted here, because in a long-running
   * process the next interval usually delivers them — and on a freezing
   * serverless runtime they are lost without this counter ever moving. Read
   * `cumulativeAbandonedCycles` alongside it; this number alone is not a
   * complete account of telemetry loss.
   */
  cumulativeDropped: number;
  byReason: Record<TelemetryDropReason, number>;
  bufferLength: number;
  lastFlushFailure?: TelemetryFlushFailure;
  /**
   * Drain cycles that gave up with entries still buffered, since process start.
   *
   * Counts CYCLES, not entries, and that is deliberate: the same backlog is
   * abandoned again on every failing cycle, so summing its size would inflate
   * the signal several times over for entries that were never lost. The
   * point-in-time entry count rides the `telemetry.undelivered` report, and
   * `bufferLength` above is the live gauge.
   */
  cumulativeAbandonedCycles: number;
};

/** Error carrying the intake's own classification of a failed flush. */
export class DatadogIntakeError extends Error {
  readonly failure: TelemetryFlushFailure;
  readonly httpStatus: number;

  constructor(failure: TelemetryFlushFailure, httpStatus: number) {
    super(`Datadog responded with ${httpStatus}`);
    this.name = "DatadogIntakeError";
    this.failure = failure;
    this.httpStatus = httpStatus;
  }
}

/**
 * One coalesced report's worth of drops, keyed by the dimensions the report is
 * LABELLED with. Tallying across reasons and then stamping the sum with
 * whichever reason happened to arrive last is what makes a grouped query
 * confidently wrong; a group per (reason, httpStatus, cause) means every
 * emitted count describes exactly the label it is attached to.
 */
type PendingDropGroup = {
  reason: TelemetryDropReason;
  httpStatus: number | undefined;
  cause: TelemetryFlushFailure | undefined;
  count: number;
};

function emptyTally(): Record<TelemetryDropReason, number> {
  return {
    [TelemetryDropReason.QueueFull]: 0,
    [TelemetryDropReason.IntakeRejected]: 0,
    [TelemetryDropReason.Unserializable]: 0,
  };
}

/**
 * A FIFO entry buffer with a hard ceiling and a cumulative drop tally.
 *
 * Generic over the entry type so it carries no dependency on `log.ts`, which
 * imports it — the sink's entry type stays declared where the sink lives.
 */
export class BoundedLogBuffer<T> {
  private readonly slots: (T | undefined)[];
  private readonly capacity: number;
  private readonly reportIntervalMs: number;
  private readonly tally = emptyTally();
  /**
   * Drops the throttle is holding back, one entry per (reason, httpStatus,
   * cause). Bounded by construction — three reasons, an HTTP status drawn from
   * the spec's 200-599, and four failure classes — and emptied on every report,
   * so a long outage cannot grow it.
   */
  private readonly pending = new Map<string, PendingDropGroup>();
  private head = 0;
  private size = 0;
  private slotWriteCount = 0;
  private droppedTotal = 0;
  private abandonedCycles = 0;
  private lastReportAtMs: number | undefined;
  /** Separate from the drop throttle, so neither report can suppress the other. */
  private lastUndeliveredReportAtMs: number | undefined;
  private lastFailure: TelemetryFlushFailure | undefined;

  constructor(
    maxEntries: number = MAX_BUFFER_ENTRIES,
    reportIntervalMs: number = DROP_REPORT_INTERVAL_MS
  ) {
    this.capacity = clampCapacity(maxEntries);
    this.slots = new Array<T | undefined>(this.capacity);
    this.reportIntervalMs = Math.max(0, reportIntervalMs);
  }

  get length(): number {
    return this.size;
  }

  /**
   * Backing-slot writes performed since construction — the ring's cost meter.
   *
   * The memory bound must not become a CPU failure, and in JavaScript the only
   * honest way to assert that is to count operations (timing assertions are
   * banned repo-wide, and would measure the machine rather than the algorithm).
   * Storing an arriving entry costs a fixed number of these no matter how large
   * the ceiling is; an implementation that relocates the buffer's contents on
   * arrival cannot keep that constant.
   */
  get slotWrites(): number {
    return this.slotWriteCount;
  }

  /**
   * Entries currently buffered, oldest first. Materializes the ring's logical
   * order, so it is O(n) and meant for assertions and diagnostics — the flush
   * path takes batches instead.
   */
  peek(): readonly T[] {
    const ordered: T[] = [];
    for (let offset = 0; offset < this.size; offset++) {
      ordered.push(this.slots[this.indexAt(offset)] as T);
    }
    return ordered;
  }

  push(entry: T): void {
    const shed = this.size === this.capacity ? this.evictOldest(1) : 0;
    this.writeAt(this.size, entry);
    this.size++;
    this.countDrop(
      TelemetryDropReason.QueueFull,
      shed,
      undefined,
      this.lastFailure
    );
  }

  /**
   * Return a batch the intake refused to the FRONT, restoring chronological
   * order — the batch was taken from the front and is older than everything
   * behind it. Overflow is then shed oldest-first, which means the returned
   * batch is the first thing to go: a batch the intake has already refused is
   * the least valuable thing in the buffer.
   */
  returnBatch(batch: readonly T[]): void {
    const overflow = Math.max(0, this.size + batch.length - this.capacity);
    // The shed comes off the head of the returned batch, never past it into
    // entries already held: overflow can only exceed `batch.length` when the
    // buffer is already at capacity, and then the whole batch is what goes.
    const shed = Math.min(overflow, batch.length);
    const kept = shed > 0 ? batch.slice(shed) : batch;
    if (kept.length > 0) {
      this.head = (this.head - kept.length + this.capacity) % this.capacity;
      this.size += kept.length;
      for (let offset = 0; offset < kept.length; offset++) {
        this.writeAt(offset, kept[offset]);
      }
    }
    this.countDrop(
      TelemetryDropReason.QueueFull,
      shed,
      undefined,
      this.lastFailure
    );
  }

  /** Take up to `max` entries from the front, oldest first. */
  takeBatch(max: number): T[] {
    const count = Math.min(this.size, Math.max(1, Math.floor(max)));
    const batch: T[] = [];
    for (let offset = 0; offset < count; offset++) {
      const index = this.indexAt(offset);
      batch.push(this.slots[index] as T);
      // Release the reference as it leaves: a ring that keeps pointing at
      // handed-over entries pins the whole ceiling's worth of memory after the
      // backlog has drained, which is the bound this module promises.
      this.slots[index] = undefined;
      this.slotWriteCount++;
    }
    this.head = this.indexAt(count);
    this.size -= count;
    return batch;
  }

  /** Record the classification of the most recent flush failure. */
  noteFlushFailure(failure: TelemetryFlushFailure): void {
    this.lastFailure = failure;
  }

  /** Clear the failure note after a flush the intake accepted. */
  noteFlushSuccess(): void {
    this.lastFailure = undefined;
  }

  /**
   * Account for a batch the intake rejected with a non-retryable status. The
   * entries are already out of the buffer; what would otherwise be lost is the
   * fact that they existed.
   */
  recordRejected(count: number, httpStatus: number): void {
    this.countDrop(
      TelemetryDropReason.IntakeRejected,
      count,
      httpStatus,
      this.lastFailure
    );
  }

  /**
   * Account for entries no intake body could be built from. They are already
   * out of the buffer and replaying them cannot help, so the only thing left to
   * lose is the fact that they existed. No `cause`: nothing about the intake
   * did this, the metadata did.
   */
  recordUnserializable(count: number): void {
    this.countDrop(
      TelemetryDropReason.Unserializable,
      count,
      undefined,
      undefined
    );
  }

  /**
   * Record that a drain cycle ended with entries still buffered and
   * undelivered — its retry budget spent, or an unexpected error mid-drain.
   *
   * NOT a drop, and deliberately not counted as one: these entries are still in
   * the buffer and the 5s interval usually delivers them, so folding them into
   * `cumulativeDropped` would overstate loss and break its conservation. The
   * gap this closes is the other direction — on a runtime that freezes the
   * process once `waitUntil(log.flush())` resolves, the backlog evaporates and
   * every drop counter stays at 0 through real loss. This is the number that
   * is non-zero in that window.
   */
  noteCycleAbandoned(): void {
    if (this.size === 0) {
      return;
    }
    this.abandonedCycles++;
    this.reportUndelivered();
  }

  stats(): TelemetryDropStats {
    return {
      cumulativeDropped: this.droppedTotal,
      byReason: { ...this.tally },
      bufferLength: this.size,
      lastFlushFailure: this.lastFailure,
      cumulativeAbandonedCycles: this.abandonedCycles,
    };
  }

  /**
   * Emit what the throttle is holding, IF the window has elapsed.
   *
   * This RESPECTS the interval rather than forcing a report: it is called from
   * every flush-completion branch and from the public `log.flush()`, which
   * serverless callers invoke once per request. Forcing here would let a busy
   * process emit a report per flush and defeat the throttle under exactly the
   * sustained backlog it exists to survive. Nothing is lost by waiting — the
   * counts stay pending and every report carries the cumulative totals.
   */
  reportPending(): void {
    if (this.pending.size === 0 || !this.shouldReport()) {
      return;
    }
    this.emitPending();
  }

  /** Emit unconditionally, because there is no later. Process teardown only. */
  reportFinal(): void {
    if (this.pending.size === 0) {
      return;
    }
    this.lastReportAtMs = Date.now();
    this.emitPending();
  }

  /** Ring index of the entry `offset` places behind the head. */
  private indexAt(offset: number): number {
    return (this.head + offset) % this.capacity;
  }

  private writeAt(offset: number, entry: T): void {
    this.slots[this.indexAt(offset)] = entry;
    this.slotWriteCount++;
  }

  private evictOldest(count: number): number {
    const evicted = Math.min(count, this.size);
    for (let offset = 0; offset < evicted; offset++) {
      this.slots[this.indexAt(offset)] = undefined;
      this.slotWriteCount++;
    }
    this.head = this.indexAt(evicted);
    this.size -= evicted;
    return evicted;
  }

  private countDrop(
    reason: TelemetryDropReason,
    count: number,
    httpStatus: number | undefined,
    cause: TelemetryFlushFailure | undefined
  ): void {
    if (count <= 0) {
      // A drop report of zero describes a drop that did not happen. Refusing it
      // here is what keeps a caller that tallies outside the branch where the
      // drop occurred from quietly inflating the alert.
      return;
    }
    this.tally[reason] += count;
    this.droppedTotal += count;
    const key = `${reason}|${httpStatus ?? ""}|${cause ?? ""}`;
    const group = this.pending.get(key);
    if (group) {
      group.count += count;
    } else {
      this.pending.set(key, { reason, httpStatus, cause, count });
    }
    if (this.shouldReport()) {
      this.emitPending();
    }
  }

  private shouldReport(): boolean {
    const now = Date.now();
    if (
      this.lastReportAtMs !== undefined &&
      now - this.lastReportAtMs < this.reportIntervalMs
    ) {
      return false;
    }
    this.lastReportAtMs = now;
    return true;
  }

  private emitPending(): void {
    for (const group of this.pending.values()) {
      this.emitReport(group);
    }
    this.pending.clear();
  }

  /**
   * Report the backlog a cycle walked away from, throttled on its own clock.
   *
   * `log.flush()` is called once per request by serverless callers, so a failing
   * intake abandons a cycle that often; unthrottled this would be its own log
   * storm. Coalescing costs nothing here because the report carries a cumulative
   * cycle count and a live entry gauge rather than a per-event delta.
   *
   * console.error, not console.warn: the same sink discipline the drop report
   * uses, and an intake that has refused a full retry budget while entries pile
   * up is an error condition, not an advisory one.
   */
  private reportUndelivered(): void {
    const now = Date.now();
    if (
      this.lastUndeliveredReportAtMs !== undefined &&
      now - this.lastUndeliveredReportAtMs < this.reportIntervalMs
    ) {
      return;
    }
    this.lastUndeliveredReportAtMs = now;
    console.error(
      JSON.stringify({
        level: "error",
        status: "error",
        category: TELEMETRY_UNDELIVERED_CATEGORY,
        event: TELEMETRY_UNDELIVERED_CATEGORY,
        message: `observability: ${this.size} log entries undelivered after a drain cycle gave up`,
        telemetryUndelivered: {
          /** Live gauge at the moment the cycle gave up — NOT a running total. */
          undeliveredEntries: this.size,
          cause: this.lastFailure,
          cumulativeAbandonedCycles: this.abandonedCycles,
          maxBufferEntries: this.capacity,
        },
      })
    );
  }

  private emitReport(group: PendingDropGroup): void {
    // console.error, never log.error: routing this through the module's own
    // logger would enqueue it for the sink that is dropping. A single JSON line
    // reaches Datadog via the platform drain, which does not use the intake.
    console.error(
      JSON.stringify({
        level: "error",
        status: "error",
        category: TELEMETRY_DROPPED_CATEGORY,
        event: TELEMETRY_DROPPED_CATEGORY,
        message: `observability: dropped ${group.count} log entries (${group.reason}); ${this.droppedTotal} since start`,
        telemetryDropped: {
          reason: group.reason,
          /** Entries dropped for THIS reason and status since the last report. */
          count: group.count,
          cause: group.cause,
          /** Present only where a status exists — a capacity shed has none. */
          httpStatus: group.httpStatus,
          /** Total across ALL reasons. A gauge — do NOT group this by reason. */
          cumulativeDropped: this.droppedTotal,
          /** The per-reason split. This is what a by-reason panel reads. */
          cumulativeByReason: { ...this.tally },
          bufferLength: this.size,
          maxBufferEntries: this.capacity,
        },
      })
    );
  }
}

/**
 * Clamp a requested ceiling at BOTH ends.
 *
 * Below 1 every entry would be shed on arrival and report a drop for each,
 * turning a misconfiguration into a log storm; above the hard ceiling the ring
 * allocation is the problem rather than the fix. `Math.min` alone does neither.
 */
function clampCapacity(maxEntries: number): number {
  if (!Number.isFinite(maxEntries)) {
    return MAX_BUFFER_ENTRIES;
  }
  return Math.min(
    MAX_CONFIGURABLE_BUFFER_ENTRIES,
    Math.max(1, Math.floor(maxEntries))
  );
}
