import { RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS } from "@repo/api/src/types/relay-heartbeat";
import { DB_POOL_ACQUIRE_TIMEOUT_MS } from "@repo/database/pool-config";
import { log } from "@repo/observability/log";
import { authContextFailureResponse } from "@/lib/auth/auth-context-failure";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import { relayEventBus } from "@/lib/relay-event-bus";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
import {
  createSseResponse,
  createSseStream,
  encodeSseData,
  remainingStreamDurationMs,
} from "@/lib/sse-stream";
import { computeTargetsService } from "../../service";

/**
 * Platform ceiling this stream runs under. Declared so the stream's own budget
 * can be pinned below it by a test: a platform kill skips `onCleanup`, so
 * `markOffline` only runs if the stream closes itself early enough for the
 * offline write to land (ISS-10334, `STREAM_DEADLINE_MS`).
 */
export const maxDuration = 300;

/**
 * GET /compute-targets/:id/stream
 * Desktop relay stream for operation dispatch.
 */
async function handleGet(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const startedAt = Date.now();
  const authResult = await resolveAnyAuthContext(request, {
    requiredScopes: ["write"],
  });
  if (!authResult.ok) {
    return authContextFailureResponse(authResult.failure);
  }
  const authContext = authResult.context;

  const { id: targetId } = await params;

  const target = await computeTargetsService.findOwnedById(
    targetId,
    authContext.organizationId,
    authContext.userId
  );
  if (!target) {
    return new Response("Forbidden", { status: 403 });
  }

  await computeTargetsService.setOnlineState(
    targetId,
    authContext.organizationId,
    authContext.userId,
    true
  );

  // ISS-10111: every presence write for this stream is a link in one
  // chain, so they can only land in the order they were issued. `clearInterval` at
  // teardown cannot stop a refresh whose DB write is already in flight, and an
  // unordered one could settle after `markOffline` and leave a disconnected
  // target reading `isOnline: true` — which every online-state reader would
  // then trust until the stale sweep caught it 90s later. Tail-chaining
  // the offline write makes it unconditionally the last writer.
  let presenceWrites: Promise<unknown> = Promise.resolve();

  const markOffline = () => {
    // ISS-4659: routed through `scheduleLogFlushAfter` rather than a bare
    // `waitUntil`. This DB write runs after the stream closes — long after the
    // earlier `scheduleLogFlush()` above already flushed — and it produces pg
    // spans of its own, which would freeze with the function. The helper
    // chains this promise into both the log and span flush, on the success
    // path as well as the failure one. Handing it the whole chain also retains
    // an in-flight refresh past the response: the stream closing IS the only
    // point this invocation can freeze at, so covering it here covers every
    // tick without spending a `waitUntil` slot on each one.
    scheduleLogFlushAfter(
      presenceWrites
        .then(() =>
          computeTargetsService.setOnlineState(
            targetId,
            authContext.organizationId,
            authContext.userId,
            false
          )
        )
        .catch((error) => {
          log.error("Failed to mark compute target offline after SSE close", {
            targetId,
            error,
          });
        })
    );
  };

  let unsubscribeConnection: (() => void) | null = null;

  log.info("Compute target SSE stream opened", { targetId });
  scheduleLogFlush();

  const stream = createSseStream(
    ({ send, close }) => {
      const unsubscribeOps = relayEventBus.subscribeOperations(
        targetId,
        (operation) => {
          send(encodeSseData(operation));
        }
      );

      unsubscribeConnection = relayEventBus.subscribeTargetConnection(
        targetId,
        close
      );

      // ISS-10111: holding this stream IS the check-in, so it has to keep
      // saying so. `markStaleTargetsOffline` — which `GET /compute-targets`
      // runs — flips a target
      // offline once `lastSeenAt` falls past `COMPUTE_TARGET_STALE_MS`, and
      // that cutoff is derived as three intervals of this same knob. Stamping
      // once at stream open therefore marked a connected, healthy client
      // offline 90s in.
      // A failed refresh is logged, not fatal: tearing the stream down would
      // turn one bad write into a client-visible disconnect.
      const presenceRefreshTimer = setInterval(() => {
        presenceWrites = presenceWrites
          .then(() =>
            computeTargetsService.setOnlineState(
              targetId,
              authContext.organizationId,
              authContext.userId,
              true
            )
          )
          .catch((error) => {
            log.error(
              "Failed to refresh compute target presence on SSE stream",
              { targetId, error }
            );
          });
      }, RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS);

      return () => {
        clearInterval(presenceRefreshTimer);
        unsubscribeOps();
        if (unsubscribeConnection) {
          unsubscribeConnection();
          unsubscribeConnection = null;
        }
      };
    },
    {
      logContext: { targetId },
      maxDurationMs: remainingStreamDurationMs(startedAt, STREAM_DEADLINE_MS),
      onCleanup: markOffline,
    }
  );

  return createSseResponse(stream);
}

/**
 * When this stream closes, measured from request entry. Teardown runs after the
 * close, and `waitUntil` work still ends at the function's timeout, so its time
 * is kept back from `maxDuration`: a presence refresh can still be waiting on
 * the pool at the close, the offline write is chained behind it (ISS-10111),
 * and each can wait `DB_POOL_ACQUIRE_TIMEOUT_MS` for a connection. The 5s per
 * write is an allowance for the single-row update itself, which the pool
 * config does not bound. No floor: once setup has spent the budget the stream closes
 * at once, so teardown starts with whatever time is left.
 */
export const STREAM_DEADLINE_MS =
  maxDuration * 1000 - 2 * (DB_POOL_ACQUIRE_TIMEOUT_MS + 5000);

export const GET = withRequestCompleted(handleGet);
