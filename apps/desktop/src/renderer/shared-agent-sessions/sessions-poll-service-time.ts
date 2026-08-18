/**
 * @file sessions-poll-service-time.ts
 * @description Hold the desktop Sessions fallback poll's duty cycle flat at ~50%
 * by deriving its interval from the observed service time, so a growing corpus
 * cannot push the poll toward saturating the bounded read lane.
 *
 * ## What this does, and what it does NOT do
 *
 * On a FIXED 2000 ms interval the poll's duty cycle is `S / (S + 2000)`, which
 * climbs with the read cost `S`: ~51% at the 2.1 s read measured here, but ~83%
 * at a 10 s read. Deriving the interval from `S` instead pins it at ~50% for any
 * `S`. That is the whole of this module's claim — a guardrail against corpus
 * growth, bounded above by a ceiling so a pathological read cannot leave the list
 * stale indefinitely.
 *
 * It is explicitly NOT a fix for lane contention, and the earlier framing of it as
 * one was wrong. A single `pageData` observer does not outrun its own read:
 * `QueryObserver.onQueryUpdate()` clears and restarts the interval when a fetch
 * settles, and a tick arriving mid-flight is deduplicated by `Query.fetch()`
 * rather than enqueued (verified against the installed `@tanstack/query-core`,
 * and measured — max concurrency is 1 both before and after this change). The old
 * cycle was ~S+2000 and this makes it ~2S; at the measured 2.1 s read that is a
 * ~1 percentage-point change in duty cycle, which cannot explain a permanently
 * occupied lane.
 *
 * ## Where the measured contention actually comes from
 *
 *   probe alone              0% missed   lane queued   0%   wait p90     0 ms
 *   + the 2 s poll        17.6% missed   lane queued 100%   wait p90  6169 ms
 *   + the sync drain       100% missed   lane queued 100%   wait p50 14268 ms
 *
 * `lane queued` goes to 100% the instant ANY poll exists, at a duty cycle nowhere
 * near saturation — because the contention is WITHIN a request, not between
 * polls. See `db-host-op-lanes.ts`: `SESSIONS_PAGE_MAX_CONCURRENT_BOUNDED_OPS`
 * (4) exceeds `BOUNDED_READ_OP_LIMIT` (2), so one fully-filtered Sessions request
 * queues against itself. The 100%-missed row needs the cloud-sync drain, which
 * arrives under the same op name and draws from the same two permits.
 *
 * Neither is addressed here. Each polled query still owns an independent timer,
 * this estimate does not phase them or reserve a permit, and the detail poll stays
 * fixed. Coordinating or rate-limiting the contending producers is separate work
 * (ISS-5993 candidates 1-3); the db-host lane instrumentation that ships alongside
 * this — the queue-wait vs execution split in `db-host-profiling.ts` — is what
 * localized the problem and what will answer it from a real run.
 *
 * ## Why backing off is safe here
 *
 * This poll is a FALLBACK HEAL, not the freshness path. Desktop Sessions data is
 * push-driven off the local DB's `desktop:db:changed` stream; the poll exists
 * only because that bridge is visibility-gated and a permanently-hidden renderer
 * (CI/offscreen Electron) can defer a flush forever (FEA-2187). Healing a missed
 * flush a little later is strictly better than a poll whose cadence tracks a read
 * cost it has no control over.
 *
 * ## The rule
 *
 * Wait at least as long as the last read took before scheduling the next one.
 * React Query restarts the interval after a fetch settles, so an interval equal
 * to the service time yields a duty cycle of at most 50%. See
 * {@link nextPollIntervalMs}.
 */

/**
 * Smoothing factor for the service-time estimate. Deliberately favours history
 * (0.3 on the new sample) so one anomalous read — a cold page cache, a GC pause,
 * a machine briefly under someone else's load — cannot slam the cadence to the
 * ceiling and leave the list stale for half a minute.
 */
const DEFAULT_SERVICE_TIME_ALPHA = 0.3;

/**
 * A running estimate of how long the polled read takes.
 *
 * Holds ONE number, not a per-query map, and that is deliberate: the estimate
 * feeds a cadence decision, the Sessions surface has effectively one active
 * page-data query at a time, and a single accumulator cannot grow without bound
 * no matter how many query keys pass through it.
 */
export type ServiceTimeTracker = {
  /** Fold one observed read duration into the estimate. */
  record(ms: number): void;
  /** The current estimate, or `null` before the first usable sample. */
  observedMs(): number | null;
};

/**
 * Track observed service time as an exponentially-weighted moving average.
 *
 * Non-finite and negative samples are DROPPED rather than folded. A clock that
 * jumps backwards (or a caller that subtracts stamps in the wrong order) would
 * otherwise poison the estimate, and the failure mode of a poisoned estimate is
 * a Sessions list that stops refreshing — worse than the bug being fixed.
 */
export function createServiceTimeTracker(
  alpha: number = DEFAULT_SERVICE_TIME_ALPHA
): ServiceTimeTracker {
  let estimate: number | null = null;
  return {
    record(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) {
        return;
      }
      estimate = estimate === null ? ms : alpha * ms + (1 - alpha) * estimate;
    },
    observedMs: () => estimate,
  };
}

/**
 * The interval to wait before the next poll, given what the last reads cost.
 *
 * `floorMs` is returned whenever there is no usable estimate yet, which makes
 * the pre-measurement behaviour byte-identical to the fixed interval this
 * replaces — so a build where the observation wiring never fires degrades to
 * exactly today's cadence rather than to something unpredictable.
 *
 * `ceilingMs` bounds how stale a hidden renderer's list can get. Without it a
 * pathologically slow read would push the heal poll arbitrarily far out, which
 * would reintroduce the FEA-2187 stuck-list bug from the other direction.
 */
export function nextPollIntervalMs(opts: {
  observedServiceMs: number | null;
  floorMs: number;
  ceilingMs: number;
}): number {
  const { observedServiceMs, floorMs, ceilingMs } = opts;
  // A ceiling below the floor is a caller error; prefer the floor so the poll
  // keeps its guaranteed minimum cadence instead of collapsing to a bad bound.
  const ceiling = Math.max(floorMs, ceilingMs);
  if (observedServiceMs === null || !Number.isFinite(observedServiceMs)) {
    return floorMs;
  }
  return Math.min(ceiling, Math.max(floorMs, Math.ceil(observedServiceMs)));
}
