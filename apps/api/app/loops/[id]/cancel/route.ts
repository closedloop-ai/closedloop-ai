import type { JsonValue } from "@repo/api/src/types/common";
import type { Loop, LoopEvent } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { enforceRegisteredBrowserPublicKey } from "@/lib/browser-command-public-key-enforcement";
import { stopLoopTask } from "@/lib/loops/loop-ecs";
import { loopEventBus } from "@/lib/loops/loop-event-bus";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { stopDesktopLoopBestEffort } from "../../desktop-cancel";
import { loopsService } from "../../service";
import {
  readCancelUserIntentLoopId,
  readCancelUserIntentSignature,
} from "./cancel-signing-helpers";

/**
 * POST /loops/[id]/cancel — Cancel a running loop (write scope).
 *
 * Provides a write-scoped cancel action for MCP sessions that don't hold
 * delete scope. The DELETE /loops/[id] route remains available with delete
 * scope for backwards compatibility.
 */
export const POST = withAnyAuth<Loop, "/loops/[id]/cancel">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const userIntentSignature = await readCancelUserIntentSignature(request);
      if (
        userIntentSignature &&
        readCancelUserIntentLoopId(userIntentSignature) !== id
      ) {
        return badRequestResponse("Signed cancel intent does not match loop");
      }

      if (userIntentSignature) {
        const registrationError = await enforceRegisteredBrowserPublicKey({
          userId: user.id,
          organizationId: user.organizationId,
          publicKeyFingerprint: userIntentSignature.publicKeyFingerprint,
        });
        if (registrationError) {
          return registrationError;
        }
      }

      const loop = await loopsService.findById(id, user.organizationId);
      if (!loop) {
        return notFoundResponse("Loop");
      }

      if (loop.computeTargetId) {
        await stopDesktopLoopBestEffort({
          loopId: id,
          computeTargetId: loop.computeTargetId,
          desktopUserIntentSignature: userIntentSignature
            ? {
                commandId: userIntentSignature.commandId,
                signature: userIntentSignature.signature,
                signaturePayload: userIntentSignature.signaturePayload,
                publicKeyFingerprint: userIntentSignature.publicKeyFingerprint,
                body: userIntentSignature.body as JsonValue,
              }
            : undefined,
        });
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
