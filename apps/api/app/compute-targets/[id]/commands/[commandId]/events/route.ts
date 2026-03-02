import type { DesktopCommandEvent } from "@repo/api/src/types/compute-target";
import { auth } from "@repo/auth/server";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { errorResponse, successResponse } from "@/lib/route-utils";
import {
  createSseResponse,
  createSseStream,
  encodeSseData,
} from "@/lib/sse-stream";
import { computeTargetsService } from "../../../../service";

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

    const stream = createSseStream(
      async ({ send, close }) => {
        const unsubscribe = await desktopCommandStore.subscribeCommandEvents(
          target.id,
          commandId,
          (event) => {
            send(encodeSseData(event));
            if (isTerminalEvent(event)) {
              close();
            }
          },
          { replay: true }
        );

        return unsubscribe;
      },
      { logContext: { targetId, commandId } }
    );

    return createSseResponse(stream);
  } catch (error) {
    return errorResponse("Failed to fetch desktop command events", error);
  }
}
