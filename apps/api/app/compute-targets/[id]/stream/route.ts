import { log } from "@repo/observability/log";
import { authContextFailureResponse } from "@/lib/auth/auth-context-failure";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { relayEventBus } from "@/lib/relay-event-bus";
import { scheduleLogFlush, scheduleLogFlushAfter } from "@/lib/route-utils";
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
  const authResult = await resolveAnyAuthContext(request, {
    requiredScopes: ["write"],
  });
  if (!authResult.ok) {
    return authContextFailureResponse(authResult.failure);
  }
  const authContext = authResult.context;

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
    // ISS-4659: routed through `scheduleLogFlushAfter` rather than a bare
    // `waitUntil`. This DB write runs after the stream closes — long after the
    // earlier `scheduleLogFlush()` above already flushed — and it produces pg
    // spans of its own, which would freeze with the function. The helper
    // chains this promise into both the log and span flush, on the success
    // path as well as the failure one.
    scheduleLogFlushAfter(
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
