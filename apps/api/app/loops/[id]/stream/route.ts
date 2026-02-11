import type { LoopEvent } from "@repo/api/src/types/loop";
import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { organizationsService } from "@/app/organizations/service";
import { loopEventBus } from "@/lib/loop-event-bus";
import { loopsService } from "../../service";

const KEEPALIVE_INTERVAL_MS = 15_000;

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
  // withAuth() does this automatically, but SSE routes handle auth inline.
  let organizationId: string;
  try {
    const organization =
      await organizationsService.findOrCreateByClerkId(clerkOrgId);
    organizationId = organization.id;
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

  log.info("SSE stream opened", { loopId, clerkUserId, organizationId });

  // Shared cleanup state - accessible from both start() and cancel()
  let unsubscribe: (() => void) | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
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
