import type {
  LoopEvent,
  LoopEventsFilters,
  LoopEventsPaginatedResponse,
  LoopEventType,
  StoredLoopEvent,
} from "@repo/api/src/types/loop";
import { authenticateLoopRunnerRequest } from "@/lib/auth/loop-runner-jwt";
import { withAuth } from "@/lib/auth/with-auth";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import {
  conflictResponse,
  errorResponse,
  forbiddenResponse,
  logLoopIngestFailure,
  parseBody,
  scheduleLogFlushAfter,
  successResponse,
} from "@/lib/route-utils";
import {
  type InvalidStatusTransitionError,
  isInvalidStatusTransitionError,
  isReplayDetectedError,
} from "../../loop-errors";
import { IngestRunnerEventErrorCode } from "../../loop-ingest-types";
import { loopsService, scheduleRunnerHeartbeatBump } from "../../service";
import {
  listLoopEventsQueryValidator,
  listLoopEventsSinceQueryValidator,
  loopEventPayloadValidator,
  normalizeLoopEvent,
  TERMINAL_LOOP_STATUSES,
  validateNormalizedEvent,
} from "../../validators";

const NONCE_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Extract the runner event nonce from the request header.
 * The nonce is the second half of the composite eventId (tokenJti:nonce) that
 * underpins replay detection — a missing nonce would let retries bypass the
 * unique constraint, so we reject the request rather than fail open.
 */
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

/**
 * Convert the flat {@link LoopEvent} shape into the `{ type, data }` envelope
 * expected by `ingestRunnerEvent` / `addEvent` for DB storage. Splitting the
 * `type` discriminant from the remaining fields with a typed rest keeps the
 * conversion type-checked instead of bridging through `Record<string, unknown>`.
 */
function toLoopEventEnvelope(event: LoopEvent): {
  type: string;
  data: Record<string, unknown>;
} {
  const { type, ...data } = event;
  return { type, data };
}

/**
 * Translate errors thrown by `handleLoopEvent` into appropriate HTTP responses.
 * - `InvalidStatusTransitionError` from a terminal source status is treated as
 *   an ignored duplicate (200 { received: true, ignored: true }).
 * - `InvalidStatusTransitionError` from a non-terminal source is a 409.
 * Returns null if the error is not one we map; the caller should rethrow.
 */
function mapEventHandlingError(error: unknown): Response | null {
  if (isReplayDetectedError(error)) {
    return conflictResponse("Replay detected");
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
  StoredLoopEvent[] | LoopEventsPaginatedResponse,
  "/loops/[id]/events"
>(async ({ user }, request, params) => {
  try {
    // Loop events are org-scoped (same as loops themselves).
    // No additional role check — all authenticated org members can view events,
    // consistent with GET /loops and GET /loops/:id.
    const { id } = await params;

    const url = new URL(request.url);
    const rawQuery = Object.fromEntries(url.searchParams.entries());

    // Incremental (keyset) poll: `since`/`sinceId` are the composite cursor of
    // the newest event the client holds. Return only the delta so an active
    // loop's 3s poll no longer re-ships its full, ever-growing event history on
    // every request.
    if (rawQuery.since !== undefined) {
      const parsedSince = listLoopEventsSinceQueryValidator.safeParse(rawQuery);
      if (!parsedSince.success) {
        const msg = parsedSince.error.issues.map((i) => i.message).join(", ");
        return errorResponse(msg, new Error(msg), 400);
      }
      const events = await loopsService.getEventsSince(
        id,
        user.organizationId,
        new Date(parsedSince.data.since),
        parsedSince.data.sinceId,
        parsedSince.data.limit
      );
      return successResponse(events);
    }

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

    const filters: LoopEventsFilters = {
      type: parsed.data.type as LoopEventType | undefined,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      sort: parsed.data.sort,
    };

    const result = await loopsService.getEventsPaginated(
      id,
      user.organizationId,
      filters
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
  // Hoisted so the outer catch can stitch the failure to its loop/org in
  // Datadog — see `loop.event_ingest_failed` below.
  let loopId: string | undefined;
  let organizationId: string | undefined;
  try {
    ({ id: loopId } = await params);

    const claims = await authenticateLoopRunnerRequest(
      request,
      loopId,
      "loops/[id]/events"
    );
    if (claims instanceof Response) {
      return claims;
    }
    organizationId = claims.organizationId;

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

    const ingestResult = await loopsService.ingestRunnerEvent({
      loopId,
      tokenJti: claims.tokenId,
      nonce,
      event: toLoopEventEnvelope(event),
      organizationId: claims.organizationId,
    });

    if (!ingestResult.ok) {
      switch (ingestResult.code) {
        case IngestRunnerEventErrorCode.LoopNotFound:
          return forbiddenResponse({ code: "loop_not_found" });
        case IngestRunnerEventErrorCode.Replay:
          return conflictResponse("Replay detected");
        default: {
          const _exhaustive: never = ingestResult.code;
          return errorResponse(
            "Unhandled ingest error code",
            new Error(String(_exhaustive)),
            500
          );
        }
      }
    }

    if (ingestResult.outcome === "ignored") {
      return successResponse({
        received: true as const,
        ignored: true as const,
      });
    }
    // ingestResult.outcome === "inserted" — fall through to handleLoopEvent

    // Fire-and-forget throttled heartbeat bump — see
    // `scheduleRunnerHeartbeatBump` in ../../service for throttling/CAS details.
    scheduleLogFlushAfter(
      scheduleRunnerHeartbeatBump(loopId, claims.organizationId)
    );

    // Run full orchestration. The orchestrator is the sole writer of the
    // canonical LoopEvent row — see comment in `ingestRunnerEvent`. A status
    // transition raced ahead of us (e.g., a duplicate `started` after
    // RUNNING, or a late `error` after another terminal transition) must
    // surface as a 200-ignored or 409 rather than an opaque 500.
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
    logLoopIngestFailure("loop.event_ingest_failed", {
      error,
      loopId,
      organizationId,
    });
    return errorResponse("Failed to record loop event", error);
  }
}
