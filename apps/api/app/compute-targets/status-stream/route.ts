import { failure } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import {
  type AnyAuthContextResult,
  authContextFailureResponse,
} from "@/lib/auth/auth-context-failure";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { scheduleLogFlush } from "@/lib/route-utils";
import {
  createSseResponse,
  createSseStream,
  remainingStreamDurationMs,
} from "@/lib/sse-stream";
import { computeTargetsService } from "../service";
import {
  drainPollFailures,
  drainSnapshotFailures,
  emitChanges,
  MAX_STREAM_DURATION_MS,
  MIN_STREAM_DURATION_MS,
  nextPollDelayMs,
  reportAuthFailure,
  reportPollFailure,
  reportSnapshotFailure,
  STATUS_SNAPSHOT_FAILED_EVENT,
  type StatusSnapshot,
} from "./poll-helpers";

/**
 * Platform ceiling this stream runs under. Declared rather than inherited so
 * `MAX_STREAM_DURATION_MS` can be pinned below it by a test instead of by a
 * comment — the stream must always close itself before the function is killed.
 */
export const maxDuration = 300;

/**
 * GET /compute-targets/status-stream
 * Polls the database and pushes { targetId, isOnline } events to browser
 * clients whenever a compute target's online state changes for the
 * authenticated org. Uses DB polling instead of an in-process bus so it
 * works correctly on Vercel serverless (each invocation is isolated).
 *
 * The poll cadence is adaptive (FEA-3302): `POLL_INTERVAL_MS` while targets are
 * changing, widening to `IDLE_POLL_INTERVAL_MS` once the stream has been quiet,
 * and snapping back the moment a change or a failed read is seen.
 *
 * The stream's lifetime is budgeted against an absolute deadline taken at
 * request entry, because the platform's `maxDuration` clock starts there while
 * the stream's own timer cannot start until auth and the initial snapshot have
 * resolved. See `remainingStreamDurationMs`.
 */
async function handleGet(request: Request): Promise<Response> {
  const startedAt = Date.now();
  let emittedFailure = false;
  try {
    let authResult: AnyAuthContextResult;
    try {
      authResult = await resolveAnyAuthContext(request, {
        requiredScopes: ["read"],
      });
    } catch (error) {
      emittedFailure = reportAuthFailure(error, Date.now());
      return NextResponse.json(failure("Authentication failed"), {
        status: 500,
      });
    }
    if (!authResult.ok) {
      return authContextFailureResponse(authResult.failure);
    }
    const authContext = authResult.context;

    let lastSnapshot: StatusSnapshot;
    try {
      lastSnapshot = await computeTargetsService.getStatusSnapshot(
        authContext.organizationId
      );
    } catch (error) {
      emittedFailure = reportSnapshotFailure({
        organizationId: authContext.organizationId,
        error,
        now: Date.now(),
      });
      return NextResponse.json(
        failure("Failed to load initial status", {
          code: STATUS_SNAPSHOT_FAILED_EVENT,
        }),
        { status: 500 }
      );
    }

    const stream = createSseStream(
      ({ send }) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;
        // When this stream last saw a change or a failed read. Drives the cadence
        // via `nextPollDelayMs`; only a clean, unchanged poll lets it age.
        let lastActivityAt = Date.now();
        // Reads that have failed back to back. One is a blip, fifty is an outage,
        // and the whole point of reporting is telling those apart. Per stream
        // because it describes one stream's run; the emission BOUND is not — it
        // is org-keyed in `reportPollFailure`, so opening more streams cannot buy
        // more log lines.
        let consecutiveFailures = 0;

        const scheduleNextPoll = () => {
          if (disposed) {
            return;
          }
          if (timer) {
            clearTimeout(timer);
          }
          timer = setTimeout(
            poll,
            nextPollDelayMs(Date.now() - lastActivityAt)
          );
        };

        // Self-rescheduling rather than a fixed interval: the delay is recomputed
        // per tick, and scheduling the successor only once the previous read has
        // settled keeps exactly one query per stream in flight against the pool.
        async function poll(): Promise<void> {
          timer = null;
          if (disposed) {
            return;
          }
          try {
            const current = await computeTargetsService.getStatusSnapshot(
              authContext.organizationId
            );
            consecutiveFailures = 0;
            if (disposed) {
              return;
            }
            if (emitChanges(lastSnapshot, current, send)) {
              lastActivityAt = Date.now();
            }
            lastSnapshot = current;
          } catch (error) {
            // Mirrors the success path: a read that lost its race with teardown is
            // the stream ending, not a lane to alert on.
            if (disposed) {
              return;
            }
            // The stream survives a failed read — tearing it down would turn a
            // blip into a client-visible outage — but it is reported rather than
            // discarded. A failed read is also not a quiet stream, so it holds the
            // base cadence: a lane that cannot reach the database must not be
            // rewarded with a slower retry.
            lastActivityAt = Date.now();
            consecutiveFailures += 1;
            reportPollFailure({
              organizationId: authContext.organizationId,
              consecutiveFailures,
              error,
              now: lastActivityAt,
            });
          } finally {
            scheduleNextPoll();
          }
        }

        scheduleNextPoll();

        return () => {
          disposed = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          // A terminal path this route already runs, so an org whose window
          // closed with failures still pending reaches the monitor here instead
          // of waiting for that org to fail again.
          drainPollFailures();
        };
      },
      {
        maxDurationMs: remainingStreamDurationMs(
          startedAt,
          MAX_STREAM_DURATION_MS,
          MIN_STREAM_DURATION_MS
        ),
        logContext: { organizationId: authContext.organizationId },
      }
    );

    return createSseResponse(stream);
  } finally {
    const emittedRollup = drainSnapshotFailures();
    if (emittedFailure || emittedRollup) {
      scheduleLogFlush();
    }
  }
}

export const GET = withRequestCompleted(handleGet);
