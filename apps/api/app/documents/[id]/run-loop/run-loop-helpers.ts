import type { ApiResult, JsonObject } from "@repo/api/src/types/common";
import type { BackendMismatchBody } from "@repo/api/src/types/compute-target";
import {
  type PullRequestInfo,
  PullRequestState,
  pickPullRequestForRepo,
} from "@repo/api/src/types/document";
import {
  type AdditionalRepoRef,
  type CreateLoopRequest,
  LoopCommand,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { getProjectSettings } from "@repo/api/src/types/project";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { computeTargetsService } from "@/app/compute-targets/service";
import { documentPullRequestService } from "@/app/documents/document-pull-request-service";
import type { documentGenerationService } from "@/app/documents/generation-service";
import { documentWorkstreamService } from "@/app/documents/workstream-service";
import { loopsService } from "@/app/loops/service";
import {
  type ComputeTargetRouteResult,
  resolveComputeTargetForRoute,
} from "@/lib/loops/compute-target-route-helpers";
import type { getCommandHandler } from "@/lib/loops/loop-commands";
import { extractUploadedPlanRaw } from "@/lib/loops/uploaded-plan-artifacts";
import { badRequestResponse } from "@/lib/route-utils";

/**
 * Map route body commands (lowercase) to LoopCommand enum values (uppercase).
 */
export const COMMAND_MAP = {
  [RunLoopCommand.Plan]: LoopCommand.Plan,
  [RunLoopCommand.Execute]: LoopCommand.Execute,
  [RunLoopCommand.RequestChanges]: LoopCommand.RequestChanges,
  [RunLoopCommand.RequestPrdChanges]: LoopCommand.RequestPrdChanges,
  [RunLoopCommand.Decompose]: LoopCommand.Decompose,
  [RunLoopCommand.EvaluatePrd]: LoopCommand.EvaluatePrd,
  [RunLoopCommand.GeneratePrd]: LoopCommand.GeneratePrd,
  [RunLoopCommand.EvaluatePlan]: LoopCommand.EvaluatePlan,
  [RunLoopCommand.EvaluateCode]: LoopCommand.EvaluateCode,
  [RunLoopCommand.EvaluateFeature]: LoopCommand.EvaluateFeature,
} as const;

type ParentLoopForRunContext = Awaited<
  ReturnType<typeof loopsService.findLatestCompletedForArtifact>
>;

type ParentLoopSelection =
  | "not-required"
  | "state-bearing-desktop"
  | "latest-completed"
  | "none";

function logParentLoopResolution({
  command,
  documentId,
  parentLoop,
  parentSelection,
  resolvedComputeTargetId,
}: {
  command: keyof typeof COMMAND_MAP;
  documentId: string;
  parentLoop: ParentLoopForRunContext;
  parentSelection: ParentLoopSelection;
  resolvedComputeTargetId?: string;
}): void {
  if (parentSelection === "not-required") {
    return;
  }

  const parentLoopComputeTargetId = parentLoop
    ? (parentLoop.computeTargetId ?? null)
    : undefined;

  log.info("[run-loop] Parent loop resolved", {
    documentId,
    command,
    resolvedComputeTargetId: resolvedComputeTargetId ?? null,
    parentSelection,
    parentLoopId: parentLoop?.id ?? null,
    parentLoopStatus: parentLoop?.status ?? null,
    parentLoopComputeTargetId: parentLoopComputeTargetId ?? null,
    parentLoopHasUploadedArtifacts: Boolean(parentLoop?.uploadedArtifacts),
    parentLoopUploadedRawPlanPresent: parentLoop
      ? Boolean(extractUploadedPlanRaw(parentLoop.uploadedArtifacts))
      : false,
  });
}

async function resolveParentLoopForRunContext({
  command,
  documentId,
  handler,
  organizationId,
  resolvedComputeTargetId,
}: {
  command: keyof typeof COMMAND_MAP;
  documentId: string;
  handler: ReturnType<typeof getCommandHandler>;
  organizationId: string;
  resolvedComputeTargetId?: string;
}): Promise<{
  parentLoop: ParentLoopForRunContext;
  parentSelection: ParentLoopSelection;
}> {
  if (!handler?.requiresParent) {
    return { parentLoop: null, parentSelection: "not-required" };
  }

  const stateBearingDesktopParent = resolvedComputeTargetId
    ? await loopsService.findLatestStateBearingDesktopForArtifact(
        documentId,
        organizationId
      )
    : null;
  if (stateBearingDesktopParent) {
    logParentLoopResolution({
      command,
      documentId,
      parentLoop: stateBearingDesktopParent,
      parentSelection: "state-bearing-desktop",
      resolvedComputeTargetId,
    });
    return {
      parentLoop: stateBearingDesktopParent,
      parentSelection: "state-bearing-desktop",
    };
  }

  const fallbackParent = await loopsService.findLatestCompletedForArtifact(
    documentId,
    organizationId
  );
  const parentSelection = fallbackParent ? "latest-completed" : "none";
  logParentLoopResolution({
    command,
    documentId,
    parentLoop: fallbackParent,
    parentSelection,
    resolvedComputeTargetId,
  });
  return { parentLoop: fallbackParent, parentSelection };
}

/**
 * For EVALUATE_CODE loops: require an open PR produced by the document
 * and return its head branch for the harness clone target.
 */
export function resolveEvaluateCodeTargetBranch(
  pr: PullRequestInfo | null,
  repoFullName?: string | null
): { ok: true; branch: string } | { ok: false; message: string } {
  if (!pr || pr.state !== PullRequestState.Open) {
    return {
      ok: false,
      message:
        "No open pull request found. Execute the plan first to create a PR.",
    };
  }
  if (repoFullName && pr.repoFullName !== repoFullName) {
    return {
      ok: false,
      message: `No open pull request found for repository ${repoFullName}.`,
    };
  }
  if (!pr.headBranch) {
    return { ok: false, message: "Pull request has no head branch." };
  }
  return { ok: true, branch: pr.headBranch };
}

/**
 * For `evaluate_code` only: load the artifact's open PR and return its head branch
 * for the harness. Other commands return `fallbackBranch` unchanged.
 */
export async function resolveEvaluateCodeBranchForRunLoop(
  command: keyof typeof COMMAND_MAP,
  documentId: string,
  organizationId: string,
  repoFullName: string | null | undefined,
  fallbackBranch: string
): Promise<
  | { ok: true; branch: string }
  | { ok: false; response: ReturnType<typeof badRequestResponse> }
> {
  if (command !== RunLoopCommand.EvaluateCode) {
    return { ok: true, branch: fallbackBranch };
  }

  const pullRequests = await documentPullRequestService.getDocumentPullRequests(
    documentId,
    organizationId
  );
  const pr = pickPullRequestForRepo(pullRequests, repoFullName);
  const evaluateBranch = resolveEvaluateCodeTargetBranch(pr, repoFullName);
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
    Awaited<
      ReturnType<typeof documentGenerationService.findWithRegenerationContext>
    >
  >,
  body: {
    repo?: { fullName?: string; branch?: string };
    command: keyof typeof COMMAND_MAP;
    additionalRepos?: AdditionalRepoRef[];
  },
  handler: ReturnType<typeof getCommandHandler>,
  organizationId: string,
  userId: string,
  documentId: string,
  resolvedComputeTargetId?: string
) {
  const { workstream: resolvedWorkstream, source } =
    await documentWorkstreamService.findOrCreateWorkstream(
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

  const { parentLoop } = await resolveParentLoopForRunContext({
    command: body.command,
    documentId,
    handler,
    organizationId,
    resolvedComputeTargetId,
  });
  const parentLoopId = parentLoop?.id;
  const parentLoopComputeTargetId = parentLoop
    ? (parentLoop.computeTargetId ?? null)
    : undefined;

  // For state-dependent commands (EXECUTE, REQUEST_CHANGES, etc.), inherit
  // peer repos from the parent loop when the body omits them. Without this,
  // a chained EXECUTE that doesn't re-supply additionalRepos would lose the
  // peer set the PLAN was authored against, leaving the harness with only
  // primary-repo access despite the orchestrator having cloned peers.
  const inheritedAdditionalRepos =
    handler?.requiresParent &&
    !body.additionalRepos &&
    parentLoop?.additionalRepos?.length
      ? parentLoop.additionalRepos.map((repo) => ({
          fullName: repo.fullName,
          branch: repo.branch,
        }))
      : undefined;
  const additionalRepos = body.additionalRepos ?? inheritedAdditionalRepos;

  return {
    workstream,
    targetRepo,
    targetBranch,
    contextRefs,
    parentLoopId,
    parentLoopComputeTargetId,
    source,
    additionalRepos,
  };
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
  documentId: string,
  organizationId: string,
  resolvedComputeTargetId: string | undefined,
  latestCompletedLoopComputeTargetId?: string | null
): Promise<NextResponse<ApiResult<never>> | null> {
  let previousTargetId: string | null;
  let hasPriorLoop: boolean;
  if (latestCompletedLoopComputeTargetId === undefined) {
    // Fallback: query the DB for the latest completed loop
    const latestLoop = await loopsService.findLatestCompletedForArtifact(
      documentId,
      organizationId
    );
    hasPriorLoop = latestLoop != null;
    previousTargetId = latestLoop?.computeTargetId ?? null;
  } else {
    // Caller already resolved the parent loop: null = cloud, string = local target
    previousTargetId = latestCompletedLoopComputeTargetId ?? null;
    hasPriorLoop = true;
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
    documentId,
  };
  // The 409 body extends ApiResult with an extra `data` field (consumed by
  // the frontend via ApiError.data.data). Cast to satisfy the return type.
  return NextResponse.json(
    { success: false, error: mismatchBody.message, data: mismatchBody },
    { status: 409 }
  ) as NextResponse<ApiResult<never>>;
}

/**
 * Resolve the compute target ID for a run-loop request.
 *
 * When the caller explicitly passes null (cloud override confirmed), returns
 * `{ computeTargetId: undefined }` immediately without querying the DB.
 * Otherwise delegates to `resolveComputeTargetForRoute` which handles user
 * preferences and target availability checks.
 */
export function resolveRunLoopComputeTarget(
  organizationId: string,
  userId: string,
  computeTargetIdHint: string | null | undefined
): Promise<ComputeTargetRouteResult> {
  if (computeTargetIdHint === null) {
    return Promise.resolve({ computeTargetId: undefined });
  }
  return resolveComputeTargetForRoute(
    organizationId,
    userId,
    computeTargetIdHint
  );
}
