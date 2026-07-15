import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { type RelayResultEvent, relayEventBus } from "@/lib/relay-event-bus";
import { parseSequenceCursor } from "@/lib/route-utils";
import {
  createSseResponse,
  createSseStream,
  encodeSseData,
} from "@/lib/sse-stream";
import { computeTargetsService } from "../../../../service";

function isTerminal(event: RelayResultEvent): boolean {
  return event.done === true || event.result !== undefined;
}

/**
 * Resolve the reconnect cursor. Prefers an explicit `?afterSequence` query
 * param, falling back to the `Last-Event-ID` header set automatically by a
 * native EventSource on auto-reconnect. Mirrors the `afterSequence` cursor of
 * the sibling `commands/:commandId/events` route.
 */
function resolveAfterSequence(request: Request, url: URL): number | undefined {
  return parseSequenceCursor(
    url.searchParams.get("afterSequence") ??
      request.headers.get("last-event-id")
  );
}

/**
 * GET /compute-targets/:id/operations/:operationId/stream
 * Subscribe to relay result events for one operation.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; operationId: string }> }
): Promise<Response> {
  const authContext = await resolveAnyAuthContext(request);
  if (!authContext) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id: targetId, operationId } = await params;

  const target = await computeTargetsService.findOwnedById(
    targetId,
    authContext.organizationId,
    authContext.userId
  );
  if (!target) {
    return new Response("Forbidden", { status: 403 });
  }

  const url = new URL(request.url);
  const afterSequence = resolveAfterSequence(request, url);

  const stream = createSseStream(
    ({ send, close }) =>
      relayEventBus.subscribeResults(
        operationId,
        (event) => {
          send(
            encodeSseData(
              event,
              typeof event.sequence === "number"
                ? { id: event.sequence }
                : undefined
            )
          );
          if (isTerminal(event)) {
            close();
          }
        },
        { afterSequence }
      ),
    { logContext: { targetId, operationId } }
  );

  return createSseResponse(stream);
}
