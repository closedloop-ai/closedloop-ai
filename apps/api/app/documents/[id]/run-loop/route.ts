import {
  DESKTOP_API_NAMESPACE_CAPABILITY_KEY,
  type DesktopApiNamespace,
  LEGACY_DESKTOP_API_NAMESPACE,
} from "@repo/api/src/desktop-api-namespace";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { success } from "@repo/api/src/types/common";
import type {
  BackendMismatchBody,
  ComputeTargetConflictBody,
} from "@repo/api/src/types/compute-target";
import {
  type CreateLoopResponse,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { documentExecutionService } from "@/app/documents/execution-service";
import { documentGenerationService } from "@/app/documents/generation-service";
import {
  isBranchNotFoundError,
  isConcurrentLoopLimitError,
  isUnauthorizedRepoError,
  loopsService,
} from "@/app/loops/service";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
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
  scheduleLogFlushAfter,
} from "@/lib/route-utils";
import {
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
  if (isUnauthorizedRepoError(error)) {
    return errorResponse(error.message, error, 403);
  }
  if (isBranchNotFoundError(error)) {
    return errorResponse(error.message, error, 400);
  }
  return errorResponse("Failed to run loop", error);
}

function getLoopMetadata(
  desktopApiNamespace: DesktopApiNamespace | undefined
): Record<string, DesktopApiNamespace> | undefined {
  if (desktopApiNamespace !== LEGACY_DESKTOP_API_NAMESPACE) {
    return undefined;
  }

  return {
    [DESKTOP_API_NAMESPACE_CAPABILITY_KEY]: desktopApiNamespace,
  };
}

type RunLoopResponse =
  | CreateLoopResponse
  | ComputeTargetConflictBody
  | BackendMismatchBody;

export const POST = withAnyAuth<RunLoopResponse, "/documents/[id]/run-loop">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const documentId = await resolveDocumentId(id, user.organizationId);
      if (!documentId) {
        return notFoundResponse("Document");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        runLoopSchema
      );
      if (!body) {
        return parseError;
      }

      const artifact =
        await documentGenerationService.findWithRegenerationContext(
          documentId,
          user.organizationId
        );
      if (!artifact) {
        return notFoundResponse("Document");
      }

      const handler = getCommandHandler(COMMAND_MAP[body.command]);

      const ctRouteResult = await resolveRunLoopComputeTarget(
        user.organizationId,
        user.id,
        body.computeTargetId
      );
      if ("errorResponse" in ctRouteResult) {
        return ctRouteResult.errorResponse;
      }
      const { computeTargetId: resolvedComputeTargetId } = ctRouteResult;

      // Guard: prevent launching a loop for artifacts originally planned via
      // GH Actions. State cannot migrate between backends, so the earliest
      // execution determines the canonical backend.
      // Commands that build on prior state (requiresParent) are locked to
      // the original backend. Fresh-start commands (like PLAN) are exempt.
      if (handler?.requiresParent) {
        const rejection =
          await documentExecutionService.assertLoopBackendAllowed(
            documentId,
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
        additionalRepos: resolvedAdditionalRepos,
      } = await resolveLoopContext(
        artifact,
        body,
        handler,
        user.organizationId,
        user.id,
        documentId,
        resolvedComputeTargetId
      );

      let targetBranch = resolvedTargetBranch;

      if (handler?.requiresRepo && !targetRepo) {
        return badRequestResponse(
          "No repository configured. Link a repository to the project or set a target repo on the artifact."
        );
      }

      const evaluateBranchResult = await resolveEvaluateCodeBranchForRunLoop(
        body.command,
        documentId,
        user.organizationId,
        targetRepo,
        targetBranch
      );
      if (!evaluateBranchResult.ok) {
        return evaluateBranchResult.response;
      }
      targetBranch = evaluateBranchResult.branch;

      // Guard: detect backend mismatch for state-dependent commands.
      // When the resolved compute target differs from the one used by the
      // artifact's last completed loop, resuming would corrupt incremental
      // state. Callers may override with backendOverride: true when they
      // have confirmed the switch is intentional.
      if (handler?.requiresParent && !body.backendOverride) {
        const mismatch = await checkBackendMismatch(
          documentId,
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

      const loopResponse = await loopsService.create(
        user.organizationId,
        user.id,
        {
          command,
          documentId,
          workstreamId: workstream?.id,
          parentLoopId,
          computeTargetId: resolvedComputeTargetId,
          prompt,
          repo: targetRepo
            ? { fullName: targetRepo, branch: targetBranch }
            : undefined,
          additionalRepos: resolvedAdditionalRepos,
          contextRefs: contextRefs.length > 0 ? contextRefs : undefined,
          metadata: getLoopMetadata(body.desktopApiNamespace),
        }
      );

      // Auto-evaluate the source PRD when the user triggers plan generation.
      // Skipped if a loop already exists for that PRD's current version.
      if (
        body.command === RunLoopCommand.Plan &&
        source?.type === ArtifactType.Document
      ) {
        scheduleAutoEvaluatePrd(source.id, user.organizationId, user.id);
      }

      const launchPromise = launchLoop(
        loopResponse.loopId,
        user.organizationId
      ).catch((error) => {
        log.error("[run-loop] Failed to launch loop", {
          loopId: loopResponse.loopId,
          documentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      // Flush after launchLoop() settles so its own log entries are captured.
      scheduleLogFlushAfter(launchPromise);

      return NextResponse.json(success(loopResponse));
    } catch (error) {
      return handleRunLoopError(error);
    }
  }
);
