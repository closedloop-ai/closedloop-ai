import { success } from "@repo/api/src/types/common";
import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { loopsService } from "@/app/loops/service";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
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
import { validateComputeTarget } from "./compute-target-validation";
import { COMMAND_MAP, resolveLoopContext } from "./run-loop-helpers";
import { runLoopSchema } from "./validators";

export const POST = withAuth<CreateLoopResponse, "/artifacts/[id]/run-loop">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const artifactId = await resolveArtifactId(id, user.organizationId);
      if (!artifactId) {
        return notFoundResponse("Artifact");
      }

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

      if (body.computeTargetId) {
        const ctResult = await validateComputeTarget(
          body.computeTargetId,
          user.organizationId
        );
        if (!ctResult.valid) {
          if (ctResult.reason === "not_found") {
            return notFoundResponse("Compute target");
          }
          return badRequestResponse(
            "Compute target is offline. Ensure the desktop app is running."
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
          computeTargetId: body.computeTargetId,
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
