import {
  type PullRequestInfo,
  PullRequestState,
} from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import type { BackendMismatchBody } from "@repo/api/src/types/compute-target";
import {
  type AdditionalRepoRef,
  type CreateLoopRequest,
  LoopCommand,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { getProjectSettings } from "@repo/api/src/types/project";
import { NextResponse } from "next/server";
import { computeTargetsService } from "@/app/compute-targets/service";
import { loopsService } from "@/app/loops/service";
import {
  type ComputeTargetRouteResult,
  resolveComputeTargetForRoute,
} from "@/lib/loops/compute-target-route-helpers";
import type { getCommandHandler } from "@/lib/loops/loop-commands";
import { badRequestResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

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

/**
 * Deduplicate additional repo refs by fullName, exclude the primary repo,
 * and return undefined when the result is empty.
 */
export function normalizeAdditionalRepos(
  entries: AdditionalRepoRef[],
  primaryFullName: string | undefined
): AdditionalRepoRef[] | undefined {
  const seen = new Set<string>();
  const result: AdditionalRepoRef[] = [];
  for (const entry of entries) {
    if (entry.fullName === primaryFullName) {
      continue;
    }
    if (seen.has(entry.fullName)) {
      continue;
    }
    seen.add(entry.fullName);
    result.push({ fullName: entry.fullName, branch: entry.branch });
  }
  return result.length > 0 ? result : undefined;
}
