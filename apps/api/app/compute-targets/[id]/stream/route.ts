import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { relayEventBus } from "@/lib/relay-event-bus";
import { scheduleLogFlush } from "@/lib/route-utils";
import {
  createSseResponse,
  createSseStream,
  encodeSseData,
} from "@/lib/sse-stream";
import { computeTargetsService } from "../../service";

/**
 * GET /compute-targets/:id/stream
 * Desktop relay stream for operation dispatch.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authContext = await resolveAnyAuthContext(request, {
    requiredScopes: ["write"],
  });
  if (!authContext) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id: targetId } = await params;

  const target = await computeTargetsService.findOwnedById(
    targetId,
    authContext.organizationId,
    authContext.userId
  );
  if (!target) {
    return new Response("Forbidden", { status: 403 });
  }

  await computeTargetsService.setOnlineState(
    targetId,
    authContext.organizationId,
    authContext.userId,
    true
  );

  const markOffline = () => {
    waitUntil(
      computeTargetsService
        .setOnlineState(
          targetId,
          authContext.organizationId,
          authContext.userId,
          false
        )
        .catch((error) => {
          log.error("Failed to mark compute target offline after SSE close", {
            targetId,
            error,
          });
          return log.flush().catch(() => {});
        })
    );
  };

  let unsubscribeConnection: (() => void) | null = null;

  log.info("Compute target SSE stream opened", { targetId });
  scheduleLogFlush();

  const stream = createSseStream(
    ({ send, close }) => {
      const unsubscribeOps = relayEventBus.subscribeOperations(
        targetId,
        (operation) => {
          send(encodeSseData(operation));
        }
      );

      unsubscribeConnection = relayEventBus.subscribeTargetConnection(
        targetId,
        close
      );

      return () => {
        unsubscribeOps();
        if (unsubscribeConnection) {
          unsubscribeConnection();
          unsubscribeConnection = null;
        }
      };
    },
    {
      logContext: { targetId },
      onCleanup: markOffline,
    }
  );

  return createSseResponse(stream);
}
