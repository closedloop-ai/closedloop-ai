import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveComputeTargetForRoute } from "@/lib/loops/compute-target-route-helpers";
import { launchLoop } from "@/lib/loops/loop-orchestrator";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import {
  fetchOrgLoopLimit,
  isConcurrentLoopLimitError,
  loopsService,
} from "../../service";
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

      const maxConcurrentLoops = await fetchOrgLoopLimit(user.organizationId);

      // resolveComputeTargetForRoute already validates ownership via
      // findOwnedById when a hint is provided — no separate check needed.
      const ctResult = await resolveComputeTargetForRoute(
        user.organizationId,
        user.id,
        body.computeTargetId
      );
      if ("errorResponse" in ctResult) {
        return ctResult.errorResponse;
      }

      const result = await loopsService.resume(
        id,
        user.organizationId,
        user.id,
        body,
        maxConcurrentLoops,
        ctResult.computeTargetId
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
      if (isConcurrentLoopLimitError(error)) {
        return errorResponse(error.message, error, 429);
      }
      return errorResponse("Failed to resume loop", error);
    }
  },
  { requiredScopes: ["write"] }
);
