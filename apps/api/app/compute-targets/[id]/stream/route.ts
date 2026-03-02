import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { apiKeysService } from "@/app/api-keys/service";
import { usersService } from "@/app/users/service";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  createSseResponse,
  createSseStream,
  encodeSseData,
} from "@/lib/sse-stream";
import { computeTargetsService } from "../../service";

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

  if (!keyContext.scopes.includes("write")) {
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
        })
    );
  };

  let unsubscribeConnection: (() => void) | null = null;

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
