import type { RelayOperationDispatchRequest } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { apiKeysService } from "@/app/api-keys/service";
import { usersService } from "@/app/users/service";
import { relayEventBus } from "@/lib/relay-event-bus";
import { computeTargetsService } from "../../service";

const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_STREAM_DURATION_MS = 30 * 60 * 1000;

type ApiKeyAuthContext = {
  organizationId: string;
  userId: string;
};

async function resolveApiKeyAuthContext(
  request: Request
): Promise<ApiKeyAuthContext | null> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token?.startsWith("sk_live_")) {
    return null;
  }

  const keyContext = await apiKeysService.verifyKey(token);
  if (!keyContext) {
    return null;
  }

  const user = await usersService.findById(
    keyContext.userId,
    keyContext.organizationId
  );
  if (!user?.active) {
    return null;
  }

  return {
    organizationId: keyContext.organizationId,
    userId: keyContext.userId,
  };
}

function encodeOperation(operation: RelayOperationDispatchRequest): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`data: ${JSON.stringify(operation)}\n\n`);
}

function encodeKeepalive(): Uint8Array {
  return new TextEncoder().encode(": keepalive\n\n");
}

/**
 * GET /compute-targets/:id/stream
 * Desktop relay stream for operation dispatch.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authContext = await resolveApiKeyAuthContext(request);
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

  let unsubscribeOperations: (() => void) | null = null;
  let unsubscribeConnection: (() => void) | null = null;
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

        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
        if (maxDurationTimer) {
          clearTimeout(maxDurationTimer);
          maxDurationTimer = null;
        }
        if (unsubscribeOperations) {
          unsubscribeOperations();
          unsubscribeOperations = null;
        }
        if (unsubscribeConnection) {
          unsubscribeConnection();
          unsubscribeConnection = null;
        }
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
          });
      };

      const safeClose = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Stream already closed.
        }
      };

      unsubscribeOperations = relayEventBus.subscribeOperations(
        targetId,
        (operation) => {
          try {
            controller.enqueue(encodeOperation(operation));
          } catch (error) {
            log.error("Failed writing relay operation to SSE stream", {
              targetId,
              operationId: operation.operationId,
              error,
            });
            safeClose();
          }
        }
      );

      unsubscribeConnection = relayEventBus.subscribeTargetConnection(
        targetId,
        safeClose
      );

      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(encodeKeepalive());
        } catch {
          safeClose();
        }
      }, KEEPALIVE_INTERVAL_MS);

      maxDurationTimer = setTimeout(() => {
        log.info("Relay operation SSE max duration reached", { targetId });
        safeClose();
      }, MAX_STREAM_DURATION_MS);
    },
    cancel() {
      if (unsubscribeConnection) {
        unsubscribeConnection();
        unsubscribeConnection = null;
      }
      if (unsubscribeOperations) {
        unsubscribeOperations();
        unsubscribeOperations = null;
      }
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (maxDurationTimer) {
        clearTimeout(maxDurationTimer);
        maxDurationTimer = null;
      }
      if (!cleaned) {
        cleaned = true;
        computeTargetsService
          .setOnlineState(
            targetId,
            authContext.organizationId,
            authContext.userId,
            false
          )
          .catch((error) => {
            log.error(
              "Failed to mark compute target offline after SSE cancel",
              {
                targetId,
                error,
              }
            );
          });
      }
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
