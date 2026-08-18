/**
 * How a terminal loop job names its own failure.
 *
 * Extracted from `loop-finalizer.ts` (ISS-5872) so that file keeps the
 * finalization SEQUENCE and this module owns the vocabulary: given a job that
 * did not succeed, which error code and message does the cloud get. Keeping it
 * separate matters because the precedence here is load-bearing — a trusted
 * runner marker wins, then a 0-token ghost EXECUTE, then a missing deliverable,
 * then the generic process outcome — and that ordering is easier to protect
 * when it is not buried between two HTTP calls.
 */

import { missingRequiredArtifactsMessage } from "@closedloop-ai/loops-api/bundles";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopErrorCode } from "@closedloop-ai/loops-api/error-codes";
import type { LocalJob } from "../jobs/job-store.js";
import type { UserVisibleLoopFailurePayload } from "./user-visible-loop-failure.js";

export const EXECUTE_NO_WORK_MESSAGE =
  "EXECUTE loop completed with 0 tokens -- no work was done";
export const EXECUTE_NO_WORK_LIVE_ACTIVITY =
  "Error: Loop produced no output (0 tokens)";

function isExecuteNoWorkFailure(
  job: Pick<LocalJob, "command" | "status" | "liveActivity">
): boolean {
  return (
    String(job.command) === LoopCommand.Execute &&
    job.status === "FAILED" &&
    job.liveActivity === EXECUTE_NO_WORK_LIVE_ACTIVITY
  );
}

export function resolveJobFailureReason(
  job: LocalJob,
  userVisibleFailure: UserVisibleLoopFailurePayload | null
): { code: string; message: string } {
  if (userVisibleFailure) {
    return {
      code: userVisibleFailure.code,
      message: userVisibleFailure.message,
    };
  }
  if (isExecuteNoWorkFailure(job)) {
    return {
      code: LoopErrorCode.NoWorkProduced,
      message: EXECUTE_NO_WORK_MESSAGE,
    };
  }
  const missingArtifacts = job.missingRequiredArtifacts;
  if (missingArtifacts && missingArtifacts.length > 0) {
    return {
      code: LoopErrorCode.MissingRequiredArtifacts,
      message: missingRequiredArtifactsMessage(
        String(job.command),
        missingArtifacts
      ),
    };
  }
  if (job.status === "FAILED") {
    return {
      code: LoopErrorCode.ProcessFailed,
      message: `Process exited with code ${job.exitCode ?? 1}`,
    };
  }
  return {
    code: LoopErrorCode.ProcessStopped,
    message: `Process ended with terminal status ${job.status}`,
  };
}
