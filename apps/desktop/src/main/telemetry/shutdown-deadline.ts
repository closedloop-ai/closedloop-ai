/**
 * ISS-4585: hard upper bound on the shutdown telemetry drain. The per-transport
 * flush timeouts (1500ms) are the intended drain budget, so this sits just above
 * them as a fail-fast backstop for a transport that ignores its own deadline (a
 * wedged keepalive socket, the keyless OTel `collector_unavailable` path). A hung
 * telemetry flush must never block process shutdown — an unbounded flush left
 * `desktop-dev` force-killed with SIGKILL (137).
 */
export const OBSERVABILITY_SHUTDOWN_DEADLINE_MS = 2000;

/** Per-transport flush budget, kept just below the overall deadline above. */
export const TELEMETRY_TRANSPORT_FLUSH_TIMEOUT_MS = 1500;

/**
 * A best-effort telemetry flush thunk. May be absent (transport not
 * configured), in which case {@link drainTelemetryWithDeadline} treats it as an
 * immediately-resolved no-op.
 */
export type TelemetryFlush =
  | ((options: { timeoutMs: number }) => Promise<void>)
  | null
  | undefined;

/**
 * Drain the given best-effort telemetry transports, bounded by `deadlineMs`.
 * Each configured transport is given its own
 * {@link TELEMETRY_TRANSPORT_FLUSH_TIMEOUT_MS} budget; the whole drain is then
 * raced against the hard deadline so a transport that ignores its own timeout
 * (a wedged keepalive socket / the keyless OTel `collector_unavailable` path)
 * can never wedge process exit. Failures are swallowed (`allSettled`) —
 * shutdown telemetry is best-effort and must not change control flow.
 */
export function drainTelemetryWithDeadline(
  flushes: readonly TelemetryFlush[],
  deadlineMs: number = OBSERVABILITY_SHUTDOWN_DEADLINE_MS
): Promise<void> {
  const drain = Promise.allSettled(
    flushes.map(
      (flush) =>
        flush?.({ timeoutMs: TELEMETRY_TRANSPORT_FLUSH_TIMEOUT_MS }) ??
        Promise.resolve()
    )
  );
  return raceShutdownDeadline(drain, deadlineMs);
}

/**
 * Await `work` but never longer than `deadlineMs`. If `work` settles first its
 * outcome is preserved — a resolution resolves this, and a REJECTION propagates
 * so the caller's own error handling (e.g. `shutdownDesktopOtelRuntime`'s
 * warn-and-continue catch) still runs. If the deadline wins, the still-pending
 * `work` is abandoned (best-effort shutdown flush) and this resolves so the
 * caller can proceed to exit; a LATE rejection of that abandoned work is then
 * silently swallowed so it cannot surface as an unhandled rejection. The
 * deadline timer is always cleared on the winning branch (no leak) and is
 * `unref`'d so an abandoned still-hung `work` timer cannot keep the event loop
 * alive and delay exit.
 */
export async function raceShutdownDeadline(
  work: Promise<unknown>,
  deadlineMs: number = OBSERVABILITY_SHUTDOWN_DEADLINE_MS
): Promise<void> {
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, deadlineMs);
    const maybeUnref = (deadlineTimer as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") {
      maybeUnref.call(deadlineTimer);
    }
  });
  const guardedWork = work.then(() => undefined);
  try {
    // If work wins with a rejection it propagates here (caller's error handling
    // still runs). If the deadline wins we resolve and abandon `work`.
    await Promise.race([guardedWork, deadline]);
  } finally {
    if (deadlineTimer != null) {
      clearTimeout(deadlineTimer);
    }
    // Attach a terminal handler so a LATE rejection of abandoned work (the
    // deadline-won case) cannot surface as an unhandled rejection. On the
    // work-won path `guardedWork` is already settled, so this is a no-op.
    guardedWork.catch(() => undefined);
  }
}
