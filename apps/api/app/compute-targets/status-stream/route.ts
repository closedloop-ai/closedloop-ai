import { authContextFailureResponse } from "@/lib/auth/auth-context-failure";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { createSseResponse, createSseStream } from "@/lib/sse-stream";
import { computeTargetsService } from "../service";
import {
  emitChanges,
  nextPollDelayMs,
  remainingStreamDurationMs,
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
export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();

  const authResult = await resolveAnyAuthContext(request, {
    requiredScopes: ["read"],
  });
  if (!authResult.ok) {
    return authContextFailureResponse(authResult.failure);
  }
  const authContext = authResult.context;

  let lastSnapshot: StatusSnapshot;
  try {
    lastSnapshot = await computeTargetsService.getStatusSnapshot(
      authContext.organizationId
    );
  } catch {
    return new Response("Failed to load initial status", { status: 500 });
  }

  const stream = createSseStream(
    ({ send }) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let disposed = false;
      // When this stream last saw a change or a failed read. Drives the cadence
      // via `nextPollDelayMs`; only a clean, unchanged poll lets it age.
      let lastActivityAt = Date.now();

      const scheduleNextPoll = () => {
        if (disposed) {
          return;
        }
        if (timer) {
          clearTimeout(timer);
        }
        timer = setTimeout(poll, nextPollDelayMs(Date.now() - lastActivityAt));
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
          if (disposed) {
            return;
          }
          if (emitChanges(lastSnapshot, current, send)) {
            lastActivityAt = Date.now();
          }
          lastSnapshot = current;
        } catch {
          // Swallow transient DB errors; keepalive will maintain connection.
          // A failed read is not a quiet stream, so hold the base cadence — a
          // lane that cannot reach the database must not be rewarded with a
          // slower retry. Making these failures observable is FEA-3301.
          lastActivityAt = Date.now();
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
      };
    },
    {
      maxDurationMs: remainingStreamDurationMs(startedAt),
      logContext: { organizationId: authContext.organizationId },
    }
  );

  return createSseResponse(stream);
}
