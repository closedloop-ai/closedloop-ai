/**
 * @file post-boot-maintenance-idle-reschedule.ts
 * @description ISS-8601 — re-arm post-boot maintenance after a boot import the
 * FEA-4156 watchdog gave up on.
 *
 * A `timedOut` boot import used to drop the DATA_REVISION rebuild and the
 * artifact-link backfill for the whole launch, so a machine whose first import
 * wedged never re-derived anything until its next restart — and if the wedge was
 * reproducible, never at all. That is the unbounded-retry shape PRD-699 exists to
 * remove: a failure path with no terminal state and no recovery door.
 *
 * The watchdog's refusal is still right AT THE MOMENT IT FIRES. Maintenance then
 * would queue onto the wedged import boundary while the first-launch splash is
 * still on screen. What this module adds is the LATER attempt: wait for the
 * renderer to go quiet, then run it once. By then the splash has long resolved
 * into its graceful partial-import state — `getPhase` latches `NeedsAttention` on
 * a degraded terminal — so there is no Compute step left to strand.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not wait for the import to become HEALTHY. Renderer idleness is not
 *    the same signal, and gating on the wedge clearing would mean a permanently
 *    wedged import never re-arms — restoring the very unboundedness this fixes.
 *    The ceiling below can therefore fire into a still-wedged host, where the
 *    pass is generation-guarded, `shouldContinue`-gated and cooperative. Session
 *    egress remains held while it stalls, but only until maintenance settles or
 *    the bounded session-projection fail-open releases it.
 *  - It does not claim the import finished. Its caller runs maintenance with the
 *    readiness claim suppressed; see `claimImportComplete` in the runtime.
 */

/** How often to ask whether the renderer has gone quiet. */
export const POST_BOOT_MAINTENANCE_IDLE_POLL_MS = 60_000;

/**
 * The hard bound. A continuously-used renderer must not defer the owed rebuild
 * forever, so once this elapses maintenance runs whether or not the renderer
 * ever went idle — the terminal path PRD-699 requires of every retry loop.
 */
export const POST_BOOT_MAINTENANCE_IDLE_CEILING_MS = 15 * 60_000;

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * The timer pair, injected so tests drive the schedule deterministically instead
 * of waiting on a real clock or faking a global one.
 */
export type IdleRescheduleTimers = {
  set: (fn: () => void, ms: number) => TimerHandle;
  clear: (handle: TimerHandle) => void;
};

export type IdleRescheduleDeps = {
  /**
   * The process's renderer-activity signal — the max of the last trusted DB IPC
   * read and the last user-input event. Absent means "nothing is watching", which
   * reads as idle.
   */
  hasRecentRendererRead?: () => boolean;
  /** Fired exactly once. */
  run: () => void;
  log: (message: string) => void;
  pollMs?: number;
  ceilingMs?: number;
  /** Milliseconds since the epoch; only the ceiling reads it. */
  now?: () => number;
  timers?: IdleRescheduleTimers;
};

const defaultTimers: IdleRescheduleTimers = {
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    // Never hold the process open for a background re-arm.
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle),
};

/**
 * Run `run` once, at the first renderer idle, or at the ceiling — whichever
 * comes first.
 *
 * `cancel()` both clears the pending timer and latches, so a timer that has
 * already been handed to the event loop cannot fire afterwards.
 */
export function scheduleWhenRendererIdle(deps: IdleRescheduleDeps): {
  cancel: () => void;
} {
  const pollMs = deps.pollMs ?? POST_BOOT_MAINTENANCE_IDLE_POLL_MS;
  const ceilingMs = deps.ceilingMs ?? POST_BOOT_MAINTENANCE_IDLE_CEILING_MS;
  const timers = deps.timers ?? defaultTimers;
  const now = deps.now ?? (() => Date.now());
  const isBusy = deps.hasRecentRendererRead ?? (() => false);

  const startedAt = now();
  let settled = false;
  let timer: TimerHandle | null = null;

  const fire = (reason: string): void => {
    settled = true;
    timer = null;
    deps.log(
      `post-boot maintenance re-armed after a timed-out boot import (${reason})`
    );
    deps.run();
  };

  const poll = (): void => {
    if (settled) {
      return;
    }
    timer = null;
    // The ceiling is checked FIRST: once it has elapsed the answer is the same
    // whatever the renderer is doing, and checking idleness first would let a
    // busy renderer defer one more full interval past the bound.
    if (now() - startedAt >= ceilingMs) {
      fire(
        `renderer still active after ${Math.round(ceilingMs / 1000)}s; running anyway`
      );
      return;
    }
    if (isBusy()) {
      timer = timers.set(poll, pollMs);
      return;
    }
    fire("renderer idle");
  };

  timer = timers.set(poll, pollMs);

  return {
    cancel: () => {
      settled = true;
      if (timer) {
        timers.clear(timer);
        timer = null;
      }
    },
  };
}
