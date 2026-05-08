import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { type RelayResultEvent, relayEventBus } from "@/lib/relay-event-bus";
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

  const stream = createSseStream(
    ({ send, close }) =>
      relayEventBus.subscribeResults(operationId, (event) => {
        send(encodeSseData(event));
        if (isTerminal(event)) {
          close();
        }
      }),
    { logContext: { targetId, operationId } }
  );

  return createSseResponse(stream);
}
