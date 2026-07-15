import type { DesktopCommandEvent } from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { authorizeBranchViewLocalEventRead } from "@/lib/branch-view-local-authorization";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  errorResponse,
  parseSequenceCursor,
  successResponse,
} from "@/lib/route-utils";
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

type LocalEventReadAuthorization = {
  commandId: string;
  computeTargetId: string;
  userId: string;
  organizationId: string;
};

async function authorizeLocalEventRead(
  input: LocalEventReadAuthorization
): Promise<Response | null> {
  const access = await authorizeBranchViewLocalEventRead(input);
  if (access.ok) {
    return null;
  }
  return NextResponse.json(
    { success: false, error: access.error, code: access.error },
    { status: access.status }
  );
}

async function readLocalEventDeniedError(response: Response): Promise<string> {
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return response.text();
}

async function sendLocalEventReadDenied(input: {
  send: (event: Uint8Array) => void;
  close: () => void;
  commandId: string;
  response: Response;
}): Promise<void> {
  input.send(
    encodeSseData({
      commandId: input.commandId,
      eventType: "error",
      data: {
        error: await readLocalEventDeniedError(input.response),
        terminal: true,
      },
    })
  );
  input.close();
}

async function pollPersistedLocalEvents(input: {
  commandId: string;
  targetId: string;
  localAuthInput: LocalEventReadAuthorization;
  lastSequence: { current: number };
  send: (event: Uint8Array) => void;
  close: () => void;
}): Promise<void> {
  const pollAuthError = await authorizeLocalEventRead(input.localAuthInput);
  if (pollAuthError) {
    await sendLocalEventReadDenied({
      send: input.send,
      close: input.close,
      commandId: input.commandId,
      response: pollAuthError,
    });
    return;
  }

  const events = await desktopCommandStore.getCommandEvents(
    input.targetId,
    input.commandId,
    { afterSequence: input.lastSequence.current }
  );
  if (!events) {
    return;
  }

  for (const event of events) {
    if (
      typeof event.sequence === "number" &&
      event.sequence > input.lastSequence.current
    ) {
      input.lastSequence.current = event.sequence;
      input.send(encodeSseData(event));
      if (isTerminalEvent(event)) {
        input.close();
      }
    }
  }
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

    const localAuthInput = {
      commandId,
      computeTargetId: target.id,
      userId: authContext.userId,
      organizationId: authContext.organizationId,
    } satisfies LocalEventReadAuthorization;
    const initialLocalAuthError = await authorizeLocalEventRead(localAuthInput);
    if (initialLocalAuthError) {
      return initialLocalAuthError;
    }

    const url = new URL(request.url);
    const streamRequested =
      url.searchParams.get("stream") === "true" ||
      request.headers.get("accept")?.includes("text/event-stream") === true;

    const afterSequence = parseSequenceCursor(
      url.searchParams.get("afterSequence")
    );

    if (!streamRequested) {
      const replayAuthError = await authorizeLocalEventRead(localAuthInput);
      if (replayAuthError) {
        return replayAuthError;
      }
      const events = await desktopCommandStore.getCommandEvents(
        target.id,
        commandId,
        { afterSequence }
      );
      return successResponse(events ?? []);
    }

    const stream = createSseStream(
      async ({ send, close }) => {
        const lastSequence = { current: afterSequence ?? 0 };

        const replayAuthError = await authorizeLocalEventRead(localAuthInput);
        if (replayAuthError) {
          await sendLocalEventReadDenied({
            send,
            close,
            commandId,
            response: replayAuthError,
          });
          return null;
        }

        const unsubscribe = await desktopCommandStore.subscribeCommandEvents(
          target.id,
          commandId,
          (event) => {
            if (typeof event.sequence === "number") {
              lastSequence.current = Math.max(
                lastSequence.current,
                event.sequence
              );
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
            await pollPersistedLocalEvents({
              commandId,
              targetId: target.id,
              localAuthInput,
              lastSequence,
              send,
              close,
            });
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
