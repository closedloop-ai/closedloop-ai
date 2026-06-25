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
  AuthChallenge: "AUTH_CHALLENGE",
  BinaryNotFound: "BINARY_NOT_FOUND",
  ScriptNotFound: "SCRIPT_NOT_FOUND",
  SpawnFailed: "SPAWN_FAILED",

  // Lifecycle codes (set by harness/gateway at run completion)
  TimedOut: "TIMED_OUT",
  Cancelled: "CANCELLED",

  // Desktop-specific codes
  RepoNotAllowed: "REPO_NOT_ALLOWED",
  RepoNotFound: "REPO_NOT_FOUND",

  // Backend semantic errors
  NoWorkProduced: "NO_WORK_PRODUCED",
  ContextLimitExceeded: "CONTEXT_LIMIT_EXCEEDED",
  PlanStateUnavailable: "PLAN_STATE_UNAVAILABLE",
  StaleDispatch: "STALE_DISPATCH",
  RepoNotInProjectPool: "REPO_NOT_IN_PROJECT_POOL",
} as const;
export type LoopErrorCode = (typeof LoopErrorCode)[keyof typeof LoopErrorCode];

export const LoopErrorCodeSchema = z.enum(LoopErrorCode);

/**
 * Structured `error.result.subcode` values for `RUNNER_ERROR` loop failures.
 *
 * Desktop and hosted runners preserve these subcodes in loop error results so
 * API and app surfaces can explain runner failures without parsing messages.
 */
export const RunnerErrorSubcode = {
  BadPlanState: "BAD_PLAN_STATE",
  ClaudeAuthChallenge: "CLAUDE_AUTH_CHALLENGE",
  ClaudeContextLimit: "CLAUDE_CONTEXT_LIMIT",
  ClaudeUnknownSkill: "CLAUDE_UNKNOWN_SKILL",
  ClaudeRateLimit: "CLAUDE_RATE_LIMIT",
  PendingTasksAtCompletion: "PENDING_TASKS_AT_COMPLETION",
  PendingTasksBlockedByQuestions: "PENDING_TASKS_BLOCKED_BY_QUESTIONS",
} as const;
export type RunnerErrorSubcode =
  (typeof RunnerErrorSubcode)[keyof typeof RunnerErrorSubcode];

export const RunnerErrorSubcodeSchema = z.enum(RunnerErrorSubcode);
