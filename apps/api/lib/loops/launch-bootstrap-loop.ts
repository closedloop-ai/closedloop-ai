/**
 * Shared helper for launching a BOOTSTRAP loop.
 *
 * Unlike plan loops, bootstrap has no document, workstream, context refs,
 * or prompt. The repo list and options go in Loop metadata.
 */

import type { JsonObject } from "@repo/api/src/types/common";
import { LoopCommand } from "@repo/api/src/types/loop";
import { ConcurrentLoopLimitError } from "@/app/loops/loop-errors";
import { loopsService } from "@/app/loops/service";
import type { ComputeTargetError } from "./compute-target-resolver";
import { resolveComputeTargetWithPreferences } from "./compute-target-resolver";
import type { DispatchErrorCode } from "./loop-dispatch-utils";
import { dispatchAndClassify } from "./loop-dispatch-utils";

export type LaunchBootstrapLoopResult =
  | { ok: true; loopId: string; status: string }
  | {
      ok: false;
      error:
        | ComputeTargetError
        | DispatchErrorCode
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

  const ctResult = await resolveComputeTargetWithPreferences(
    organizationId,
    userId,
    computeTargetId ?? undefined
  );
  if (!ctResult.ok) {
    return ctResult;
  }

  const metadata: JsonObject = {
    repos,
    launchSource: "bootstrap",
  };
  if (options) {
    metadata.options = options;
  }

  let loopId: string;
  let status: string;
  try {
    const loopResponse = await loopsService.create(organizationId, userId, {
      command: LoopCommand.Bootstrap,
      computeTargetId: ctResult.computeTargetId,
      metadata,
    });
    loopId = loopResponse.loopId;
    status = loopResponse.status;
  } catch (error) {
    if (error instanceof ConcurrentLoopLimitError) {
      return { ok: false, error: "concurrent_limit_exceeded" };
    }
    throw error;
  }

  const dispatchResult = await dispatchAndClassify(
    loopId,
    organizationId,
    "launch-bootstrap-loop"
  );
  if (!dispatchResult.ok) {
    return dispatchResult;
  }

  return { ok: true, loopId, status };
}
