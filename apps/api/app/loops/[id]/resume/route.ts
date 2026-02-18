import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { withAuth } from "@/lib/auth/with-auth";
import { launchLoop } from "@/lib/loop-orchestrator";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { loopsService } from "../../service";
import { resumeLoopValidator } from "../../validators";

export const POST = withAuth<CreateLoopResponse, "/loops/[id]/resume">(
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

      const result = await loopsService.resume(
        id,
        user.organizationId,
        user.id,
        body
      );

      // Fire and forget — launch the resumed loop asynchronously
      launchLoop(result.loopId, user.organizationId).catch((error) => {
        log.error("[resume] Failed to launch resumed loop", {
          loopId: result.loopId,
          parentLoopId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      return successResponse(result);
    } catch (error) {
      return errorResponse("Failed to resume loop", error);
    }
  }
);
