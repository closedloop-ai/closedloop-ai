import type { LoopEvent } from "@repo/api/src/types/loop";
import { LoopEventType } from "@repo/api/src/types/loop";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
import { scheduleLogFlush } from "@/lib/route-utils";
import { loopsService } from "../../service";
import { TERMINAL_LOOP_STATUSES } from "../../validators";

const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_STREAM_DURATION_MS = 30 * 60 * 1000; // 30 minutes
// Keyset batch size for terminal-loop history replay. Bounds peak memory to
// O(batch) rather than O(total events) while draining across successive pulls.
const REPLAY_BATCH_SIZE = 500;

/**
 * GET /api/loops/:id/stream - Server-Sent Events endpoint for real-time loop events.
 *
 * Opens an SSE connection that streams loop events as they arrive from
 * the container harness. The client receives events in real time without polling.
 *
 * Note: This route does NOT use withAuth() because withAuth() returns
 * NextResponse<ApiResult<T>>, but SSE requires a raw Response with a
 * ReadableStream body. Authentication is handled inline instead.
 *
 * Protocol:
 *   - Events are sent as `data: <JSON>\n\n`
 *   - Keepalive pings are sent every 15s as `: keepalive\n\n` (SSE comment)
 *   - The stream closes when the client disconnects or the loop completes/fails
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  // --- Authentication (inline, since we can't use withAuth for SSE) ---
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();

  if (!(clerkUserId && clerkOrgId)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Resolve Clerk org ID to internal organization ID.
  // Uses read-only lookup (not findOrCreate) since SSE is a read path
  // and should not create org records as a side effect.
  let organizationId: string;
  try {
    const organization = await organizationsService.findByClerkId(clerkOrgId);
    if (!organization) {
      return new Response("Unauthorized", { status: 401 });
    }
    organizationId = organization.id;

    // Verify the user record exists and is active, matching withAuth behavior.
    const user = await usersService.findByClerkIdAndOrg(
      clerkUserId,
      organizationId
    );
    if (!user?.active) {
      return new Response("Unauthorized", { status: 401 });
    }
  } catch (error) {
    log.error("Failed to resolve organization for SSE stream", {
      clerkOrgId,
      error,
    });
    scheduleLogFlush();
    return new Response("Unauthorized", { status: 401 });
  }

  const { id: loopId } = await params;

  // Verify the loop exists and belongs to the user's organization.
  // loopsService.findById is org-scoped, so this also serves as authorization.
  let loop: Awaited<ReturnType<typeof loopsService.findById>>;
  try {
    loop = await loopsService.findById(loopId, organizationId);
  } catch (error) {
    log.error("Failed to verify loop for SSE stream", { loopId, error });
    scheduleLogFlush();
    return new Response("Internal Server Error", { status: 500 });
  }

  if (!loop) {
    return new Response("Loop not found", { status: 404 });
  }

  // If the loop is already in a terminal state, send stored events and close
  // immediately rather than holding the connection open for 30 minutes.
  if (TERMINAL_LOOP_STATUSES.has(loop.status)) {
    // Replay the loop's COMPLETE event history in chronological order, not a
    // capped first page: the terminal event is chronologically last, so a
    // capped fetch would drop it for loops with more events than the cap and
    // the client would never see stream completion — it would loop
    // reconnecting (re-appending duplicates) until it errors out (FEA-2903).
    //
    // To keep memory genuinely bounded (O(batch), not O(total events)), stream
    // the history in keyset batches instead of materializing the whole array.
    // Each pull() fetches the next REPLAY_BATCH_SIZE events strictly after the
    // (createdAt, id) cursor, enqueues them frame-by-frame, and advances the
    // cursor to the last row. When a batch comes back short, the history is
    // fully drained (its last row is the terminal event) and the stream closes.
    // getEventsSince orders by (createdAt asc, id asc) with a unique
    // (createdAt, id) keyset cursor, so no row is ever skipped or re-sent.
    const encoder = new TextEncoder();
    let cursorDate = new Date(0);
    let cursorId = "";
    let drained = false;
    const replayStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (drained) {
            controller.close();
            return;
          }
          const batch = await loopsService.getEventsSince(
            loopId,
            organizationId,
            cursorDate,
            cursorId,
            REPLAY_BATCH_SIZE
          );
          for (const e of batch) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(e as unknown as LoopEvent)}\n\n`
              )
            );
          }
          if (batch.length < REPLAY_BATCH_SIZE) {
            // Short (or empty) batch — history is fully drained. Close on the
            // next pull() so the final enqueued frames flush first.
            drained = true;
            if (batch.length === 0) {
              controller.close();
            }
            return;
          }
          // batch is non-empty here: a short (or empty) batch returned above,
          // so a full-size batch reaching this point always has a last row.
          const last = batch.at(-1) as (typeof batch)[number];
          cursorDate = new Date(last.storedAt);
          cursorId = last.id;
        } catch (error) {
          // A mid-replay DB error would otherwise close the stream with no
          // terminal event, so the client can't recognize completion and keeps
          // reconnecting (FEA-2903). Synthesize a terminal error LoopEvent so
          // the client's terminal-event handler fires and it stops reconnecting.
          log.error("Failed to replay loop history for SSE stream", {
            loopId,
            error,
          });
          scheduleLogFlush();
          const terminalEvent: LoopEvent = {
            type: LoopEventType.Error,
            code: "replay_failed",
            message: "Failed to replay loop event history.",
            timestamp: new Date().toISOString(),
            loopId,
          };
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(terminalEvent)}\n\n`)
            );
          } catch {
            // Controller already errored/closed — nothing more to do.
          }
          controller.close();
        }
      },
    });
    return new Response(replayStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  log.info("SSE stream opened", { loopId, clerkUserId, organizationId });
  scheduleLogFlush();

  // Shared cleanup state - accessible from both start() and cancel()
  let unsubscribe: (() => void) | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let cleaned = false;

  function cleanup(): void {
    if (cleaned) {
      return;
    }
    cleaned = true;

    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (maxDurationTimer) {
      clearTimeout(maxDurationTimer);
      maxDurationTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    log.info("SSE stream closed", { loopId });
    scheduleLogFlush();
  }

  // --- SSE Stream ---
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      /**
       * Send an SSE-formatted data message to the client.
       */
      function send(event: LoopEvent): void {
        try {
          const line = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
        } catch {
          // Controller closed (client disconnected) - trigger cleanup
          cleanup();
        }
      }

      /**
       * Send an SSE comment as keepalive. Ignored by EventSource clients,
       * but keeps the TCP connection alive through proxies/load balancers.
       */
      function sendKeepalive(): void {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // Controller closed - trigger cleanup
          cleanup();
        }
      }

      // Subscribe to real-time events for this loop
      unsubscribe = loopEventBus.subscribe(loopId, (event) => {
        send(event);

        // Auto-close the stream on terminal events
        if (
          event.type === LoopEventType.Completed ||
          event.type === LoopEventType.Error ||
          event.type === LoopEventType.Cancelled
        ) {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      });

      // Start keepalive pings
      keepaliveTimer = setInterval(sendKeepalive, KEEPALIVE_INTERVAL_MS);

      // Enforce maximum connection duration to prevent unbounded resource use.
      // Clients should reconnect after receiving the close.
      maxDurationTimer = setTimeout(() => {
        log.info("SSE stream max duration reached", { loopId });
        // cleanup() emits "SSE stream closed" and schedules the flush itself.
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }, MAX_STREAM_DURATION_MS);
    },

    cancel() {
      // Called when the client disconnects (closes the EventSource / drops the connection)
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
