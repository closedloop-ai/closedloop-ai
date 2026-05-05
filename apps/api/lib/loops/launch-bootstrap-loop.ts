/**
 * Shared helper for launching a BOOTSTRAP loop.
 *
 * Unlike plan loops, bootstrap has no document, workstream, context refs,
 * or prompt. The repo list and options go in Loop metadata.
 */

import type { JsonObject } from "@repo/api/src/types/common";
import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import { log } from "@repo/observability/log";
import { ConcurrentLoopLimitError, loopsService } from "@/app/loops/service";
import {
  fetchUserComputePreferences,
  resolveComputeTarget,
} from "./compute-target-resolver";
import { isDispatchError } from "./loop-desktop";
import { classifyLaunchFailure } from "./loop-dispatch-utils";
import { launchLoop } from "./loop-orchestrator";

export type LaunchBootstrapLoopResult =
  | { ok: true; loopId: string; status: string }
  | {
      ok: false;
      error:
        | "compute_target_not_found"
        | "compute_target_offline"
        | "no_online_targets"
        | "multiple_targets"
        | "callback_unavailable"
        | "launch_failed"
        | "concurrent_limit_exceeded";
    };

export type LaunchBootstrapLoopOptions = {
  organizationId: string;
  userId: string;
  repos: Array<{ fullName: string }>;
  options?: { depth?: string };
  computeTargetId?: string;
};

/**
 * Resolve compute target, create a BOOTSTRAP loop record, and dispatch it
 * via launchLoop(). Returns a result object so callers can convert failures
 * to appropriate HTTP responses without catching exceptions.
 */
export async function launchBootstrapLoop(
  opts: LaunchBootstrapLoopOptions
): Promise<LaunchBootstrapLoopResult> {
  const { organizationId, userId, repos, options, computeTargetId } = opts;

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

  const metadata: JsonObject = {
    repos,
    launchSource: "bootstrap",
  };
  if (options) {
    metadata.options = options;
  }

  let loopResponse: CreateLoopResponse;
  try {
    loopResponse = await loopsService.create(organizationId, userId, {
      command: LoopCommand.Bootstrap,
      computeTargetId: resolvedComputeTargetId,
      metadata,
    });
  } catch (error) {
    if (error instanceof ConcurrentLoopLimitError) {
      return { ok: false, error: "concurrent_limit_exceeded" };
    }
    throw error;
  }

  try {
    await launchLoop(loopResponse.loopId, organizationId);
  } catch (error) {
    const launchError = classifyLaunchFailure(error);
    log.error("[launch-bootstrap-loop] Failed to launch loop", {
      loopId: loopResponse.loopId,
      error: error instanceof Error ? error.message : String(error),
      dispatchReason:
        isDispatchError(error) && error.dispatchReason
          ? error.dispatchReason
          : undefined,
      launchError,
    });
    return { ok: false, error: launchError };
  }

  return { ok: true, loopId: loopResponse.loopId, status: loopResponse.status };
}
