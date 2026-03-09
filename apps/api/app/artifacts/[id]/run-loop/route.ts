import { success } from "@repo/api/src/types/common";
import type {
  CreateLoopRequest,
  CreateLoopResponse,
} from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { loopsService } from "@/app/loops/service";
import { withAuth } from "@/lib/auth/with-auth";
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
import { runLoopSchema } from "./validators";

/**
 * Map route body commands to LoopCommand enum values.
 */
const COMMAND_MAP = {
  plan: "PLAN",
  execute: "EXECUTE",
  request_changes: "REQUEST_CHANGES",
  decompose: "DECOMPOSE",
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

      // Use findOrCreateWorkstream for robust source discovery via entity links,
      // title matching, and auto-workstream creation — matching the pattern
      // used by regenerate/requestChanges/executePlan service methods.
      const { workstream: resolvedWorkstream, source } =
        await artifactsService.findOrCreateWorkstream(
          user.organizationId,
          artifact,
          user.id
        );

      const workstream = resolvedWorkstream ?? artifact.workstream;

      // Resolve repo: body override → source → artifact fallback
      const targetRepo =
        body.repo?.fullName ?? source?.targetRepo ?? artifact.targetRepo;

      if (handler?.requiresRepo && !targetRepo) {
        return badRequestResponse(
          "No repository configured. Link a repository to the project or set a target repo on the artifact."
        );
      }

      const targetBranch =
        body.repo?.branch ??
        source?.targetBranch ??
        artifact.targetBranch ??
        "main";

      // Build context refs based on source type
      const contextRefs: NonNullable<CreateLoopRequest["contextRefs"]> = [];

      if (source) {
        contextRefs.push({
          sourceId: source.id,
          sourceType: source.type,
          include: "full",
        });
      }

      // Find parent loop when the command builds on prior state
      let parentLoopId: string | undefined;
      if (handler?.requiresParent) {
        const parentLoop = await loopsService.findLatestCompletedForArtifact(
          artifactId,
          user.organizationId
        );
        parentLoopId = parentLoop?.id;
      }

      // For DECOMPOSE, use the system-provided instructions as the prompt.
      // The harness writes this to .claude/context/prompt.md and passes it
      // as the positional argument to the claude CLI.
      const command = COMMAND_MAP[body.command];
      const prompt = body.prompt || getDefaultPrompt(command);

      // Create the Loop
      const loopResponse = await loopsService.create(
        user.organizationId,
        user.id,
        {
          command,
          artifactId,
          workstreamId: workstream?.id,
          parentLoopId,
          prompt,
          repo: targetRepo
            ? { fullName: targetRepo, branch: targetBranch }
            : undefined,
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
