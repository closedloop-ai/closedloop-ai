/**
 * @file sync-lane-quiesce.ts
 * @description ISS-4903 — bounded quiescence for the desktop background sync
 * lanes, so shutdown can drain the db-host CONSUMERS before the db-host itself
 * is disposed.
 *
 * ISS-4713 added a bounded drain inside `DbHostClient.close()` — it awaits the
 * in-flight *invokes* the client already knows about. That is the last line of
 * defence, not the first: a lane sitting between two awaits when close() runs
 * has no invoke in flight yet, issues its next read/write against a disposed
 * handle, and fails with `db-host exited (code: 0)` AFTER the shutdown sequence
 * has already declared itself `clean`.
 *
 * The missing piece is upstream: stop each lane's timers (which `stop()`
 * already does), then WAIT for the detached task each lane has in the air, and
 * report honestly when one of them did not settle inside its budget. A lane
 * that cannot drain is cancelled deliberately and named in the shutdown
 * verdict — `clean` must mean nothing was still running.
 *
 * Everything here is bounded: no unbounded waits, no swallowed failures. A lane
 * that rejects still counts as DRAINED (it settled; its own error handling
 * owns the failure), while a lane that never settles inside the budget is
 * reported as un-quiesced so the caller can degrade the shutdown verdict.
 *
 * ISS-5262 — what this file does NOT cover, and why that is now fine. Draining
 * is only reachable for a lane that HAS a bounded `quiesce`; today that is the
 * transcript archive lane alone (see `quiesceDesktopSyncLanes` below). The
 * agent-session sync lane, the harness collectors and the dashboard read IPC are
 * only `stop()`ped, so a tick already in the air still lands on the disposed
 * db-host — which is how `sync failed:`, `collector claude import failed:`,
 * `ipc perf session_count query failed:` and the
 * `desktop:shared-agent-sessions:usage` handler errors kept arriving AFTER this
 * sequence reported `clean`. Rather than grow four more quiesce
 * implementations (and four more budgets shutdown must pay), ISS-5262 made the
 * residual landing HONEST at the other end: `DbHostShutdownError`
 * (`shared/db-host-shutdown-error.ts`) marks a graceful teardown
 * exit, and each of those consumers reports abandonment instead of failure.
 * Quiescing is still the preferred fix for any lane that can afford one —
 * draining beats classifying — this is the floor beneath it.
 */

/**
 * Outcome of a bounded quiesce: either every tracked task settled inside the
 * budget, or the budget elapsed first and work is still in the air.
 */
export const QuiesceOutcome = {
  Drained: "drained",
  TimedOut: "timed_out",
} as const;
export type QuiesceOutcome =
  (typeof QuiesceOutcome)[keyof typeof QuiesceOutcome];

/**
 * A lane service that can be asked to settle within a budget. The timer seam is
 * forwarded so a test can drive the deadline without the wall clock.
 */
export type QuiescibleSyncLaneService = {
  quiesce(budgetMs: number, deps?: QuiesceTimerDeps): Promise<QuiesceOutcome>;
};

/** A named lane the shutdown path can ask to settle within a budget. */
export type QuiescibleLane = {
  /** Stable identifier used in the shutdown verdict / diagnostics. */
  readonly name: string;
  quiesce(budgetMs: number): Promise<QuiesceOutcome>;
};

