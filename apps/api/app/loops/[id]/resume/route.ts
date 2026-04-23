import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveComputeTargetForRoute } from "@/lib/loops/compute-target-route-helpers";
import { launchLoop } from "@/lib/loops/loop-orchestrator";
import {
  errorResponse,
  parseBody,
  scheduleLogFlushAfter,
  successResponse,
} from "@/lib/route-utils";
import { isConcurrentLoopLimitError, loopsService } from "../../service";
import { resumeLoopValidator } from "../../validators";

export const POST = withAnyAuth<CreateLoopResponse, "/loops/[id]/resume">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      const { body, errorResponse: parseError } = await parseBody(
        request,
        resumeLoopValidator
      );
      if (parseError) {
        return parseError;
      }

      // Always validate the compute target — whether explicitly provided or
      // inherited from the parent. An inherited target may have been unshared
      // or gone offline since the parent ran; soft-fail to cloud in that case.
      let resolvedComputeTargetId: string | undefined;
      if (body.computeTargetId) {
        const ctResult = await resolveComputeTargetForRoute(
          user.organizationId,
          user.id,
          body.computeTargetId
        );
        if ("errorResponse" in ctResult) {
          return ctResult.errorResponse;
        }
        resolvedComputeTargetId = ctResult.computeTargetId;
      } else {
        // No explicit target — validate the parent's target if it had one.
        const parentLoop = await loopsService.findById(id, user.organizationId);
        if (parentLoop?.computeTargetId) {
          const ctResult = await resolveComputeTargetForRoute(
            user.organizationId,
            user.id,
            parentLoop.computeTargetId
          );
          if ("errorResponse" in ctResult) {
            log.warn(
              "[resume] Parent compute target no longer accessible, falling back to cloud",
              {
                parentLoopId: id,
                parentComputeTargetId: parentLoop.computeTargetId,
              }
            );
          } else {
            resolvedComputeTargetId = ctResult.computeTargetId;
          }
        }
      }

      const result = await loopsService.resume(
        id,
        user.organizationId,
        user.id,
        body,
        resolvedComputeTargetId
      );

      // Launch the resumed loop asynchronously. scheduleLogFlushAfter() keeps
      // the serverless function alive via waitUntil until launchLoop() settles,
      // then flushes — so launchLoop()'s own log entries are included.
      const launchPromise = launchLoop(
        result.loopId,
        user.organizationId
      ).catch((error) => {
        log.error("[resume] Failed to launch resumed loop", {
          loopId: result.loopId,
          parentLoopId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      scheduleLogFlushAfter(launchPromise);

      return successResponse(result);
    } catch (error) {
      if (isConcurrentLoopLimitError(error)) {
        return errorResponse(error.message, error, 429);
      }
      return errorResponse("Failed to resume loop", error);
    }
  },
  { requiredScopes: ["write"] }
);
