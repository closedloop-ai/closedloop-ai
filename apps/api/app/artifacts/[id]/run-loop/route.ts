import { success } from "@repo/api/src/types/common";
import type {
  BackendMismatchBody,
  ComputeTargetConflictBody,
} from "@repo/api/src/types/compute-target";
import { EntityType } from "@repo/api/src/types/entity-link";
import {
  type CreateLoopResponse,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { isConcurrentLoopLimitError, loopsService } from "@/app/loops/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
import { scheduleAutoEvaluatePrd } from "@/lib/loops/auto-evaluate-prd";
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
import {
  buildAdditionalReposInput,
  COMMAND_MAP,
  checkBackendMismatch,
  resolveEvaluateCodeBranchForRunLoop,
  resolveLoopContext,
  resolveRunLoopComputeTarget,
} from "./run-loop-helpers";
import { runLoopSchema } from "./validators";

function handleRunLoopError(error: unknown) {
  if (isConcurrentLoopLimitError(error)) {
    return errorResponse(error.message, error, 429);
  }
  return errorResponse("Failed to run loop", error);
}

type RunLoopResponse =
  | CreateLoopResponse
  | ComputeTargetConflictBody
  | BackendMismatchBody;

export const POST = withAnyAuth<RunLoopResponse, "/artifacts/[id]/run-loop">(
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
        targetBranch: resolvedTargetBranch,
        contextRefs,
        parentLoopId,
        parentLoopComputeTargetId,
        source,
      } = await resolveLoopContext(
        artifact,
        body,
        handler,
        user.organizationId,
        user.id,
        artifactId
      );

      let targetBranch = resolvedTargetBranch;

      if (handler?.requiresRepo && !targetRepo) {
        return badRequestResponse(
          "No repository configured. Link a repository to the project or set a target repo on the artifact."
        );
      }

      const evaluateBranchResult = await resolveEvaluateCodeBranchForRunLoop(
        body.command,
        artifactId,
        user.organizationId,
        targetBranch
      );
      if (!evaluateBranchResult.ok) {
        return evaluateBranchResult.response;
      }
      targetBranch = evaluateBranchResult.branch;

      const ctRouteResult = await resolveRunLoopComputeTarget(
        user.organizationId,
        user.id,
        body.computeTargetId
      );
      if ("errorResponse" in ctRouteResult) {
        return ctRouteResult.errorResponse;
      }
      const { computeTargetId: resolvedComputeTargetId } = ctRouteResult;

      // Guard: detect backend mismatch for state-dependent commands.
      // When the resolved compute target differs from the one used by the
      // artifact's last completed loop, resuming would corrupt incremental
      // state. Callers may override with backendOverride: true when they
      // have confirmed the switch is intentional.
      if (handler?.requiresParent && !body.backendOverride) {
        const mismatch = await checkBackendMismatch(
          artifactId,
          user.organizationId,
          resolvedComputeTargetId,
          parentLoopComputeTargetId
        );
        if (mismatch) {
          return mismatch;
        }
      }

      const command = COMMAND_MAP[body.command];
      const prompt = body.prompt || getDefaultPrompt(command);

      // Resolve additional repos: apply feature flag and PLAN-only gate.
      const additionalRepos = buildAdditionalReposInput(
        body.additionalRepos,
        body.command,
        artifactId
      );

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
          additionalRepos,
          contextRefs: contextRefs.length > 0 ? contextRefs : undefined,
        }
      );

      // Auto-evaluate the source PRD when the user triggers plan generation.
      // Skipped if a loop already exists for that PRD's current version.
      if (
        body.command === RunLoopCommand.Plan &&
        source?.type === EntityType.Artifact
      ) {
        scheduleAutoEvaluatePrd(source.id, user.organizationId, user.id);
      }

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
      return handleRunLoopError(error);
    }
  }
);
