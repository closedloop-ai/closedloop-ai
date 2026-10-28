/**
 * Bounded per-key fixed-window throttle for DIAGNOSTIC EMISSIONS.
 *
 * Extracted from `session-ingestion-policy-denied-throttle.ts` (ISS-4707) when
 * ISS-6890 needed the same primitive at a second choke point. It is the emission
 * counterpart to `apps/api/lib/fixed-window-rate-limiter.ts`: that one decides
 * whether a REQUEST proceeds, this one decides whether an OBSERVATION about a
 * request is emitted, and unlike a rate limiter it does not discard what it
 * suppressed — the suppressed count is flushed as an aggregate rollup.
 *
 * WHAT `sum(occurrences)` ACTUALLY MEANS (#5508 review, whitlockk). A suppressed
 * count is materialised by an EVENT, never by a clock: the window-rollover
 * branch in `record`, an LRU `evictOverflow`, or an explicit `drainExpired`.
 * There is no timer and no shutdown hook, so a key's final window is pending —
 * counted in memory, not yet emitted — from the moment that window closes until
 * one of those three runs. `sum(occurrences)` is therefore an EVENTUAL total,
 * not a live one, and a burst on a process that then freezes (a serverless
 * instance going idle) loses its terminal window outright. Callers that need
 * the lag bounded must call {@link FixedWindowEmissionThrottle.drainExpired}
 * from a terminal path they already run; a caller that does not simply keeps
 * the longer lag. Do not read this docstring as a completeness guarantee.
 *
 * WHY IT EXISTS. `apps/api/AGENTS.md` ("Emission and Abuse Control"): a metric
 * or alert emitted per row or per request is an amplification vector whenever an
 * authenticated caller can drive the path. Bounding at the choke point is only
 * half the job, though — the map that does the bounding is itself keyed on
 * caller-influenced input, so the root `AGENTS.md` rule that an in-memory
 * cache/limiter must have bounded growth applies to it. Both bounds live here:
 *
 *   • emission volume — at most `maxPerWindow` events (default 1) per key per
 *     window, plus one rollup;
 *   • keyspace — a hard max-entry LRU cap, with an evicted key's pending
 *     suppressed count flushed through `onFlush` before the entry is dropped, so
 *     memory pressure can never silently swallow occurrences.
 *
 * Serverless constraint (`apps/api/AGENTS.md` "Serverless Routes and State"):
 * process-local and best-effort. Key on a stable principal, never an ephemeral
 * connection id. Each instance dedups independently, so the total emitted across
 * a fleet is preserved while no single hot instance can be replayed into an
 * unbounded emit stream.
 *
 * The hot suppressed-replay path is O(1) and never scans the map: window
 * rollover is resolved lazily for the touched key, and stale keys are reclaimed
 * by LRU eviction on insertion. One key's rollover therefore cannot discard
 * another key's pending count.
 */

export const FIXED_WINDOW_EMISSION_WINDOW_MS = 60_000;
export const FIXED_WINDOW_EMISSION_MAX_ENTRIES = 10_000;

/**
 * Why a suppressed count was materialised into a rollup. The canonical
 * vocabulary for the `flushedBy` facet consumers stamp on that rollup — a query
 * that cannot tell an expiry drain from an LRU eviction cannot tell a quiet key
 * from keyspace pressure.
 *
 * `Window` is produced by the CALLER, from `record`'s `flushedSuppressedCount`;
 * the other two are produced by this class through `onFlush`.
 */
export const EmissionRollupCause = {
  /** The key's next occurrence arrived and rolled its window over. */
  Window: "window",
  /** {@link FixedWindowEmissionThrottle.drainExpired} reclaimed a closed window. */
  Expiry: "expiry",
  /** The max-entry LRU cap dropped the key while it still held a count. */
  Eviction: "eviction",
} as const;
export type EmissionRollupCause =
  (typeof EmissionRollupCause)[keyof typeof EmissionRollupCause];

/** The subset of {@link EmissionRollupCause} this class itself can raise. */
export type EmissionThrottleFlushCause = Exclude<
  EmissionRollupCause,
  typeof EmissionRollupCause.Window
>;

