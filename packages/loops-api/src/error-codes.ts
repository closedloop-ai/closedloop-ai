import { z } from "zod";

/**
 * Unified error codes across all loop execution environments.
 *
 * ECS harness, Electron gateway, and backend each defined their own
 * non-overlapping sets. This const merges all three into one source of truth.
 */
export const LoopErrorCode = {
  // Harness lifecycle errors (ECS runner)
  RunnerError: "RUNNER_ERROR",
  ConfigValidationFailed: "CONFIG_VALIDATION_FAILED",
  SecretsValidationFailed: "SECRETS_VALIDATION_FAILED",
  ContextPackDownloadFailed: "CONTEXT_PACK_DOWNLOAD_FAILED",
  ContextPackInvalid: "CONTEXT_PACK_INVALID",
  ContextPackWriteFailed: "CONTEXT_PACK_WRITE_FAILED",
  GitCloneFailed: "GIT_CLONE_FAILED",
  BranchCreateFailed: "BRANCH_CREATE_FAILED",
  PreRunValidationFailed: "PRE_RUN_VALIDATION_FAILED",
  RunLoopNotFound: "RUN_LOOP_NOT_FOUND",

  // Desktop gateway errors (Electron)
  ArtifactWriteFailed: "ARTIFACT_WRITE_FAILED",
  ProcessFailed: "PROCESS_FAILED",
  ProcessStopped: "PROCESS_STOPPED",

  // Backend semantic errors
  NoWorkProduced: "NO_WORK_PRODUCED",
  ContextLimitExceeded: "CONTEXT_LIMIT_EXCEEDED",
  PlanStateUnavailable: "PLAN_STATE_UNAVAILABLE",
} as const;
export type LoopErrorCode = (typeof LoopErrorCode)[keyof typeof LoopErrorCode];

export const LoopErrorCodeSchema = z.enum(LoopErrorCode);
