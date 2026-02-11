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
import { isReplayDetectedError, loopsService } from "../../service";
import {
  listLoopEventsQueryValidator,
  loopEventPayloadValidator,
} from "../../validators";

const NONCE_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
 * Authenticates via a short-lived JWT issued to the runner at launch time
 * (see loop-runner-jwt.ts). Each event must also include a unique nonce
 * header for replay protection.
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

    const nonce = request.headers.get("x-loop-event-nonce");
    if (!nonce) {
      return errorResponse(
        "Missing runner event nonce",
        new Error("Unauthorized"),
        401
      );
    }

    if (!NONCE_UUID_REGEX.test(nonce)) {
      return errorResponse(
        "Invalid runner event nonce",
        new Error("Bad Request"),
        400
      );
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      loopEventPayloadValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    // Normalize envelope format { type, data: {...} } to flat event { type, ... }
    const event: LoopEvent =
      "data" in body && typeof body.data === "object" && body.data !== null
        ? ({
            type: body.type,
            ...(body.data as Record<string, unknown>),
          } as LoopEvent)
        : (body as unknown as LoopEvent);

    const loop = await loopsService.findById(loopId, claims.organizationId);
    if (!loop) {
      return errorResponse("Loop not found", new Error("Forbidden"), 403);
    }

    const terminalStatuses = new Set([
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMED_OUT",
    ]);
    const terminalEvents = new Set(["completed", "error", "cancelled"]);
    if (terminalStatuses.has(loop.status) && !terminalEvents.has(event.type)) {
      return successResponse({
        received: true as const,
        ignored: true as const,
      });
    }

    try {
      await handleLoopEvent(loopId, claims.organizationId, event, {
        tokenJti: claims.tokenId,
        nonce,
      });
    } catch (eventError) {
      if (isReplayDetectedError(eventError)) {
        return errorResponse("Replay detected", new Error("Conflict"), 409);
      }
      // Idempotency guard: duplicate/replayed terminal events should not 500.
      if (
        eventError instanceof Error &&
        eventError.message.includes("Invalid status transition")
      ) {
        return successResponse({
          received: true as const,
          ignored: true as const,
        });
      }
      throw eventError;
    }

    // Publish to the in-memory event bus for any active SSE subscribers
    loopEventBus.publish(loopId, event);

    return successResponse({ received: true as const });
  } catch (error) {
    return errorResponse("Failed to record loop event", error);
  }
}
