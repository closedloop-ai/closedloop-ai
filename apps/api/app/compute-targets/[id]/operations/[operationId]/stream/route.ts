import { auth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { type RelayResultEvent, relayEventBus } from "@/lib/relay-event-bus";
import { computeTargetsService } from "../../../../service";

const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_STREAM_DURATION_MS = 30 * 60 * 1000;

function encodeEvent(event: RelayResultEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function encodeKeepalive(): Uint8Array {
  return new TextEncoder().encode(": keepalive\n\n");
}

function isTerminal(event: RelayResultEvent): boolean {
  return event.done === true || event.result !== undefined;
}

/**
 * GET /compute-targets/:id/operations/:operationId/stream
 * Subscribe to relay result events for one operation.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; operationId: string }> }
): Promise<Response> {
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();
  if (!(clerkUserId && clerkOrgId)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const organization = await organizationsService.findByClerkId(clerkOrgId);
  if (!organization) {
    return new Response("Unauthorized", { status: 401 });
  }

  const user = await usersService.findByClerkIdAndOrg(
    clerkUserId,
    organization.id
  );
  if (!user?.active) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id: targetId, operationId } = await params;

  const target = await computeTargetsService.findOwnedById(
    targetId,
    organization.id,
    user.id
  );
  if (!target) {
    return new Response("Forbidden", { status: 403 });
  }

  let unsubscribe: (() => void) | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let cleaned = false;

  const stream = new ReadableStream({
    start(controller) {
      const cleanup = () => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (maxDurationTimer) {
          clearTimeout(maxDurationTimer);
          maxDurationTimer = null;
        }
      };

      const safeClose = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      unsubscribe = relayEventBus.subscribeResults(operationId, (event) => {
        try {
          controller.enqueue(encodeEvent(event));
          if (isTerminal(event)) {
            safeClose();
          }
        } catch (error) {
          log.error("Failed writing relay result event to SSE stream", {
            targetId,
            operationId,
            error,
          });
          safeClose();
        }
      });

      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(encodeKeepalive());
        } catch {
          safeClose();
        }
      }, KEEPALIVE_INTERVAL_MS);

      maxDurationTimer = setTimeout(() => {
        log.info("Relay result SSE max duration reached", {
          targetId,
          operationId,
        });
        safeClose();
      }, MAX_STREAM_DURATION_MS);
    },
    cancel() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (maxDurationTimer) {
        clearTimeout(maxDurationTimer);
        maxDurationTimer = null;
      }
      cleaned = true;
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
