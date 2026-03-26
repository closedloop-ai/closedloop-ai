import {
  type PullRequestInfo,
  PullRequestState,
} from "@repo/api/src/types/artifact";
import type { ApiResult, JsonObject } from "@repo/api/src/types/common";
import type {
  BackendMismatchBody,
  ComputeTargetConflictBody,
} from "@repo/api/src/types/compute-target";
import {
  type CreateLoopRequest,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { getProjectSettings } from "@repo/api/src/types/project";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { computeTargetsService } from "@/app/compute-targets/service";
import { loopsService } from "@/app/loops/service";
import {
  type ResolveComputeTargetResult,
  resolveComputeTarget,
} from "@/lib/loops/compute-target-resolver";
import type { getCommandHandler } from "@/lib/loops/loop-commands";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
} from "@/lib/route-utils";
import { artifactsService } from "../../service";

/**
 * Map route body commands (lowercase) to LoopCommand enum values (uppercase).
 */
export const COMMAND_MAP = {
  [RunLoopCommand.Plan]: "PLAN",
  [RunLoopCommand.Execute]: "EXECUTE",
  [RunLoopCommand.RequestChanges]: "REQUEST_CHANGES",
  [RunLoopCommand.Decompose]: "DECOMPOSE",
  [RunLoopCommand.EvaluatePrd]: "EVALUATE_PRD",
  [RunLoopCommand.GeneratePrd]: "GENERATE_PRD",
  [RunLoopCommand.EvaluatePlan]: "EVALUATE_PLAN",
  [RunLoopCommand.EvaluateCode]: "EVALUATE_CODE",
} as const;

/**
 * For EVALUATE_CODE loops: require an open PR linked to the artifact workstream
 * and return its head branch for the harness clone target.
 */
export function resolveEvaluateCodeTargetBranch(
  pr: PullRequestInfo | null
): { ok: true; branch: string } | { ok: false; message: string } {
  if (!pr || pr.state !== PullRequestState.Open) {
    return {
      ok: false,
      message:
        "No open pull request found. Execute the plan first to create a PR.",
    };
  }
  return { ok: true, branch: pr.headBranch };
}

/**
 * For `evaluate_code` only: load the artifact's open PR and return its head branch
 * for the harness. Other commands return `fallbackBranch` unchanged.
 */
export async function resolveEvaluateCodeBranchForRunLoop(
  command: keyof typeof COMMAND_MAP,
  artifactId: string,
  organizationId: string,
  fallbackBranch: string
): Promise<
  | { ok: true; branch: string }
  | { ok: false; response: ReturnType<typeof badRequestResponse> }
> {
  if (command !== RunLoopCommand.EvaluateCode) {
    return { ok: true, branch: fallbackBranch };
  }

  const pr = await artifactsService.getArtifactPullRequest(
    artifactId,
    organizationId
  );
  const evaluateBranch = resolveEvaluateCodeTargetBranch(pr);
  if (!evaluateBranch.ok) {
    return { ok: false, response: badRequestResponse(evaluateBranch.message) };
  }
  return { ok: true, branch: evaluateBranch.branch };
}

/**
 * Resolve workstream, repo, branch, context refs, and parent loop for a
 * run-loop request. Extracted to keep the route handler's complexity low.
 */
export async function resolveLoopContext(
  artifact: NonNullable<
    Awaited<ReturnType<typeof artifactsService.findWithRegenerationContext>>
  >,
  body: {
    repo?: { fullName?: string; branch?: string };
    command: keyof typeof COMMAND_MAP;
  },
  handler: ReturnType<typeof getCommandHandler>,
  organizationId: string,
  userId: string,
  artifactId: string
) {
  const { workstream: resolvedWorkstream, source } =
    await artifactsService.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

  const workstream = resolvedWorkstream ?? artifact.workstream;

  const projectSettings = getProjectSettings(
    (workstream?.project?.settings ?? {}) as JsonObject
  );

  const targetRepo =
    body.repo?.fullName ??
    artifact.targetRepo ??
    source?.targetRepo ??
    projectSettings.defaultRepository?.repoFullName;

  const targetBranch =
    body.repo?.branch ??
    artifact.targetBranch ??
    source?.targetBranch ??
    projectSettings.defaultRepository?.branch ??
    "main";

  const contextRefs: NonNullable<CreateLoopRequest["contextRefs"]> = [];
  if (source) {
    contextRefs.push({
      sourceId: source.id,
      sourceType: source.type,
      include: "full",
    });
  }

  let parentLoopId: string | undefined;
  let parentLoopComputeTargetId: string | null | undefined;
  if (handler?.requiresParent) {
    const parentLoop = await loopsService.findLatestCompletedForArtifact(
      artifactId,
      organizationId
    );
    parentLoopId = parentLoop?.id;
    parentLoopComputeTargetId = parentLoop
      ? (parentLoop.computeTargetId ?? null)
      : undefined;
  }

  return {
    workstream,
    targetRepo,
    targetBranch,
    contextRefs,
    parentLoopId,
    parentLoopComputeTargetId,
    source,
  };
}

