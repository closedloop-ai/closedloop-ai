import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import {
  createSseResponse,
  createSseStream,
  encodeSseData,
} from "@/lib/sse-stream";
import { computeTargetsService } from "../service";

const POLL_INTERVAL_MS = 5000;

type StatusSnapshot = Map<string, boolean>;
type SendFn = (chunk: Uint8Array) => void;

function emitChanges(
  lastSnapshot: StatusSnapshot,
  current: StatusSnapshot,
  send: SendFn
): void {
  for (const [targetId, isOnline] of current) {
    if (lastSnapshot.get(targetId) !== isOnline) {
      send(encodeSseData({ targetId, isOnline }));
    }
  }

  // Detect removed targets (went offline / deleted)
  for (const [targetId] of lastSnapshot) {
    if (!current.has(targetId)) {
      send(encodeSseData({ targetId, isOnline: false }));
    }
  }
}

/**
 * GET /compute-targets/status-stream
 * Polls the database and pushes { targetId, isOnline } events to browser
 * clients whenever a compute target's online state changes for the
 * authenticated org. Uses DB polling instead of an in-process bus so it
 * works correctly on Vercel serverless (each invocation is isolated).
 */
export async function GET(request: Request): Promise<Response> {
  const authContext = await resolveAnyAuthContext(request, {
    requiredScopes: ["read"],
  });
  if (!authContext) {
    return new Response("Unauthorized", { status: 401 });
  }

  let lastSnapshot: StatusSnapshot;
  try {
    lastSnapshot = await computeTargetsService.getStatusSnapshot(
      authContext.organizationId
    );
  } catch {
    return new Response("Failed to load initial status", { status: 500 });
  }

  const stream = createSseStream(
    ({ send }) => {
      let polling = false;

      const timer = setInterval(async () => {
        if (polling) {
          return;
        }
        polling = true;
        try {
          const current = await computeTargetsService.getStatusSnapshot(
            authContext.organizationId
          );
          emitChanges(lastSnapshot, current, send);
          lastSnapshot = current;
        } catch {
          // Swallow transient DB errors; keepalive will maintain connection.
        } finally {
          polling = false;
        }
      }, POLL_INTERVAL_MS);

      return () => {
        clearInterval(timer);
      };
    },
    {
      logContext: { organizationId: authContext.organizationId },
    }
  );

  return createSseResponse(stream);
}
