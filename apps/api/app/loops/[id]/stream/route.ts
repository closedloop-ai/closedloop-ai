import type { LoopEvent } from "@repo/api/src/types/loop";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { loopEventBus } from "@/lib/loop-event-bus";
import { loopsService } from "../../service";

const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_STREAM_DURATION_MS = 30 * 60 * 1000; // 30 minutes

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
    return new Response("Internal Server Error", { status: 500 });
  }

  if (!loop) {
    return new Response("Loop not found", { status: 404 });
  }

  // If the loop is already in a terminal state, send stored events and close
  // immediately rather than holding the connection open for 30 minutes.
  const TERMINAL_STATUSES = new Set([
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
  ]);
  if (TERMINAL_STATUSES.has(loop.status)) {
    try {
      const events = await loopsService.getEvents(loopId, organizationId);
      const encoder = new TextEncoder();
      const lines = events
        .map((e: LoopEvent) => `data: ${JSON.stringify(e)}\n\n`)
        .join("");
      return new Response(encoder.encode(lines), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        },
      });
    } catch {
      return new Response("data: {}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
  }

  log.info("SSE stream opened", { loopId, clerkUserId, organizationId });

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
          event.type === "completed" ||
          event.type === "error" ||
          event.type === "cancelled"
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
