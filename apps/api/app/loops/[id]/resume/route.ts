import type {
  CreateLoopResponse,
  LoopAlreadyActiveBody,
} from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { buildMissingAnthropicApiKeyResponse } from "@/lib/loops/cloud-anthropic-key-preflight";
import { resolveComputeTargetForRoute } from "@/lib/loops/compute-target-route-helpers";
import { isExplicitComputeSelectionRequired } from "@/lib/loops/explicit-compute-selection";
import {
  dispatchAndClassify,
  dispatchFailureResponse,
  dispatchTargetKindFor,
} from "@/lib/loops/loop-dispatch-utils";
import {
  parseBody,
  scheduleLogFlush,
  successResponse,
} from "@/lib/route-utils";
import { handleLoopServiceError } from "../../loop-error-responses";
import { loopsService } from "../../service";
import { resumeLoopValidator } from "../../validators";

type ResumeLoopRouteResponse = CreateLoopResponse | LoopAlreadyActiveBody;

export const POST = withAnyAuth<ResumeLoopRouteResponse, "/loops/[id]/resume">(
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

      // Always validate explicit targets. Inherited targets keep legacy soft
      // Cloud fallback unless explicit compute selection is enabled.
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
            const enforceInheritedTarget =
              await isExplicitComputeSelectionRequired({
                clerkUserId: user.clerkId,
                userId: user.id,
              });
            if (enforceInheritedTarget) {
              return ctResult.errorResponse;
            }
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

      // Cloud only, and deliberately ahead of `loopsService.resume`. Resume
      // reaches Cloud two ways — no target requested and the parent had none,
      // or the parent's target is no longer accessible and the block above fell
      // back — and `loopsService.resume` persists `computeTargetId ?? null`, so
      // an unresolved target really does mean an ECS child that needs a key.
      // The awaited dispatch below would report the missing key either way; the
      // reason this runs first is the side effect the sibling run-loop
      // pre-flight documents: without it every retry inserts another child loop
      // purely to cancel it a moment later.
      const missingKeyResponse = await buildMissingAnthropicApiKeyResponse({
        resolvedComputeTargetId,
        userId: user.id,
        organizationId: user.organizationId,
      });
      if (missingKeyResponse) {
        return missingKeyResponse;
      }

      const result = await loopsService.resume(
        id,
        user.organizationId,
        user.id,
        body,
        resolvedComputeTargetId
      );

      // ISS-5708: await the dispatch. Resuming used to answer 200 the moment
      // the Loop row existed, so a resume whose command never reached the
      // desktop read as success — the same false-success this ticket fixed on
      // the initial-launch route, reachable through a second door.
      const dispatchResult = await dispatchAndClassify(
        result.loopId,
        user.organizationId,
        "resume",
        { computeTargetId: resolvedComputeTargetId, parentLoopId: id }
      );
      scheduleLogFlush();
      if (!dispatchResult.ok) {
        // Resume falls back to cloud when the parent's target is no longer
        // accessible, so this genuinely varies per request.
        return dispatchFailureResponse(
          dispatchResult.error,
          dispatchTargetKindFor(resolvedComputeTargetId)
        );
      }

      return successResponse(result);
    } catch (error) {
      return handleLoopServiceError(error, "Failed to resume loop");
    }
  },
  { requiredScopes: ["write"] }
);
