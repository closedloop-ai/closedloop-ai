import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { SpanErrorSource } from "@closedloop-ai/telemetry-contract/span";
import { log } from "@repo/observability/log";
import { resolveSpanErrorType } from "@repo/observability/telemetry/span-error-cause";
import { setAppSpanAttributes } from "@repo/observability/tracing/spans";
import {
  type EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
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
 * `remainingStreamDurationMs` (`@/lib/sse-stream`) instead of passing this
 * value through.
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

export const STATUS_POLL_FAILED_EVENT = "compute_target_status_poll_failed";

export const STATUS_SNAPSHOT_FAILED_EVENT =
  "compute_target_status_snapshot_failed";

/**
 * Emission bound: one line per ORG per window, with the failures the window
 * suppressed carried on the next line so the count survives the suppression. At
 * the base cadence an unreachable database yields one line a minute for the org
 * rather than twelve per stream, and `cl-api` bills four Datadog events per
 * request.
 */
export const POLL_FAILURE_LOG_INTERVAL_MS = 60_000;

export const SNAPSHOT_FAILURE_LOG_INTERVAL_MS = 60_000;

/** What one failed-read report is scoped to, and the throttle's key. */
type FailureScope = { organizationId?: string; phase?: "auth" };

/**
 * WHY THIS IS THROTTLED, AND WHY PER ORG RATHER THAN PER STREAM (#5646 review,
 * whitlockk). `apps/api/AGENTS.md` ("Emission and Abuse Control"): an alert emitted
 * per failed read is an amplification vector whenever an authenticated caller
 * can drive the path. Holding the window in the stream's own closure bounded
 * each stream and nothing else, so one authenticated caller opening N streams
 * turned a database outage into N lines per window — the bound scaled with the
 * caller's concurrency instead of bounding total emission.
 *
 * `FixedWindowEmissionThrottle` supplies both bounds at a stable choke point: at
 * most one line per organization per window plus one aggregate rollup, and a
 * hard max-entry LRU cap on the keyspace, since a map keyed on caller-reachable
 * input would otherwise trade a log leak for a memory leak (root `AGENTS.md`).
 * `organizationId` is the stable part of the key — streams come and go under it.
 *
 * The cost, stated rather than hidden: `consecutiveFailures` on an emitted line
 * describes the stream that won the window, not the org. The org-wide volume is
 * `suppressedSinceLastReport` beside it.
 *
 * Process-local and best-effort per serverless instance, matching
 * `orgAdminDenialThrottle`. Exported so tests can reset it between cases;
 * production code must not reach into it.
 */
const pollFailures = createFailureReporter(
  STATUS_POLL_FAILED_EVENT,
  POLL_FAILURE_LOG_INTERVAL_MS
);
export const pollFailureThrottle = pollFailures.throttle;

/**
 * The fetch consumer makes one initial attempt and at most ten reconnects
 * (2/4/8/16/30s capped backoff, 210s total delay), not indefinite EventSource
 * retries. Concurrent clients and effect remounts still create new requests.
 * A separate org-keyed window caps those requests
 * without letting snapshot failures suppress the poll signal. Poll streaks
 * remain per stream while their emission is also bounded per org.
 */
const snapshotFailures = createFailureReporter(
  STATUS_SNAPSHOT_FAILED_EVENT,
  SNAPSHOT_FAILURE_LOG_INTERVAL_MS
);
export const snapshotFailureThrottle = snapshotFailures.throttle;

// Before auth resolves there is no trusted org. One fixed process-local key
// bounds this path without accepting caller-provided tenant ids or credentials.
const authFailures = createFailureReporter(
  STATUS_SNAPSHOT_FAILED_EVENT,
  SNAPSHOT_FAILURE_LOG_INTERVAL_MS
);
export const authFailureThrottle = authFailures.throttle;

/** Report an initial snapshot failure without letting reporting change the 500. */
export function reportSnapshotFailure(params: {
  organizationId: string;
  error: unknown;
  now: number;
}): boolean {
  attributeSetupFailure(params.error, SpanErrorSource.RouteHandler);
  return snapshotFailures.report(
    { organizationId: params.organizationId },
    params.error,
    params.now
  );
}

export function reportAuthFailure(error: unknown, now: number): boolean {
  attributeSetupFailure(error, SpanErrorSource.AuthWrapper);
  return authFailures.report({ phase: "auth" }, error, now);
}

function attributeSetupFailure(error: unknown, source: SpanErrorSource): void {
  // Annotate the existing recording span; no new log/span or deferred flush.
  // recordRequestErrorCause alone only fills ALS for request_completed, which
  // this SSE route intentionally does not emit on every reconnect.
  setAppSpanAttributes({
    [TelemetryAttribute.AppErrorSource]: source,
    [TelemetryAttribute.ErrorType]: resolveSpanErrorType(error),
  });
}

/**
 * Report one failed status read, bounded per org.
 *
 * `consecutiveFailures` is the REPORTING stream's own streak — one real stream's
 * run of failures, which is what tells a blip from an outage — while
 * `suppressedSinceLastReport` counts what the org's window swallowed across
 * every stream since the last line, so the bound loses no occurrences.
 *
 * Never throws: this runs on the failure path, and a failure to REPORT a failed
 * read must not also decide whether the stream survives it.
 */
export function reportPollFailure(params: {
  organizationId: string;
  consecutiveFailures: number;
  error: unknown;
  now: number;
}): void {
  pollFailures.report(
    { organizationId: params.organizationId },
    params.error,
    params.now,
    { consecutiveFailures: params.consecutiveFailures }
  );
}

/**
 * Flush the rollup for any org whose window closed with failures still pending,
 * rather than holding them until that same org fails again.
 *
 * Wired to stream teardown — a terminal path this route already runs on every
 * stream, rather than a timer a frozen serverless instance would never fire.
 * O(1) when nothing has expired. Never throws: teardown must complete.
 */
export function drainPollFailures(now: number = Date.now()): void {
  pollFailures.drain(now);
}

/**
 * Drain on request termination, including recovery and auth denials. Expiry is
 * opportunistic: a final unexpired window on an instance that freezes is still
 * pending, not evidence of recovery or a complete occurrence census.
 */
export function drainSnapshotFailures(now: number = Date.now()): boolean {
  const snapshotEmitted = snapshotFailures.drain(now);
  const authEmitted = authFailures.drain(now);
  return snapshotEmitted || authEmitted;
}

/** The same reporting/rollup mechanics, with independent emission budgets. */
function createFailureReporter(event: string, windowMs: number) {
  // All operations are synchronous. Capture actual emission, not the number
  // of expired entries: an expired entry with no suppressed reads emits nothing.
  let emitted = false;
  const throttle = new FixedWindowEmissionThrottle<FailureScope>({
    windowMs,
    onFlush: (scope, occurrences, flushedBy: EmissionRollupCause) => {
      log.error(event, { ...scope, occurrences, aggregated: true, flushedBy });
      emitted = true;
    },
  });

  function warn(error: unknown, scope: FailureScope = {}): void {
    log.warn(
      "[compute-target-status-stream] Failed to report status failures",
      {
        event,
        ...scope,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    emitted = true;
  }

  return {
    throttle,
    report(
      scope: FailureScope,
      error: unknown,
      now: number,
      extra: { consecutiveFailures?: number } = {}
    ): boolean {
      emitted = false;
      try {
        const decision = throttle.record(
          scope.organizationId ?? "pre-auth",
          scope,
          now
        );
        if (decision.emit) {
          log.error(event, {
            ...scope,
            ...extra,
            suppressedSinceLastReport: decision.flushedSuppressedCount,
            error: error instanceof Error ? error.message : String(error),
          });
          emitted = true;
        }
      } catch (error) {
        warn(error, scope);
      }
      return emitted;
    },
    drain(now: number): boolean {
      emitted = false;
      try {
        throttle.drainExpired(now);
      } catch (error) {
        warn(error);
      }
      return emitted;
    },
  };
}
