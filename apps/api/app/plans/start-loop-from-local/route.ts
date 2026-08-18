import { type ApiResult, success } from "@repo/api/src/types/common";
import type { LoopAlreadyActiveBody } from "@repo/api/src/types/loop";
import type { StartPlanLoopResponse } from "@repo/api/src/types/plan-loop";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { documentExecutionService } from "@/app/documents/execution-service";
import {
  handleLoopServiceError,
  loopAlreadyActiveResponse,
} from "@/app/loops/loop-error-responses";
import { repoSchema } from "@/app/loops/validators";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { launchPlanLoop } from "@/lib/loops/launch-plan-loop";
import {
  CALLBACK_UNAVAILABLE_DISPATCH_MESSAGE,
  LAUNCH_FAILED_DISPATCH_MESSAGE,
  MISSING_ANTHROPIC_API_KEY_MESSAGE,
  PARENT_STATE_UNAVAILABLE_DISPATCH_MESSAGE,
} from "@/lib/loops/loop-dispatch-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  scheduleLogFlush,
} from "@/lib/route-utils";

// Accept both variants: with and without selectedArtifactId.
// Parse the wider schema first; selectedArtifactId is optional.
const bodySchema = z
  .object({
    featureId: z.string().uuid(),
    ticketTitle: z.string().optional(),
    computeTargetId: z.string().uuid(),
    localRepoPath: z.string().min(1),
    repo: repoSchema.optional(),
    selectedDocumentId: z.string().uuid().optional(),
  })
  .strict();

type StartPlanLoopRouteResponse = StartPlanLoopResponse | LoopAlreadyActiveBody;

export const POST = withAnyAuth<StartPlanLoopRouteResponse>(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        bodySchema
      );
      if (!body) {
        return parseError;
      }

      const result = await documentExecutionService.startPlanLoopFromLocal(
        user.organizationId,
        user.id,
        {
          featureId: body.featureId,
          ticketTitle: body.ticketTitle,
          computeTargetId: body.computeTargetId,
          localRepoPath: body.localRepoPath,
          repo: body.repo,
          selectedDocumentId: body.selectedDocumentId,
        }
      );

      if (result.outcome === "needs-selection") {
        return NextResponse.json(
          success<StartPlanLoopResponse>({
            outcome: "needs-selection",
            documents: result.documents,
          })
        );
      }

      if (result.outcome === "invalid-document") {
        return NextResponse.json(
          success<StartPlanLoopResponse>({
            outcome: "invalid-document",
            existingDocuments: result.existingDocuments,
          })
        );
      }

      if (result.outcome === "already-running") {
        return NextResponse.json(
          success<StartPlanLoopResponse>({
            outcome: "already-running",
            loopId: result.loopId,
            documentId: result.documentId,
            documentSlug: result.documentSlug,
            localRepoPath: result.localRepoPath,
          })
        );
      }

      if (result.outcome === "already-active-conflict") {
        return loopAlreadyActiveResponse({
          loopId: result.activeLoop.id,
          command: result.activeLoop.command,
          status: result.activeLoop.status,
          message: `A ${result.activeLoop.command} loop is already active on a different compute target (id: ${result.activeLoop.id}, status: ${result.activeLoop.status}). Cancel or wait for the existing loop to complete before starting a new one.`,
        });
      }

      if (result.outcome === "error") {
        return NextResponse.json(
          success<StartPlanLoopResponse>({
            outcome: "error",
            reason: result.reason,
          })
        );
      }

      // outcome === "ready-to-launch"
      const launchResult = await launchPlanLoop({
        artifact: result.document,
        organizationId: user.organizationId,
        userId: user.id,
        documentId: result.documentId,
        computeTargetId: body.computeTargetId,
        repoOverride: body.repo,
        metadata: {
          localRepoPath: body.localRepoPath,
          launchSource: "engineer_start_planning",
          featureId: body.featureId,
        },
      });

      if (!launchResult.ok) {
        return planLaunchFailureResponse(launchResult.error);
      }

      log.info("[start-loop-from-local] Plan loop launched", {
        loopId: launchResult.loopResponse.loopId,
        documentId: result.documentId,
        featureId: body.featureId,
      });
      scheduleLogFlush();
      return NextResponse.json(
        success<StartPlanLoopResponse>({
          outcome: "launched",
          loopId: launchResult.loopResponse.loopId,
          documentId: result.documentId,
          documentSlug: result.documentSlug,
        })
      );
    } catch (error) {
      return handleLoopServiceError(error, "Failed to start plan loop");
    }
  },
  { requiredScopes: ["write"] }
);

/**
 * Maps a failed `launchPlanLoop` result to its route response. Extracted from
 * the handler rather than inlined: the handler was already at the cognitive
 * complexity ceiling, and adding the `parent_state_unavailable` arm pushed it
 * over. Exhaustive by construction — the final `badRequestResponse` is the
 * compute-target-offline case, not a silent catch-all for unhandled codes.
 */
function planLaunchFailureResponse(
  error: Extract<
    Awaited<ReturnType<typeof launchPlanLoop>>,
    { ok: false }
  >["error"]
): NextResponse<ApiResult<never>> {
  switch (error) {
    case "compute_target_not_found":
      return notFoundResponse("Compute target");
    case "missing_anthropic_api_key":
      return badRequestResponse(MISSING_ANTHROPIC_API_KEY_MESSAGE);
    case "parent_state_unavailable":
      // Not reachable today (this route launches PLAN, which has no
      // `requiresParent` handler), but handled explicitly so the code can never
      // fall through to the offline-desktop copy, which would be untrue for a
      // guard that never dispatched anything.
      return badRequestResponse(PARENT_STATE_UNAVAILABLE_DISPATCH_MESSAGE);
    case "callback_unavailable":
      return errorResponse(CALLBACK_UNAVAILABLE_DISPATCH_MESSAGE, null);
    case "launch_failed":
      return errorResponse(LAUNCH_FAILED_DISPATCH_MESSAGE, null);
    case "no_online_targets":
      return badRequestResponse(
        "No online compute targets found. Ensure the desktop app is running."
      );
    case "multiple_targets":
      return badRequestResponse(
        "Multiple compute targets are online. Specify a computeTargetId to select one."
      );
    default:
      return badRequestResponse(
        "Compute target is offline. Ensure the desktop app is running."
      );
  }
}
