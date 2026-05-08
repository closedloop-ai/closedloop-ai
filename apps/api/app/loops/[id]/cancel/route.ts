import type { Loop, LoopEvent } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { stopDesktopLoop } from "@/lib/loops/loop-desktop";
import { stopLoopTask } from "@/lib/loops/loop-ecs";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
import {
  errorResponse,
  notFoundResponse,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "../../service";

/**
 * POST /loops/[id]/cancel — Cancel a running loop (write scope).
 *
 * Provides a write-scoped cancel action for MCP sessions that don't hold
 * delete scope. The DELETE /loops/[id] route remains available with delete
 * scope for backwards compatibility.
 */
export const POST = withAnyAuth<Loop, "/loops/[id]/cancel">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const loop = await loopsService.findById(id, user.organizationId);
      if (!loop) {
        return notFoundResponse("Loop");
      }

      if (loop.computeTargetId) {
        try {
          await stopDesktopLoop(id, loop.computeTargetId);
        } catch (killError) {
          log.warn("Failed to dispatch desktop kill command", {
            loopId: id,
            killError,
          });
        }
      } else if (loop.containerId) {
        try {
          await stopLoopTask(loop.containerId, "Loop cancelled by user");
        } catch (stopError) {
          log.warn("Failed to stop loop task", { loopId: id, stopError });
        }
      }

      const cancelled = await loopsService.cancel(id, user.organizationId);

      const cancelEvent: LoopEvent = {
        type: "cancelled",
        reason: "Cancelled by user",
        timestamp: new Date().toISOString(),
      };
      await loopsService.addEvent(id, user.organizationId, {
        type: cancelEvent.type,
        data: cancelEvent,
      });
      loopEventBus.publish(id, cancelEvent);

      scheduleLogFlush();
      return successResponse(cancelled);
    } catch (error) {
      return errorResponse("Failed to cancel loop", error);
    }
  },
  { requiredScopes: ["write"] }
);
