import { encodeSseData } from "@/lib/sse-stream";

/** Cadence while an org's compute targets are actively changing. */
export const POLL_INTERVAL_MS = 5000;

/**
 * Cadence once a stream has been quiet for `IDLE_BACKOFF_AFTER_MS`.
 *
 * Held well under `COMPUTE_TARGET_STALE_MS` (90s, `../service.ts`) — but that
 * cutoff governs only when an offline flip is WRITTEN, not when this stream
 * observes it. The staleness sweep writes the flip once a target's `lastSeenAt`
 * passes the cutoff; this stream then surfaces it on its next poll, so a client
 * watching an idle stream can wait up to `IDLE_POLL_INTERVAL_MS` for it instead
 * of `POLL_INTERVAL_MS`. Observation latency is therefore cadence-bound for
 * offline flips just as it is for online ones (which are written immediately on
 * connect).
 *
 * That added latency is the deliberate trade for collapsing the idle poll
 * treadmill: it applies only while nothing is happening, and any observed
 * change drops the stream straight back to `POLL_INTERVAL_MS`.
 */
export const IDLE_POLL_INTERVAL_MS = 30_000;

/** Quiet period a stream must observe before widening to the idle cadence. */
export const IDLE_BACKOFF_AFTER_MS = 60_000;

/**
 * Self-imposed stream lifetime, measured from request entry rather than from
 * stream construction. Deliberately below the route's platform `maxDuration` so
 * the routine termination is a graceful end-of-stream that the client
 * reconnects from, rather than the function being killed at the ceiling and
 * logging a `Vercel Runtime Timeout Error` (FEA-3302). The ordering against
 * `maxDuration` is asserted in `route.test.ts`.
 *
 * Setup — auth plus the initial snapshot — runs before the stream exists and
 * spends part of this budget, so the route derives the stream's own timer from
 * `remainingStreamDurationMs` instead of passing this value through.
 */
export const MAX_STREAM_DURATION_MS = 280_000;

/**
 * Floor for the derived stream budget, for the case where setup consumed the
 * whole window. A short stream that ends gracefully and is reconnected is still
 * the intended behavior; a zero or negative budget is not.
 */
export const MIN_STREAM_DURATION_MS = 1000;

export type StatusSnapshot = Map<string, boolean>;
type SendFn = (chunk: Uint8Array) => void;

/**
 * Emit one frame per target whose online state changed between snapshots.
 *
 * Returns whether anything was emitted. That boolean is the stream's activity
 * signal: a change keeps it on the base cadence, a clean no-op lets it widen.
 */
export function emitChanges(
  lastSnapshot: StatusSnapshot,
  current: StatusSnapshot,
  send: SendFn
): boolean {
  let changed = false;

  for (const [targetId, isOnline] of current) {
    if (lastSnapshot.get(targetId) !== isOnline) {
      send(encodeSseData({ targetId, isOnline }));
      changed = true;
    }
  }

  // Detect removed targets (went offline / deleted)
  for (const [targetId] of lastSnapshot) {
    if (!current.has(targetId)) {
      send(encodeSseData({ targetId, isOnline: false }));
      changed = true;
    }
  }

  return changed;
}

/**
 * Delay before the next poll, given how long the stream has gone without
 * activity. A failed read counts as activity rather than quiet — a lane that
 * cannot reach the database must not be rewarded with a slower retry.
 */
export function nextPollDelayMs(quietForMs: number): number {
  return quietForMs >= IDLE_BACKOFF_AFTER_MS
    ? IDLE_POLL_INTERVAL_MS
    : POLL_INTERVAL_MS;
}

/**
 * Stream budget left at construction, given when the request was admitted.
 *
 * The platform's clock starts at request entry, but the stream's timer cannot
 * start until auth and the initial snapshot have both resolved — and both can
 * block (the connection pool alone allows a 30s wait). Handing the stream the
 * full `MAX_STREAM_DURATION_MS` therefore makes the real lifetime
 * `setup + 280s`, which a slow-but-successful setup pushes past the 300s
 * ceiling: the function is killed before the graceful close can fire, which is
 * the exact failure FEA-3302 removes. Charging setup against the budget keeps
 * the total measured from entry. Floors at `MIN_STREAM_DURATION_MS` so an
 * extreme setup yields a short reconnectable stream rather than a
 * zero-or-negative timer.
 */
export function remainingStreamDurationMs(startedAt: number): number {
  return Math.max(
    MIN_STREAM_DURATION_MS,
    MAX_STREAM_DURATION_MS - (Date.now() - startedAt)
  );
}