type ThrottleEntry<TContext> = {
  /** When the current window ends; an occurrence at or after this resets it. */
  resetAt: number;
  /**
   * When this entry last moved to the Map's tail. The Map is therefore ordered
   * by this field ascending, which is what lets {@link
   * FixedWindowEmissionThrottle.drainExpired} stop at the first live entry
   * instead of scanning.
   */
  lastTouchedAt: number;
  /** Occurrences already emitted in the CURRENT window, capped at `maxPerWindow`. */
  emittedCount: number;
  /** Occurrences suppressed in the CURRENT window after the budget was spent. */
  suppressedCount: number;
  /**
   * The caller's own key parts, kept so an eviction flush can name what it is
   * flushing without parsing the composite key back apart.
   */
  context: TContext;
};

/**
 * The decision returned for one occurrence.
 *
 * - `emit`: whether THIS occurrence should emit its own single event (true while
 *   the key's per-window emission budget is unspent — the first occurrence only,
 *   unless `maxPerWindow` raises the budget).
 * - `flushedSuppressedCount`: when a fresh window opens, how many occurrences
 *   the just-closed window suppressed for this key, to be emitted as an
 *   aggregate rollup. `0` when nothing was suppressed or the window did not
 *   roll over. This branch only runs when ANOTHER occurrence for the SAME key
 *   arrives, so it is not on its own a completeness guarantee — see the module
 *   docstring and `drainExpired`.
 */
export type EmissionThrottleDecision = {
  emit: boolean;
  flushedSuppressedCount: number;
};

/**
 * Called when a key that still holds suppressed occurrences is dropped — by the
 * max-entry cap or by an expiry drain — so the pending rollup is emitted rather
 * than discarded. `suppressedCount` is always positive, and `cause` says which
 * of the two dropped it.
 */
export type EmissionThrottleFlushHandler<TContext> = (
  context: TContext,
  suppressedCount: number,
  cause: EmissionThrottleFlushCause
) => void;

export type FixedWindowEmissionThrottleOptions<TContext> = {
  windowMs?: number;
  maxEntries?: number;
  /**
   * How many events ONE key may emit per window before the rest are suppressed
   * into its rollup. Defaults to 1 — the per-key dedup this class started as.
   *
   * Raised above 1 by a caller using a COARSE key as a spending budget rather
   * than a correlation key (#5209 review): a stable `(org, reason)` key that a
   * finer key's churn cannot evict, holding a hard ceiling on how many distinct
   * finer occurrences may be reported per window.
   */
  maxPerWindow?: number;
  /**
   * Sink for suppressed counts flushed by LRU eviction. Defaults to a no-op so a
   * caller that does not wire it up simply loses the eviction flush (never
   * throws); production instances wire it to their aggregate emitter.
   */
  onFlush?: EmissionThrottleFlushHandler<TContext>;
};

const EMIT_FIRST: EmissionThrottleDecision = {
  emit: true,
  flushedSuppressedCount: 0,
};

const SUPPRESS: EmissionThrottleDecision = {
  emit: false,
  flushedSuppressedCount: 0,
};

/**
 * Entries live in a `Map`, never as object properties, so a crafted key part
 * cannot reach `__proto__`/`constructor` — no prototype-pollution surface. The
 * `Map` preserves insertion order, which the eviction path uses as an LRU proxy:
 * touching a key re-inserts it at the tail (see `touch`), so the head is always
 * the least-recently-used key.
 */
export class FixedWindowEmissionThrottle<TContext> {
  private readonly entries = new Map<string, ThrottleEntry<TContext>>();
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly maxPerWindow: number;
  private readonly onFlush: EmissionThrottleFlushHandler<TContext> | undefined;

  constructor(options: FixedWindowEmissionThrottleOptions<TContext> = {}) {
    this.windowMs = options.windowMs ?? FIXED_WINDOW_EMISSION_WINDOW_MS;
    this.maxEntries = options.maxEntries ?? FIXED_WINDOW_EMISSION_MAX_ENTRIES;
    // Floor at 1: a budget of 0 or a negative would silence the key entirely,
    // which is a monitoring outage rather than a throttle.
    this.maxPerWindow = Math.max(1, options.maxPerWindow ?? 1);
    this.onFlush = options.onFlush;
  }

  /**
   * Record one occurrence and decide whether it emits. `now` is injected rather
   * than read from the clock so callers — and tests — own the time source.
   *
   * The caller has already handled the underlying condition before calling this
   * and acts only on the returned decision, so a throttling bug can never change
   * the behavior being observed.
   */
  record(
    key: string,
    context: TContext,
    now: number
  ): EmissionThrottleDecision {
    return this.recordOccurrences(key, context, now, 1);
  }

