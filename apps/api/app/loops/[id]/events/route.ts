import type { LoopEvent } from "@repo/api/src/types/loop";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";
import { loopEventValidator } from "../../validators";

export const GET = withAuth<LoopEvent[], "/loops/[id]/events">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const events = await loopsService.getEvents(id, user.organizationId);

      return successResponse(events);
    } catch (error) {
      return errorResponse("Failed to fetch loop events", error);
    }
  }
);

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

      return successResponse({ received: true as const });
    } catch (error) {
      return errorResponse("Failed to record loop event", error);
    }
  }
);
