import type {
  LoopEvent,
  LoopEventsPaginatedResponse,
} from "@repo/api/src/types/loop";
import { verifyLoopRunnerToken } from "@/lib/auth/loop-runner-jwt";
import { withAuth } from "@/lib/auth/with-auth";
import { loopEventBus } from "@/lib/loop-event-bus";
import { handleLoopEvent } from "@/lib/loop-orchestrator";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "../../service";
import {
  listLoopEventsQueryValidator,
  loopEventPayloadValidator,
} from "../../validators";

export const GET = withAuth<
  LoopEvent[] | LoopEventsPaginatedResponse,
  "/loops/[id]/events"
>(async ({ user }, request, params) => {
  try {
    const allowedRoles = new Set([
      "ENGINEER",
      "TECH_LEAD",
      "PM",
      "DESIGNER",
      "STAKEHOLDER",
    ]);
    if (!allowedRoles.has(user.role)) {
      return forbiddenResponse();
    }

    const { id } = await params;

    const url = new URL(request.url);
    const rawQuery = Object.fromEntries(url.searchParams.entries());

    // If no pagination/filter params provided, return the flat array for
    // backward compatibility (used by SSE polling and existing consumers)
    const hasFilters =
      rawQuery.type !== undefined ||
      rawQuery.limit !== undefined ||
      rawQuery.offset !== undefined;

    if (!hasFilters) {
      const events = await loopsService.getEvents(id, user.organizationId);
      return successResponse(events);
    }

    const parsed = listLoopEventsQueryValidator.safeParse(rawQuery);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join(", ");
      return errorResponse(msg, new Error(msg), 400);
    }

    const result = await loopsService.getEventsPaginated(
      id,
      user.organizationId,
      parsed.data
    );
    return successResponse(result);
  } catch (error) {
    return errorResponse("Failed to fetch loop events", error);
  }
});

/**
 * POST /api/loops/:id/events - Receive events from container harness.
 *
 * NOTE: This route currently uses Clerk auth via withAuth(). In production,
 * container harnesses will authenticate via a container JWT instead.
 * This will need to change when container auth is implemented.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id: loopId } = await params;

    const authHeader = request.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    if (!token) {
      return errorResponse(
        "Missing runner token",
        new Error("Unauthorized"),
        401
      );
    }

    const claims = await verifyLoopRunnerToken(token);
    if (claims.loopId !== loopId) {
      return errorResponse(
        "Token does not match loop",
        new Error("Forbidden"),
        403
      );
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      loopEventPayloadValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    const event: LoopEvent =
      "data" in body
        ? ({ type: body.type, ...body.data } as LoopEvent)
        : (body as LoopEvent);

    await handleLoopEvent(loopId, claims.organizationId, event);

    // Publish to the in-memory event bus for any active SSE subscribers
    loopEventBus.publish(loopId, event);

    return successResponse({ received: true as const });
  } catch (error) {
    return errorResponse("Failed to record loop event", error);
  }
}
