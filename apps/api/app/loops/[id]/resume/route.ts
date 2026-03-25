import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveComputeTargetForRoute } from "@/lib/loops/compute-target-route-helpers";
import { launchLoop } from "@/lib/loops/loop-orchestrator";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";
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

      // Only resolve a fresh compute target when the client explicitly
      // provides one. Otherwise the service falls back to the parent loop's
      // computeTargetId so resumed loops stay on the same backend that has
      // the prior .claude/worktree state.
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
      }

      const result = await loopsService.resume(
        id,
        user.organizationId,
        user.id,
        body,
        resolvedComputeTargetId
      );

      // Launch the resumed loop asynchronously. waitUntil() keeps the
      // serverless function alive so deployments don't kill it mid-launch.
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
      waitUntil(launchPromise);

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to resume loop", error);
    }
  },
  { requiredScopes: ["write"] }
);