export type QuiesceTimerDeps = {
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

/**
 * Tracks the detached ("fire and forget") tasks a lane has in the air so
 * shutdown can await their tail.
 *
 * The set is self-pruning — every tracked task removes itself on settle — so it
 * cannot grow without bound while the app runs. Tracking is deliberately
 * rejection-tolerant: a task that rejects is still a task that SETTLED, and the
 * lane's own catch handler owns the failure. This class never swallows a
 * rejection it did not create; `track` returns the original promise untouched.
 */
export class BackgroundTaskTracker {
  private readonly pending = new Set<Promise<void>>();

  /**
   * Register a detached task. Registration only — it returns nothing and takes
   * no ownership of the caller's promise, so the lane must still attach its own
   * catch (tracking is not a rejection handler).
   */
  track(work: Promise<unknown>): void {
    // Track a settle SIGNAL rather than the caller's promise: the signal never
    // rejects, so nothing here can create an unhandled rejection of its own,
    // and the caller's promise keeps exactly one owner (the caller).
    let markSettled: () => void = () => {
      // Replaced synchronously by the executor below.
    };
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    this.pending.add(settled);
    const finish = (): void => {
      markSettled();
      this.pending.delete(settled);
    };
    work.then(finish, finish);
  }

  /** Number of tracked tasks still in the air. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Await the tracked tail, bounded by `budgetMs`. Resolves `drained` when every
   * task settled inside the budget and `timed_out` when the budget won. The
   * budget timer is cleared on BOTH branches, so neither path leaks a handle
   * that could hold the event loop open and delay process exit.
   */
  quiesce(
    budgetMs: number,
    deps: QuiesceTimerDeps = {}
  ): Promise<QuiesceOutcome> {
    const snapshot = [...this.pending];
    if (snapshot.length === 0) {
      return Promise.resolve(QuiesceOutcome.Drained);
    }
    const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    const expired = new Promise<QuiesceOutcome>((resolve) => {
      budgetTimer = setTimeoutFn(
        () => resolve(QuiesceOutcome.TimedOut),
        budgetMs
      );
      unrefTimer(budgetTimer);
    });
    const drained = Promise.all(snapshot).then(() => QuiesceOutcome.Drained);
    return Promise.race([drained, expired]).finally(() => {
      if (budgetTimer != null) {
        clearTimeoutFn(budgetTimer);
      }
    });
  }
}

/**
 * Quiesce every lane against a SHARED wall-clock budget and return the names of
 * the lanes that did not settle.
 *
 * Shared, not per-lane: lanes are quiesced concurrently (they do not depend on
 * one another), so N lanes can never cost N × budget of shutdown time. An empty
 * result means every lane drained — the only state in which the shutdown
 * sequence may honestly report `clean`.
 *
 * A lane whose `quiesce` itself REJECTS is reported as un-quiesced rather than
 * being allowed to abort the teardown: a lane that cannot even tell us whether
 * it drained is exactly the case the honest verdict exists for.
 */
export async function quiesceSyncLanes(
  lanes: readonly QuiescibleLane[],
  budgetMs: number
): Promise<readonly string[]> {
  if (lanes.length === 0) {
    return [];
  }
  const outcomes = await Promise.all(
    lanes.map(async (lane) => {
      try {
        return { name: lane.name, outcome: await lane.quiesce(budgetMs) };
      } catch {
        return { name: lane.name, outcome: QuiesceOutcome.TimedOut };
      }
    })
  );
  const unquiesced: string[] = [];
  for (const { name, outcome } of outcomes) {
    if (outcome === QuiesceOutcome.TimedOut) {
      unquiesced.push(name);
    }
  }
  return unquiesced;
}

/**
 * Budget for the pre-teardown lane drain.
 *
 * Sized to match `CLOSE_DRAIN_TIMEOUT_MS` in `db-host-client.ts` — the two are
 * the same guarantee at two layers (drain the CONSUMERS here, then the client's
 * own in-flight invokes there), so a lane gets the same grace either way. The
 * outer before-quit hard exit is 8s and the shutdown sequence's own deadline is
 * 5s, both of which this must stay comfortably inside: shutdown may be slower,
 * never unbounded.
 */
export const SYNC_LANE_QUIESCE_BUDGET_MS = 2000;

/** Lane name reported in the shutdown verdict for the transcript archive lane. */
export const TRANSCRIPT_SYNC_LANE_NAME = "transcriptSync.quiesce";

/**
 * ISS-4903 — drain the desktop background sync lanes that hold db-host work,
 * and name the ones still running when the budget elapsed.
 *
 * Called from `DesktopApplication.shutdown()` between "stop the lane timers" and
 * "dispose the db-host". An absent lane (feature off, never constructed) is
 * simply not a lane — it drains vacuously rather than being reported.
 *
 * Only the transcript archive lane is wired today; the session/component lanes
 * are stopped by `stopAgentCapture` and drained by the db-host client's own
 * in-flight drain. Add a lane here by giving it a bounded `quiesce` and pushing
 * it into the array — the verdict plumbing is lane-count agnostic.
 */
export function quiesceDesktopSyncLanes(
  transcriptSync: QuiescibleSyncLaneService | null | undefined,
  budgetMs: number = SYNC_LANE_QUIESCE_BUDGET_MS,
  deps: QuiesceTimerDeps = {}
): Promise<readonly string[]> {
  const lanes: QuiescibleLane[] = [];
  if (transcriptSync) {
    lanes.push({
      name: TRANSCRIPT_SYNC_LANE_NAME,
      quiesce: (ms) => transcriptSync.quiesce(ms, deps),
    });
  }
  return quiesceSyncLanes(lanes, budgetMs);
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: () => void }).unref;
  if (typeof maybeUnref === "function") {
    maybeUnref.call(timer);
  }
}
