import type { DesktopCommandEvent } from "@repo/api/src/types/compute-target";
import { auth } from "@repo/auth/server";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { computeTargetsService } from "../../../../service";

const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_STREAM_DURATION_MS = 30 * 60 * 1000;

function encodeEvent(event: DesktopCommandEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function encodeKeepalive(): Uint8Array {
  return new TextEncoder().encode(": keepalive\n\n");
}

function isTerminalEvent(event: DesktopCommandEvent): boolean {
  if (event.eventType === "done") {
    return true;
  }
  return (
    (event.eventType === "error" || event.eventType === "result") &&
    typeof event.data === "object" &&
    event.data !== null &&
    "terminal" in event.data &&
    event.data.terminal === true
  );
}

/**
 * GET /compute-targets/:id/commands/:commandId/events
 *
 * Default response: ordered event log JSON array.
 * Stream mode: `?stream=true` (or `Accept: text/event-stream`) for live SSE events.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; commandId: string }> }
): Promise<Response> {
  try {
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

    const { id: targetId, commandId } = await params;
    const target = await computeTargetsService.findOwnedById(
      targetId,
      organization.id,
      user.id
    );
    if (!target) {
      return new Response("Forbidden", { status: 403 });
    }

    const command = await desktopCommandStore.getCommand(target.id, commandId);
    if (!command) {
      return new Response("Not Found", { status: 404 });
    }

    const url = new URL(request.url);
    const streamRequested =
      url.searchParams.get("stream") === "true" ||
      request.headers.get("accept")?.includes("text/event-stream") === true;

    if (!streamRequested) {
      const events = await desktopCommandStore.getCommandEvents(
        target.id,
        commandId
      );
      return successResponse(events ?? []);
    }

    let unsubscribe: (() => void) | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
    let cleaned = false;
    let closeRequestedBeforeSubscription = false;

    const stream = new ReadableStream({
      async start(controller) {
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
            // Stream already closed.
          }
        };

        const requestClose = () => {
          if (unsubscribe) {
            safeClose();
            return;
          }
          closeRequestedBeforeSubscription = true;
        };

        unsubscribe = await desktopCommandStore.subscribeCommandEvents(
          target.id,
          commandId,
          (event) => {
            try {
              controller.enqueue(encodeEvent(event));
              if (isTerminalEvent(event)) {
                requestClose();
              }
            } catch {
              requestClose();
            }
          },
          { replay: true }
        );

        if (!unsubscribe) {
          safeClose();
          return;
        }

        if (closeRequestedBeforeSubscription) {
          safeClose();
          return;
        }

        keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(encodeKeepalive());
          } catch {
            safeClose();
          }
        }, KEEPALIVE_INTERVAL_MS);

        maxDurationTimer = setTimeout(() => {
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
  } catch (error) {
    return errorResponse("Failed to fetch desktop command events", error);
  }
}
