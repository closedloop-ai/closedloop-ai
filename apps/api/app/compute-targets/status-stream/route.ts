import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import { subscribeStatusChanges } from "@/lib/compute-target-status-bus";
import {
  createSseResponse,
  createSseStream,
  encodeSseData,
} from "@/lib/sse-stream";

/**
 * GET /compute-targets/status-stream
 * Pushes { targetId, isOnline } events to browser clients whenever a
 * compute target's online state changes for the authenticated org.
 */
export async function GET(request: Request): Promise<Response> {
  const authContext = await resolveAnyAuthContext(request, {
    requiredScopes: ["read"],
  });
  if (!authContext) {
    return new Response("Unauthorized", { status: 401 });
  }

  const stream = createSseStream(
    ({ send }) => {
      const unsubscribe = subscribeStatusChanges(
        authContext.organizationId,
        (event) => {
          send(encodeSseData(event));
        }
      );

      return unsubscribe;
    },
    {
      logContext: { organizationId: authContext.organizationId },
    }
  );

  return createSseResponse(stream);
}
