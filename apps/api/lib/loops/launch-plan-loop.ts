/**
 * Shared helper for launching a PLAN loop.
 *
 * Used by both the existing POST /artifacts/:id/run-loop route and
 * the new POST /plans/start-loop-from-local route so that Start Planning
 * and Generate Plan share the same loop creation and dispatch logic.
 */

import type { JsonObject } from "@repo/api/src/types/common";
import type { CreateLoopResponse } from "@repo/api/src/types/loop";
import {
  COMMAND_MAP,
  resolveLoopContext,
} from "@/app/documents/[id]/run-loop/run-loop-helpers";
import type { StartPlanLoopFromLocalResult } from "@/app/documents/document-utils";
import { loopsService } from "@/app/loops/service";
import type { ComputeTargetError } from "./compute-target-resolver";
import { resolveComputeTargetWithPreferences } from "./compute-target-resolver";
import type { DispatchError } from "./loop-dispatch-utils";
import { dispatchAndClassify } from "./loop-dispatch-utils";
import { getDefaultPrompt } from "./prompts";

export type LaunchPlanLoopResult =
  | { ok: true; loopResponse: CreateLoopResponse }
  | {
      ok: false;
      error: ComputeTargetError | DispatchError;
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

  const ctResult = await resolveComputeTargetWithPreferences(
    organizationId,
    userId,
    computeTargetId ?? undefined
  );
  if (!ctResult.ok) {
    return ctResult;
  }

  const { workstream, targetRepo, targetBranch, contextRefs } =
    await resolveLoopContext(
      artifact,
      { repo: repoOverride, command: "plan" },
      undefined,
      organizationId,
      userId,
      documentId,
      ctResult.computeTargetId
    );

  const command = COMMAND_MAP.plan;
  const prompt = getDefaultPrompt(command);

  const loopResponse = await loopsService.create(organizationId, userId, {
    command,
    documentId,
    workstreamId: workstream?.id,
    computeTargetId: ctResult.computeTargetId,
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
  const dispatchResult = await dispatchAndClassify(
    loopResponse.loopId,
    organizationId,
    "launch-plan-loop",
    { documentId }
  );
  if (!dispatchResult.ok) {
    return dispatchResult;
  }

  return { ok: true, loopResponse };
}
