import type { DesktopCommandEvent } from "@repo/api/src/types/compute-target";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
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
    const authContext = await resolveAnyAuthContext(request);
    if (!authContext) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { id: targetId, commandId } = await params;
    const target = await computeTargetsService.findAccessibleById(
      targetId,
      authContext.organizationId,
      authContext.userId
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

    const afterSequenceParam = url.searchParams.get("afterSequence");
    const afterSequenceRaw =
      afterSequenceParam === null ? Number.NaN : Number(afterSequenceParam);
    const afterSequence =
      Number.isInteger(afterSequenceRaw) && afterSequenceRaw >= 0
        ? afterSequenceRaw
        : undefined;

    if (!streamRequested) {
      const events = await desktopCommandStore.getCommandEvents(
        target.id,
        commandId,
        { afterSequence }
      );
      return successResponse(events ?? []);
    }

    const stream = createSseStream(
      async ({ send, close }) => {
        let lastSequence = afterSequence ?? 0;

        const unsubscribe = await desktopCommandStore.subscribeCommandEvents(
          target.id,
          commandId,
          (event) => {
            if (typeof event.sequence === "number") {
              lastSequence = Math.max(lastSequence, event.sequence);
            }
            send(encodeSseData(event));
            if (isTerminalEvent(event)) {
              close();
            }
          },
          { replay: true, afterSequence }
        );

        // Poll DB for events written by external processes (e.g., relay on ECS).
        // The in-memory eventSubscribers only fire within this process, so
        // cross-process events require periodic DB checks.
        const pollInterval = setInterval(async () => {
          try {
            const events = await desktopCommandStore.getCommandEvents(
              target.id,
              commandId,
              { afterSequence: lastSequence }
            );
            if (!events) {
              return;
            }
            for (const event of events) {
              if (
                typeof event.sequence === "number" &&
                event.sequence > lastSequence
              ) {
                lastSequence = event.sequence;
                send(encodeSseData(event));
                if (isTerminalEvent(event)) {
                  close();
                }
              }
            }
          } catch {
            // Polling failure is non-fatal — next interval retries
          }
        }, 2000);

        return () => {
          clearInterval(pollInterval);
          unsubscribe?.();
        };
      },
      { logContext: { targetId, commandId } }
    );

    return createSseResponse(stream);
  } catch (error) {
    return errorResponse("Failed to fetch desktop command events", error);
  }
}
