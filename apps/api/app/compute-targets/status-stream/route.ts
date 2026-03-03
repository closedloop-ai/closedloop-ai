import { withDb } from "@repo/database";
import { resolveAnyAuthContext } from "@/lib/auth/resolve-any-auth-context";
import {
  createSseResponse,
  createSseStream,
  encodeSseData,
} from "@/lib/sse-stream";

const POLL_INTERVAL_MS = 5000;

type StatusSnapshot = Map<string, boolean>;

async function fetchStatusSnapshot(
  organizationId: string
): Promise<StatusSnapshot> {
  const targets = await withDb((db) =>
    db.computeTarget.findMany({
      where: { organizationId },
      select: { id: true, isOnline: true },
    })
  );
  return new Map(targets.map((t) => [t.id, t.isOnline]));
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

  const stream = createSseStream(
    async ({ send, close }) => {
      let lastSnapshot: StatusSnapshot;
      try {
        lastSnapshot = await fetchStatusSnapshot(authContext.organizationId);
      } catch {
        close();
        return null;
      }

      const timer = setInterval(async () => {
        try {
          const current = await fetchStatusSnapshot(authContext.organizationId);

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

          lastSnapshot = current;
        } catch {
          // Swallow transient DB errors; keepalive will maintain connection.
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
