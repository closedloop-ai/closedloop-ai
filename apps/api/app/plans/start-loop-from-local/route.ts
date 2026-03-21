import { success } from "@repo/api/src/types/common";
import type { StartPlanLoopResponse } from "@repo/api/src/types/plan-loop";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { artifactsService } from "@/app/artifacts/service";
import { repoSchema } from "@/app/loops/validators";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { launchPlanLoop } from "@/lib/loops/launch-plan-loop";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
} from "@/lib/route-utils";

// Accept both variants: with and without selectedArtifactId.
// Parse the wider schema first; selectedArtifactId is optional.
const bodySchema = z
  .object({
    issueId: z.string().uuid(),
    ticketTitle: z.string().optional(),
    computeTargetId: z.string().uuid(),
    localRepoPath: z.string().min(1),
    repo: repoSchema.optional(),
    selectedArtifactId: z.string().uuid().optional(),
  })
  .strict();

export const POST = withAnyAuth<StartPlanLoopResponse>(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        bodySchema
      );
      if (!body) {
        return parseError;
      }

      const result = await artifactsService.startPlanLoopFromLocal(
        user.organizationId,
        user.id,
        {
          issueId: body.issueId,
          ticketTitle: body.ticketTitle,
          computeTargetId: body.computeTargetId,
          localRepoPath: body.localRepoPath,
          repo: body.repo,
          selectedArtifactId: body.selectedArtifactId,
        }
      );

      if (result.outcome === "needs-selection") {
        return NextResponse.json(
          success<StartPlanLoopResponse>({
            outcome: "needs-selection",
            artifacts: result.artifacts,
          })
        );
      }

      if (result.outcome === "invalid-artifact") {
        return NextResponse.json(
          success<StartPlanLoopResponse>({
            outcome: "invalid-artifact",
            existingArtifacts: result.existingArtifacts,
          })
        );
      }

      if (result.outcome === "already-running") {
        return NextResponse.json(
          success<StartPlanLoopResponse>({
            outcome: "already-running",
            loopId: result.loopId,
            artifactId: result.artifactId,
            artifactSlug: result.artifactSlug,
            localRepoPath: result.localRepoPath,
          })
        );
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
        artifact: result.artifact,
        organizationId: user.organizationId,
        userId: user.id,
        artifactId: result.artifactId,
        computeTargetId: body.computeTargetId,
        repoOverride: body.repo,
        metadata: {
          localRepoPath: body.localRepoPath,
          launchSource: "engineer_start_planning",
          issueId: body.issueId,
        },
      });

      if (!launchResult.ok) {
        if (launchResult.error === "compute_target_not_found") {
          return notFoundResponse("Compute target");
        }
        if (launchResult.error === "launch_failed") {
          return errorResponse(
            "Loop dispatch failed. The desktop app may be disconnected.",
            null
          );
        }
        if (launchResult.error === "no_online_targets") {
          return badRequestResponse(
            "No online compute targets found. Ensure the desktop app is running."
          );
        }
        if (launchResult.error === "multiple_targets") {
          return badRequestResponse(
            "Multiple compute targets are online. Specify a computeTargetId to select one."
          );
        }
        return badRequestResponse(
          "Compute target is offline. Ensure the desktop app is running."
        );
      }

      log.info("[start-loop-from-local] Plan loop launched", {
        loopId: launchResult.loopResponse.loopId,
        artifactId: result.artifactId,
        issueId: body.issueId,
      });

      return NextResponse.json(
        success<StartPlanLoopResponse>({
          outcome: "launched",
          loopId: launchResult.loopResponse.loopId,
          artifactId: result.artifactId,
          artifactSlug: result.artifactSlug,
        })
      );
    } catch (error) {
      return errorResponse("Failed to start plan loop", error);
    }
  },
  { requiredScopes: ["write"] }
);
