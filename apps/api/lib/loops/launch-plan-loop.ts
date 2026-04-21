/**
 * Shared helper for launching a PLAN loop.
 *
 * Used by both the existing POST /artifacts/:id/run-loop route and
 * the new POST /plans/start-loop-from-local route so that Start Planning
 * and Generate Plan share the same loop creation and dispatch logic.
 */

import type { JsonObject } from "@repo/api/src/types/common";
import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import {
  COMMAND_MAP,
  resolveLoopContext,
} from "@/app/documents/[id]/run-loop/run-loop-helpers";
import type { StartPlanLoopFromLocalResult } from "@/app/documents/service";
import { loopsService } from "@/app/loops/service";
import {
  fetchUserComputePreferences,
  resolveComputeTarget,
} from "./compute-target-resolver";
import { isDispatchError } from "./loop-desktop";
import { launchLoop } from "./loop-orchestrator";
import { getDefaultPrompt } from "./prompts";

export type LaunchPlanLoopResult =
  | { ok: true; loopResponse: CreateLoopResponse }
  | {
      ok: false;
      error:
        | "compute_target_not_found"
        | "compute_target_offline"
        | "no_online_targets"
        | "multiple_targets"
        | "callback_unavailable"
        | "launch_failed";
    };

type ArtifactWithRegenerationContext = Extract<
  StartPlanLoopFromLocalResult,
  { outcome: "ready-to-launch" }
>["document"];

export type LaunchPlanLoopOptions = {
  artifact: ArtifactWithRegenerationContext;
  organizationId: string;
  userId: string;
  documentId: string;
  computeTargetId?: string;
  repoOverride?: { fullName: string; branch: string };
  metadata?: JsonObject;
};

const CALLBACK_UNAVAILABLE_DISPATCH_REASONS = new Set([
  "callback_unavailable",
  "callback_unreachable",
  "cloud_callback_unavailable",
  "cloud_callback_unreachable",
]);

function isCallbackUnavailableDispatchReason(
  reason: string | undefined
): boolean {
  if (!reason || typeof reason !== "string") {
    return false;
  }
  const normalizedReason = reason.trim().toLowerCase();
  if (CALLBACK_UNAVAILABLE_DISPATCH_REASONS.has(normalizedReason)) {
    return true;
  }
  return (
    normalizedReason.includes("callback") &&
    (normalizedReason.includes("unavailable") ||
      normalizedReason.includes("unreachable") ||
      normalizedReason.includes("not_reachable") ||
      normalizedReason.includes("not reachable"))
  );
}

function classifyLaunchFailure(
  error: unknown
): "callback_unavailable" | "launch_failed" {
  // Backward compatibility: older desktop/relay versions may not provide a
  // structured dispatchReason. In that case, degrade to generic launch_failed
  // instead of requiring a matched desktop rollout.
  if (
    isDispatchError(error) &&
    isCallbackUnavailableDispatchReason(error.dispatchReason)
  ) {
    return "callback_unavailable";
  }
  return "launch_failed";
}

/**
 * Resolve compute target, resolve loop context, create a PLAN loop record,
 * and dispatch it via launchLoop(). Returns a result object so callers can
 * convert failures to appropriate HTTP responses without catching exceptions.
 *
 * The launchLoop() call is awaited directly so the caller knows whether
 * the relay dispatch succeeded before reporting success to the browser.
 */
export async function launchPlanLoop(
  opts: LaunchPlanLoopOptions
): Promise<LaunchPlanLoopResult> {
  const {
    artifact,
    organizationId,
    userId,
    documentId,
    computeTargetId,
    repoOverride,
    metadata,
  } = opts;

  let preferredComputeMode: string | undefined;
  let preferredComputeTargetId: string | undefined;

  if (!computeTargetId) {
    const prefs = await fetchUserComputePreferences(userId);
    preferredComputeMode = prefs.preferredComputeMode;
    preferredComputeTargetId = prefs.preferredComputeTargetId;
  }

  const ctResult = await resolveComputeTarget(
    organizationId,
    userId,
    computeTargetId ?? undefined,
    preferredComputeMode,
    undefined,
    preferredComputeTargetId
  );

  let resolvedComputeTargetId: string | undefined;

  if (ctResult.reason === "resolved") {
    resolvedComputeTargetId = ctResult.target.id;
  } else if (ctResult.reason === "cloud_resolved") {
    resolvedComputeTargetId = undefined;
  } else if (ctResult.reason === "no_online_targets") {
    return { ok: false, error: "no_online_targets" };
  } else if (ctResult.reason === "multiple_targets") {
    return { ok: false, error: "multiple_targets" };
  } else if (
    ctResult.reason === "hint_not_found" ||
    ctResult.reason === "no_targets"
  ) {
    return { ok: false, error: "compute_target_not_found" };
  } else {
    // hint_offline
    return { ok: false, error: "compute_target_offline" };
  }

  const { workstream, targetRepo, targetBranch, contextRefs } =
    await resolveLoopContext(
      artifact,
      { repo: repoOverride, command: "plan" },
      undefined,
      organizationId,
      userId,
      documentId
    );

  const command = COMMAND_MAP.plan;
  const prompt = getDefaultPrompt(command);

  const loopResponse = await loopsService.create(organizationId, userId, {
    command,
    documentId,
    workstreamId: workstream?.id,
    computeTargetId: resolvedComputeTargetId,
    prompt,
    repo: targetRepo
      ? { fullName: targetRepo, branch: targetBranch }
      : undefined,
    contextRefs: contextRefs.length > 0 ? contextRefs : undefined,
    metadata,
  });

  // Await the dispatch instead of fire-and-forget. The browser is waiting
  // for this response, and reporting "launched" before knowing the relay
  // delivered the command causes false-success when the desktop is offline.
  // Desktop context-pack building + relay dispatch is typically <5 seconds.
  try {
    await launchLoop(loopResponse.loopId, organizationId);
  } catch (error) {
    const launchError = classifyLaunchFailure(error);
    log.error("[launch-plan-loop] Failed to launch loop", {
      loopId: loopResponse.loopId,
      documentId,
      error: error instanceof Error ? error.message : String(error),
      dispatchReason:
        isDispatchError(error) && error.dispatchReason
          ? error.dispatchReason
          : undefined,
      launchError,
    });
    return { ok: false, error: launchError };
  }

  return { ok: true, loopResponse };
}
