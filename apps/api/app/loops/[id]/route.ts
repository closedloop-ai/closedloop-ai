import type { Loop, LoopEvent } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { stopLoopTask } from "@/lib/loops/loop-ecs";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "../service";

export const GET = withAnyAuth<Loop, "/loops/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const loop = await loopsService.findById(id, user.organizationId);

      if (!loop) {
        return notFoundResponse("Loop");
      }

      return successResponse(loop);
    } catch (error) {
      return errorResponse("Failed to fetch loop", error);
    }
  }
);

export const DELETE = withAnyAuth<Loop, "/loops/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      const loop = await loopsService.findById(id, user.organizationId);
      if (!loop) {
        return notFoundResponse("Loop");
      }

      if (loop.containerId) {
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

      return successResponse(cancelled);
    } catch (error) {
      return errorResponse("Failed to cancel loop", error);
    }
  },
  { requiredScopes: ["delete"] }
);