export type ComputeTargetRouteResult =
  | { computeTargetId: string | undefined }
  | { errorResponse: NextResponse<ApiResult<never>> };

/**
 * Resolve the compute target for a run-loop request, returning either the
 * resolved target ID (possibly undefined for ECS fallback) or an error response.
 *
 * When no computeTargetIdHint is provided, reads user.preferredComputeMode
 * and passes it to resolveComputeTarget so CLOUD-preferring users bypass
 * local target resolution and get the cloud_resolved path immediately.
 */
export async function resolveComputeTargetForRoute(
  organizationId: string,
  userId: string,
  computeTargetIdHint?: string
): Promise<ComputeTargetRouteResult> {
  let preferredComputeMode: string | null | undefined;

  if (!computeTargetIdHint) {
    const user = await withDb((db) =>
      db.user.findUnique({
        where: { id: userId },
        select: { preferredComputeMode: true },
      })
    );
    preferredComputeMode = user?.preferredComputeMode ?? undefined;
  }

  const ctResult = await resolveComputeTarget(
    organizationId,
    userId,
    computeTargetIdHint,
    preferredComputeMode
  );

  const routeResult = mapComputeTargetResult(ctResult);
  log.info("[run-loop] Compute target resolution", {
    reason: ctResult.reason,
    resolvedTargetId:
      "computeTargetId" in routeResult
        ? (routeResult.computeTargetId ?? "cloud/ecs")
        : "error",
    hasError: "errorResponse" in routeResult,
  });

  return routeResult;
}

function mapComputeTargetResult(
  ctResult: ResolveComputeTargetResult
): ComputeTargetRouteResult {
  switch (ctResult.reason) {
    case "resolved":
      return { computeTargetId: ctResult.target.id };
    case "no_targets":
      return { computeTargetId: undefined };
    case "hint_not_found":
      return { errorResponse: notFoundResponse("Compute target") };
    case "hint_offline":
      return {
        errorResponse: badRequestResponse(
          "Compute target is offline. Ensure the desktop app is running."
        ),
      };
    case "no_online_targets":
      return {
        errorResponse: badRequestResponse(
          "No compute targets are online. Ensure the desktop app is running."
        ),
      };
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
      return {
        errorResponse: NextResponse.json(
          { success: false, error: conflictBody.message, data: conflictBody },
          { status: 409 }
        ),
      };
    }
    case "cloud_resolved":
      return { computeTargetId: undefined };
    default: {
      const _exhaustive: never = ctResult;
      return {
        errorResponse: errorResponse(
          "Unhandled compute target resolution result",
          _exhaustive
        ),
      };
    }
  }
}

/**
 * Check whether the resolved compute target differs from the backend used by
 * the artifact's last completed loop. Returns a 409 NextResponse when a
 * mismatch is detected, or null when the caller may proceed.
 *
 * Only applies to state-dependent commands (handler.requiresParent). Callers
 * that have confirmed the switch is intentional should pass backendOverride
 * so the check is skipped entirely.
 */
export async function checkBackendMismatch(
  artifactId: string,
  organizationId: string,
  resolvedComputeTargetId: string | undefined,
  latestCompletedLoopComputeTargetId?: string | null
): Promise<NextResponse<{
  success: false;
  error: string;
  data: BackendMismatchBody;
}> | null> {
  let previousTargetId: string | null;
  let hasPriorLoop: boolean;
  if (latestCompletedLoopComputeTargetId !== undefined) {
    // Caller already resolved the parent loop: null = cloud, string = local target
    previousTargetId = latestCompletedLoopComputeTargetId ?? null;
    hasPriorLoop = true;
  } else {
    // Fallback: query the DB for the latest completed loop
    const latestLoop = await loopsService.findLatestCompletedForArtifact(
      artifactId,
      organizationId
    );
    hasPriorLoop = latestLoop != null;
    previousTargetId = latestLoop?.computeTargetId ?? null;
  }

  // No prior loops at all — nothing to mismatch against
  if (!hasPriorLoop) {
    return null;
  }

  const currentTargetId = resolvedComputeTargetId ?? null;

  if (previousTargetId === currentTargetId) {
    return null;
  }

  let originalComputeTargetName: string | null = null;
  if (previousTargetId) {
    const previousTarget =
      await computeTargetsService.findById(previousTargetId);
    originalComputeTargetName = previousTarget?.machineName ?? null;
  }

  const mismatchBody: BackendMismatchBody = {
    error: "backend_mismatch",
    message:
      "The compute target has changed since the last completed loop. Pass backendOverride: true to proceed.",
    originalComputeTargetId: previousTargetId,
    originalComputeTargetName,
    preferredComputeTargetId: currentTargetId,
    artifactId,
  };
  return NextResponse.json(
    { success: false, error: mismatchBody.message, data: mismatchBody },
    { status: 409 }
  );
}
