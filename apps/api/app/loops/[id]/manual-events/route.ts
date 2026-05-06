import type {
  LoopEvent,
  LoopEventReceivedResponse,
} from "@repo/api/src/types/loop";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { isInvalidStatusTransitionError } from "../../loop-errors";
import { loopsService } from "../../service";
import {
  manualEventPayloadValidator,
  normalizeLoopEvent,
  TERMINAL_LOOP_EVENTS,
  TERMINAL_LOOP_STATUSES,
  validateNormalizedEvent,
} from "../../validators";

/**
 * POST /loops/[id]/manual-events — Receive events from MCP-driven manual loops.
 *
 * Uses withAnyAuth (OAuth/API key) instead of runner JWT. No nonce replay
 * protection since manual events come from trusted MCP sessions.
 */
export const POST = withAnyAuth<
  LoopEventReceivedResponse,
  "/loops/[id]/manual-events"
>(
  async ({ user }, request, params) => {
    try {
      const { id: loopId } = await params;

      const { body, errorResponse: parseError } = await parseBody(
        request,
        manualEventPayloadValidator
      );
      if (parseError || !body) {
        return parseError;
      }

      const event = normalizeLoopEvent(body);

      const normalizedError = validateNormalizedEvent(event);
      if (normalizedError) {
        return badRequestResponse(normalizedError);
      }

      const result = await loopsService.findManualLoopById(
        loopId,
        user.organizationId
      );
      if (result.error) {
        if (result.error === "not_found") {
          return notFoundResponse("Loop");
        }
        return errorResponse(
          "Manual events are only accepted for MANUAL loops",
          new Error("Forbidden"),
          403
        );
      }
      const { loop } = result;

      if (
        TERMINAL_LOOP_STATUSES.has(loop.status) &&
        !TERMINAL_LOOP_EVENTS.has(event.type)
      ) {
        return successResponse({
          received: true as const,
          ignored: true as const,
        });
      }

      let canonicalEvents: LoopEvent[];
      try {
        canonicalEvents = await handleLoopEvent(
          loopId,
          user.organizationId,
          event
        );
      } catch (eventError) {
        if (isInvalidStatusTransitionError(eventError)) {
          return successResponse({
            received: true as const,
            ignored: true as const,
          });
        }
        throw eventError;
      }

      for (const canonical of canonicalEvents) {
        loopEventBus.publish(loopId, canonical);
      }

      return successResponse({ received: true as const });
    } catch (error) {
      return errorResponse("Failed to record manual loop event", error);
    }
  },
  { requiredScopes: ["write"] }
);
