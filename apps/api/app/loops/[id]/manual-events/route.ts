import type { LoopEvent } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
import { handleLoopEvent } from "@/lib/loops/loop-orchestrator";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { isInvalidStatusTransitionError, loopsService } from "../../service";
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
  { received: boolean },
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

      // Validate terminal event required fields post-normalization.
      const normalizedError = validateNormalizedEvent(
        event as unknown as Record<string, unknown>
      );
      if (normalizedError) {
        return errorResponse(normalizedError, new Error("Bad Request"), 400);
      }

      const loop = await loopsService.findById(loopId, user.organizationId);
      if (!loop) {
        return errorResponse("Loop not found", new Error("Not Found"), 404);
      }

      if (loop.command !== LoopCommand.Manual) {
        return errorResponse(
          "Manual events are only accepted for MANUAL loops",
          new Error("Forbidden"),
          403
        );
      }

      // Ignore non-terminal events after the loop is terminal.
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
        // No replayContext for manual events (no runner JWT, no nonce)
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

      // Publish canonical events to SSE subscribers
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
