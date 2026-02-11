import type {
  LoopEvent,
  LoopEventsPaginatedResponse,
} from "@repo/api/src/types/loop";
import { withAuth } from "@/lib/auth/with-auth";
import { loopEventBus } from "@/lib/loop-event-bus";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";
import {
  listLoopEventsQueryValidator,
  loopEventValidator,
} from "../../validators";

export const GET = withAuth<
  LoopEvent[] | LoopEventsPaginatedResponse,
  "/loops/[id]/events"
>(async ({ user }, request, params) => {
  try {
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
export const POST = withAuth<{ received: true }, "/loops/[id]/events">(
  async ({ user: _ }, request, params) => {
    try {
      const { id } = await params;

      const { body, errorResponse: parseError } = await parseBody(
        request,
        loopEventValidator
      );
      if (parseError) {
        return parseError;
      }

      await loopsService.addEvent(id, body);

      // Publish to the in-memory event bus for any active SSE subscribers
      loopEventBus.publish(id, {
        type: body.type,
        ...body.data,
      } as LoopEvent);

      return successResponse({ received: true as const });
    } catch (error) {
      return errorResponse("Failed to record loop event", error);
    }
  }
);
