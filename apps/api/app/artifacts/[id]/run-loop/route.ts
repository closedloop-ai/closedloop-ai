import { success } from "@repo/api/src/types/common";
import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { loopsService } from "@/app/loops/service";
import { withAuth } from "@/lib/auth/with-auth";
import { launchLoop } from "@/lib/loop-orchestrator";
import {
  badRequestResponse,
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

      // Resolve repo info from the artifact's workstream/project
      const workstream = artifact.workstream;
      const project = workstream?.project;
      const existingRepository = project?.repositories[0];
      const sourceArtifact = workstream?.artifacts[0];

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

      // Create the Loop
      const loopResponse = await loopsService.create(
        user.organizationId,
        user.id,
        {
          command: COMMAND_MAP[body.command],
          artifactId,
          workstreamId: workstream?.id,
          prompt: body.prompt,
          repo: { fullName: targetRepo, branch: targetBranch },
        }
      );

      // Fire and forget - launch the loop asynchronously
      launchLoop(loopResponse.loopId, user.organizationId).catch((error) => {
        log.error("[run-loop] Failed to launch loop", {
          loopId: loopResponse.loopId,
          artifactId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      return NextResponse.json(success(loopResponse));
    } catch (error) {
      return errorResponse("Failed to run loop", error);
    }
  }
);