  /**
   * Record one bounded emission carrying several additive occurrences.
   *
   * The emission budget still counts LOG EVENTS, while suppressed accounting
   * retains the supplied occurrence weight. This lets one failed batch emit a
   * single bounded diagnostic without collapsing its affected-row count to one.
   */
  recordOccurrences(
    key: string,
    context: TContext,
    now: number,
    occurrences: number
  ): EmissionThrottleDecision {
    if (!Number.isSafeInteger(occurrences) || occurrences < 1) {
      throw new RangeError("occurrences must be a positive safe integer");
    }
    const current = this.entries.get(key);

    if (!current) {
      this.entries.set(key, {
        resetAt: now + this.windowMs,
        lastTouchedAt: now,
        emittedCount: 1,
        suppressedCount: 0,
        context,
      });
      this.evictOverflow();
      return EMIT_FIRST;
    }

    if (now >= current.resetAt) {
      const flushedSuppressedCount = current.suppressedCount;
      current.resetAt = now + this.windowMs;
      current.emittedCount = 1;
      current.suppressedCount = 0;
      current.context = context;
      this.touch(key, current, now);
      return flushedSuppressedCount > 0
        ? { emit: true, flushedSuppressedCount }
        : EMIT_FIRST;
    }

    this.touch(key, current, now);
    if (current.emittedCount < this.maxPerWindow) {
      current.emittedCount += 1;
      return EMIT_FIRST;
    }
    current.suppressedCount += occurrences;
    return SUPPRESS;
  }

  /**
   * Flush and drop every key whose window is certainly over, so a burst
   * followed by quiet on that key still reaches the aggregate instead of
   * sitting in memory until the SAME key is touched again or the map overflows
   * (#5508 review, whitlockk). Call it from a terminal path the process already
   * runs on every request; there is deliberately no timer, because a frozen
   * serverless instance would never fire one.
   *
   * Bounded, and cheap enough for a hot path. The Map is ordered by
   * `lastTouchedAt` ascending, and a pending entry is always touched strictly
   * before its own `resetAt`, so `resetAt <= lastTouchedAt + windowMs`. Walking
   * from the head while `now - lastTouchedAt >= windowMs` therefore visits only
   * keys that are certainly expired, plus at most ONE that is not, and stops —
   * O(1) when nothing has expired.
   *
   * The residual that rule accepts: a key touched mid-window closes earlier
   * than `lastTouchedAt + windowMs`, so it is drained by a later call rather
   * than this one. That bounds the lag at under two windows instead of
   * eliminating it, and it never flushes a window that is still live.
   *
   * Returns how many keys were dropped.
   */
  drainExpired(now: number): number {
    let dropped = 0;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastTouchedAt < this.windowMs) {
        return dropped;
      }
      this.entries.delete(key);
      dropped += 1;
      if (entry.suppressedCount > 0 && this.onFlush) {
        this.onFlush(
          entry.context,
          entry.suppressedCount,
          EmissionRollupCause.Expiry
        );
      }
    }
    return dropped;
  }

  /** How many keys are resident. The bound this class exists to hold. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Drop all state WITHOUT flushing. A test-isolation affordance, not a
   * shutdown drain — pending suppressed counts are discarded, which is why
   * production code must not call it.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Move a just-accessed key to the tail so the Map's head stays the
   * least-recently-used key for `evictOverflow`.
   */
  private touch(
    key: string,
    entry: ThrottleEntry<TContext>,
    now: number
  ): void {
    entry.lastTouchedAt = now;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  /**
   * Enforce the hard max-entry cap by evicting least-recently-used keys. An
   * evicted key that still holds suppressed occurrences is flushed through
   * `onFlush` so its count reaches the additive total rather than being dropped.
   */
  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.entries().next().value;
      if (oldest === undefined) {
        return;
      }
      const [oldestKey, oldestEntry] = oldest;
      this.entries.delete(oldestKey);
      if (oldestEntry.suppressedCount > 0 && this.onFlush) {
        this.onFlush(
          oldestEntry.context,
          oldestEntry.suppressedCount,
          EmissionRollupCause.Eviction
        );
      }
    }
  }
}
