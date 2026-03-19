import { success } from "@repo/api/src/types/common";
import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { loopsService } from "@/app/loops/service";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveComputeTarget } from "@/lib/loops/compute-target-resolver";
import { getCommandHandler } from "@/lib/loops/loop-commands";
import { launchLoop } from "@/lib/loops/loop-orchestrator";
import { getDefaultPrompt } from "@/lib/loops/prompts";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
} from "@/lib/route-utils";
import { artifactsService } from "../../service";
import { COMMAND_MAP, resolveLoopContext } from "./run-loop-helpers";
import { runLoopSchema } from "./validators";

type RunLoopResponse = CreateLoopResponse | ComputeTargetConflictBody;

export const POST = withAuth<RunLoopResponse, "/artifacts/[id]/run-loop">(
  async ({ user }, request, params) => {
    try {
      const { id: artifactId } = await params;

      const { body, errorResponse: parseError } = await parseBody(
        request,
        runLoopSchema
      );
      if (!body) {
        return parseError;
      }

      const artifact = await artifactsService.findWithRegenerationContext(
        artifactId,
        user.organizationId
      );
      if (!artifact) {
        return notFoundResponse("Artifact");
      }

      const handler = getCommandHandler(COMMAND_MAP[body.command]);

      // Guard: prevent launching a loop for artifacts originally planned via
      // GH Actions. State cannot migrate between backends, so the earliest
      // execution determines the canonical backend.
      // Commands that build on prior state (requiresParent) are locked to
      // the original backend. Fresh-start commands (like PLAN) are exempt.
      if (handler?.requiresParent) {
        const rejection = await artifactsService.assertLoopBackendAllowed(
          artifactId,
          user.organizationId,
          artifact.workstreamId
        );
        if (rejection) {
          return conflictResponse(rejection);
        }
      }

      const {
        workstream,
        targetRepo,
        targetBranch,
        contextRefs,
        parentLoopId,
      } = await resolveLoopContext(
        artifact,
        body,
        handler,
        user.organizationId,
        user.id,
        artifactId
      );

      if (handler?.requiresRepo && !targetRepo) {
        return badRequestResponse(
          "No repository configured. Link a repository to the project or set a target repo on the artifact."
        );
      }

      const ctResult = await resolveComputeTarget(
        user.organizationId,
        user.id,
        body.computeTargetId
      );

      let resolvedComputeTargetId: string | undefined;
      switch (ctResult.reason) {
        case "resolved":
          resolvedComputeTargetId = ctResult.target.id;
          break;
        case "hint_not_found":
          return notFoundResponse("Compute target");
        case "hint_offline":
          return badRequestResponse(
            "Compute target is offline. Ensure the desktop app is running."
          );
        case "no_targets":
          return badRequestResponse(
            "No compute targets found. Ensure the desktop app is running."
          );
        case "no_online_targets":
          return badRequestResponse(
            "No compute targets are online. Ensure the desktop app is running."
          );
        case "multiple_targets": {
          const conflictBody: ComputeTargetConflictBody = {
            error: "multiple_targets",
            message:
              "Multiple compute targets are online. Specify a compute target ID.",
            availableTargets: ctResult.targets.map((t) => ({
              id: t.id,
              machineName: t.machineName,
              status: t.isOnline ? "online" : "offline",
            })),
          };
          return NextResponse.json(success(conflictBody), { status: 409 });
        }
        default: {
          const _exhaustive: never = ctResult;
          return errorResponse(
            "Unhandled compute target resolution result",
            _exhaustive
          );
        }
      }

      const command = COMMAND_MAP[body.command];
      const prompt = body.prompt || getDefaultPrompt(command);

      const loopResponse = await loopsService.create(
        user.organizationId,
        user.id,
        {
          command,
          artifactId,
          workstreamId: workstream?.id,
          parentLoopId,
          computeTargetId: resolvedComputeTargetId,
          prompt,
          repo: targetRepo
            ? { fullName: targetRepo, branch: targetBranch }
            : undefined,
          contextRefs: contextRefs.length > 0 ? contextRefs : undefined,
        }
      );

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
