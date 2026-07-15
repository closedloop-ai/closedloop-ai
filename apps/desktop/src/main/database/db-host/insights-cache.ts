/**
 * FEA-2055 — db-host insights result cache + anti-stampede gate.
 *
 * The first-launch dashboard fires three `dashboard.getInsights` requests
 * concurrently (Delivery, Utilization, Agents), each running 5–9 heavy aggregate
 * queries over a multi-million-row `events` table inside the db-host
 * utilityProcess. Firing them all at once (and recomputing on every view /
 * section-or-period toggle, and on every write during the first-launch backfill)
 * stampeded the child and tipped V8 into OOM (exit code 5).
 *
 * This module sits in front of the native `computeLocalInsights` call in the
 * db-host worker and provides four things, all in-process (no IPC change):
 *
 *  1. Result cache  — the computed JSON response is memoized by (section,period).
 *     A hit at the current data epoch returns immediately; no recompute.
 *  2. Epoch invalidation — every committed DB write bumps a monotonic
 *     `dataEpoch`. A cached entry computed at epoch N is stale once the epoch
 *     advances past N.
 *  3. Backfill debounce — during the backfill the epoch advances constantly.
 *     Rather than recompute on every change, a stale entry is still SERVED as
 *     long as it was recomputed within the last `staleServeCooldownMs`; the next
 *     request after the cooldown triggers exactly one recompute. The dashboard
 *     shows slightly-stale-but-present data during backfill instead of crashing.
 *  4. Single-flight + concurrency bound — concurrent requests for the same key
 *     share ONE in-flight computation, and a semaphore caps how many DIFFERENT
 *     computations run at once (default 1). The rest queue. Peak db-host memory
 *     is bounded to a single insights computation, not ~21 concurrent queries.
 *
 * Golden-safety: a cache MISS calls the supplied `compute` fn verbatim and
 * returns its result unchanged. Nothing is re-serialized or transformed, so a
 * miss yields a byte-identical value to calling `computeLocalInsights` directly.
 * The cache only ever holds a handful of small JSON responses, never raw rows.
 */

/** Cooldown before a stale (epoch-advanced) entry triggers a recompute. */
const DEFAULT_STALE_SERVE_COOLDOWN_MS = 4000;
/** Max insights computations allowed to run concurrently across keys. */
const DEFAULT_MAX_CONCURRENCY = 1;

type CacheEntry = {
  /** The memoized response value (a small JSON-able POJO). */
  value: unknown;
  /** dataEpoch at which `value` was computed. */
  computedAtEpoch: number;
  /** Date.now() at which `value` was last (re)computed. */
  computedAtMs: number;
};

type InsightsCacheOptions = {
  staleServeCooldownMs?: number;
  maxConcurrency?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
};

export class InsightsResultCache {
  private dataEpoch = 0;
  private readonly entries = new Map<string, CacheEntry>();
  /** Single-flight: one shared promise per key while a compute is in flight. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Concurrency gate: FIFO waiters released as running slots free up. */
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  private readonly staleServeCooldownMs: number;
  private readonly maxConcurrency: number;
  private readonly now: () => number;

  constructor(options: InsightsCacheOptions = {}) {
    this.staleServeCooldownMs =
      options.staleServeCooldownMs ?? DEFAULT_STALE_SERVE_COOLDOWN_MS;
    this.maxConcurrency = Math.max(
      1,
      options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
    );
    this.now = options.now ?? Date.now;
  }

  /** Advance the data epoch — call once per committed DB write boundary. */
  bumpDataEpoch(): void {
    this.dataEpoch++;
  }

  /** Current epoch (exposed for tests/diagnostics). */
  get epoch(): number {
    return this.dataEpoch;
  }

  /**
   * Resolve an insights request, applying cache → debounce → single-flight →
   * concurrency-bound, in that order. `compute` is the native, golden-identical
   * computation; it runs only on a real miss/recompute.
   *
   * `compute` receives a `markReadStart` callback. By default the entry's
   * freshness epoch is snapshotted when `compute` is INVOKED, but a caller that
   * defers the actual data read behind an unrelated wait (e.g. the shared
   * heavy-op gate) should call `markReadStart()` at the true read moment so the
   * recorded epoch reflects when the data was read — not time spent waiting on
   * the gate. Not calling it keeps the invoke-time snapshot.
   */
  get(
    key: string,
    compute: (markReadStart: () => void) => Promise<unknown>
  ): Promise<unknown> {
    const entry = this.entries.get(key);
    if (entry) {
      // Fresh: computed at the current epoch — nothing changed since.
      if (entry.computedAtEpoch === this.dataEpoch) {
        return Promise.resolve(entry.value);
      }
      // Stale but inside the cooldown: serve last-good without recomputing.
      // This is the backfill anti-thrash path — the epoch is churning, so we
      // intentionally hold off on recompute and return present-but-stale data.
      if (this.now() - entry.computedAtMs < this.staleServeCooldownMs) {
        return Promise.resolve(entry.value);
      }
    }

    // Single-flight: a concurrent identical request shares this computation.
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.computeAndStore(key, compute).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Acquire a concurrency slot, compute, store, release. */
  private async computeAndStore(
    key: string,
    compute: (markReadStart: () => void) => Promise<unknown>
  ): Promise<unknown> {
    await this.acquire();
    // Snapshot the epoch at the read boundary: any write that lands during the
    // read advances the epoch, so the entry is correctly marked stale and the
    // next request (after cooldown) recomputes against fresh data. Default the
    // snapshot to compute-invocation time, but let the caller move it to the
    // true read moment via `markReadStart` — so a long wait on the heavy-op gate
    // (behind a backfill) doesn't back-date the entry and force needless
    // recomputes.
    let epochAtRead = this.dataEpoch;
    const markReadStart = () => {
      epochAtRead = this.dataEpoch;
    };
    try {
      const value = await compute(markReadStart);
      this.entries.set(key, {
        value,
        computedAtEpoch: epochAtRead,
        computedAtMs: this.now(),
      });
      return value;
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

/** Stable cache key for a getInsights invocation. Scope is folded in for safety. */
export function insightsCacheKey(args: unknown[]): string {
  return args.map((arg) => String(arg ?? "")).join("|");
}
