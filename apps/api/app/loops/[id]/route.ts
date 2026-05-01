import type { Loop, LoopEvent, LoopWithUser } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { stopDesktopLoop } from "@/lib/loops/loop-desktop";
import { stopLoopTask } from "@/lib/loops/loop-ecs";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { loopsService } from "../service";
import { loopMetadataUpdateValidator } from "../validators";

export const GET = withAnyAuth<LoopWithUser, "/loops/[id]">(
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

      if (loop.computeTargetId) {
        // Desktop path: dispatch kill command to electron
        try {
          await stopDesktopLoop(id, loop.computeTargetId);
        } catch (killError) {
          log.warn("Failed to dispatch desktop kill command", {
            loopId: id,
            killError,
          });
        }
      } else if (loop.containerId) {
        // ECS path: stop the container task
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
  { requiredScopes: ["delete"] }
);

/**
 * PATCH /loops/[id] — Update loop metadata (prUrl, branchName, summary).
 * Used by MCP complete-loop to record final state on manual loops.
 */
export const PATCH = withAnyAuth<Loop, "/loops/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const { body, errorResponse: parseError } = await parseBody(
        request,
        loopMetadataUpdateValidator
      );
      if (parseError) {
        return parseError;
      }

      const loop = await loopsService.findById(id, user.organizationId);
      if (!loop) {
        return notFoundResponse("Loop");
      }

      if (loop.command !== LoopCommand.Manual) {
        return errorResponse(
          "Metadata updates are only allowed for MANUAL loops",
          new Error("Forbidden"),
          403
        );
      }

      const updated = await loopsService.updateManualLoopFields(
        id,
        user.organizationId,
        body
      );

      if (!updated) {
        return notFoundResponse("Loop");
      }

      return successResponse(updated);
    } catch (error) {
      return errorResponse("Failed to update loop", error);
    }
  },
  { requiredScopes: ["write"] }
);
