import type {
  LoopEvent,
  LoopEventsPaginatedResponse,
} from "@repo/api/src/types/loop";
import { authenticateLoopRunner } from "@/lib/auth/loop-runner-jwt";
import { withAuth } from "@/lib/auth/with-auth";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import {
  type InvalidStatusTransitionError,
  isInvalidStatusTransitionError,
  isReplayDetectedError,
} from "../../loop-errors";
import { loopsService } from "../../service";
import {
  listLoopEventsQueryValidator,
  loopEventPayloadValidator,
  normalizeLoopEvent,
  shouldIgnoreEventForTerminalLoop,
  TERMINAL_LOOP_STATUSES,
  validateNormalizedEvent,
} from "../../validators";

const NONCE_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function extractEventNonce(request: Request): string | Response {
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
  return nonce;
}

function mapEventHandlingError(error: unknown): Response | null {
  if (isReplayDetectedError(error)) {
    return errorResponse("Replay detected", new Error("Conflict"), 409);
  }

  if (isInvalidStatusTransitionError(error)) {
    const transitionError = error as InvalidStatusTransitionError;
    if (TERMINAL_LOOP_STATUSES.has(transitionError.from)) {
      return successResponse({
        received: true as const,
        ignored: true as const,
      });
    }
    return errorResponse(
      `Invalid status transition from ${transitionError.from}`,
      error,
      409
    );
  }

  return null;
}

export const GET = withAuth<
  LoopEvent[] | LoopEventsPaginatedResponse,
  "/loops/[id]/events"
>(async ({ user }, request, params) => {
  try {
    // Loop events are org-scoped (same as loops themselves).
    // No additional role check — all authenticated org members can view events,
    // consistent with GET /loops and GET /loops/:id.
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

    const auth = await authenticateLoopRunner(request, loopId);
    if (!auth.ok) {
      return auth.response;
    }
    const claims = auth.claims;

    const nonce = extractEventNonce(request);
    if (nonce instanceof Response) {
      return nonce;
    }

    const { body, errorResponse: parseError } = await parseBody(
      request,
      loopEventPayloadValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    const event = normalizeLoopEvent(body);

    // Validate terminal event required fields post-normalization.
    // This catches malformed events from both envelope and flattened formats.
    const normalizedError = validateNormalizedEvent(event);
    if (normalizedError) {
      return errorResponse(normalizedError, new Error("Bad Request"), 400);
    }

    const loop = await loopsService.findById(loopId, claims.organizationId);
    if (!loop) {
      return errorResponse("Loop not found", new Error("Forbidden"), 403);
    }

    if (shouldIgnoreEventForTerminalLoop(loop.status, event.type)) {
      return successResponse({
        received: true as const,
        ignored: true as const,
      });
    }

    let canonicalEvents: LoopEvent[];
    try {
      canonicalEvents = await handleLoopEvent(
        loopId,
        claims.organizationId,
        event,
        {
          tokenJti: claims.tokenId,
          nonce,
        }
      );
    } catch (eventError) {
      const mapped = mapEventHandlingError(eventError);
      if (mapped) {
        return mapped;
      }
      throw eventError;
    }

    // Publish canonical events to SSE subscribers (may differ from raw input,
    // e.g. error+CANCELLED is normalized to a "cancelled" event)
    for (const canonical of canonicalEvents) {
      loopEventBus.publish(loopId, canonical);
    }

    return successResponse({ received: true as const });
  } catch (error) {
    return errorResponse("Failed to record loop event", error);
  }
}
