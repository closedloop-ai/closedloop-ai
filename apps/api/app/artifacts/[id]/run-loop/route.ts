import { success } from "@repo/api/src/types/common";
import type {
  CreateLoopRequest,
  CreateLoopResponse,
} from "@repo/api/src/types/loop";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { loopsService } from "@/app/loops/service";
import { withAuth } from "@/lib/auth/with-auth";
import { launchLoop } from "@/lib/loop-orchestrator";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
} from "@/lib/route-utils";
import { artifactsService } from "../../service";
import { runLoopSchema } from "./validators";

/**
 * Map route body commands to LoopCommand enum values.
 */
const COMMAND_MAP = {
  plan: "PLAN",
  execute: "EXECUTE",
  request_changes: "REQUEST_CHANGES",
} as const;

export const POST = withAuth<CreateLoopResponse, "/artifacts/[id]/run-loop">(
  async ({ user }, request, params) => {
    try {
      const { id: artifactId } = await params;

      // Parse and validate body
      const { body, errorResponse: parseError } = await parseBody(
        request,
        runLoopSchema
      );
      if (!body) {
        return parseError;
      }

      // Verify artifact exists and belongs to org
      const artifact = await artifactsService.findWithRegenerationContext(
        artifactId,
        user.organizationId
      );

      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      // Guard: prevent launching a loop for artifacts originally planned via
      // GH Actions. State cannot migrate between backends, so the earliest
      // execution determines the canonical backend — even if loops were
      // accidentally run in the meantime.
      // "plan" is exempt: re-planning generates fresh state, so switching
      // backends at plan time is safe.
      if (body.command !== "plan") {
        const earliestGhAction = artifact.workstreamId
          ? await withDb((db) =>
              db.gitHubActionRun.findFirst({
                where: {
                  workstreamId: artifact.workstreamId!,
                  status: {
                    in: ["PENDING", "QUEUED", "RUNNING", "SUCCESS"],
                  },
                  triggerData: { path: ["artifactId"], equals: artifactId },
                },
                orderBy: { createdAt: "asc" },
                select: { id: true, createdAt: true },
              })
            )
          : null;

        if (earliestGhAction) {
          // Check if a loop was created even earlier (artifact started on Loops)
          const earlierLoop = await withDb((db) =>
            db.loop.findFirst({
              where: {
                artifactId,
                organizationId: user.organizationId,
                status: "COMPLETED",
                createdAt: { lt: earliestGhAction.createdAt },
              },
              select: { id: true },
            })
          );

          if (!earlierLoop) {
            return conflictResponse(
              "This artifact was originally planned via GitHub Actions. Use the GitHub Actions path for subsequent operations to maintain state continuity."
            );
          }
        }
      }

      // Use findOrCreateWorkstream for robust PRD discovery via entity links,
      // title matching, and auto-workstream creation — matching the pattern
      // used by regenerate/requestChanges/executePlan service methods.
      const { workstream: resolvedWorkstream, sourceArtifact } =
        await artifactsService.findOrCreateWorkstream(
          user.organizationId,
          artifact,
          user.id
        );

      const workstream = resolvedWorkstream ?? artifact.workstream;
      const project = workstream?.project;
      const existingRepository = project?.repositories[0];

      const targetRepo =
        sourceArtifact?.targetRepo ??
        artifact.targetRepo ??
        existingRepository?.fullName;

      if (!targetRepo) {
        return badRequestResponse(
          "No repository configured. Link a repository to the project or set a target repo on the artifact."
        );
      }

      const targetBranch =
        sourceArtifact?.targetBranch ??
        artifact.targetBranch ??
        existingRepository?.defaultBranch ??
        "main";

      // Build context refs: include the source PRD so the harness can write prd.md
      const contextRefs: NonNullable<CreateLoopRequest["contextRefs"]> = [];
      if (sourceArtifact) {
        contextRefs.push({ artifactId: sourceArtifact.id, include: "full" });
      }

      // Find parent loop for non-PLAN commands
      // REQUEST_CHANGES needs parent's plan.json state
      // EXECUTE needs parent's plan.json + branch name for code changes
      let parentLoopId: string | undefined;
      if (body.command !== "plan") {
        const parentLoop = await loopsService.findLatestCompletedForArtifact(
          artifactId,
          user.organizationId
        );
        parentLoopId = parentLoop?.id;
      }

      // Create the Loop
      const loopResponse = await loopsService.create(
        user.organizationId,
        user.id,
        {
          command: COMMAND_MAP[body.command],
          artifactId,
          workstreamId: workstream?.id,
          parentLoopId,
          prompt: body.prompt,
          repo: { fullName: targetRepo, branch: targetBranch },
          contextRefs: contextRefs.length > 0 ? contextRefs : undefined,
        }
      );

      // Launch the loop asynchronously. waitUntil() keeps the serverless
      // function alive after the response is sent so a Vercel deployment
      // (or idle timeout) doesn't kill the launch mid-flight.
      const launchPromise = launchLoop(
        loopResponse.loopId,
        user.organizationId
      ).catch((error) => {
        log.error("[run-loop] Failed to launch loop", {
          loopId: loopResponse.loopId,
          artifactId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      waitUntil(launchPromise);

      return NextResponse.json(success(loopResponse));
    } catch (error) {
      return errorResponse("Failed to run loop", error);
    }
  }
);
