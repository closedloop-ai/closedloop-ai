import { z } from "zod";

// Loop Status
export const LoopStatus = {
  Pending: "PENDING",
  Claimed: "CLAIMED",
  Running: "RUNNING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Cancelled: "CANCELLED",
  TimedOut: "TIMED_OUT",
} as const;
export type LoopStatus = (typeof LoopStatus)[keyof typeof LoopStatus];

export const LoopStatusSchema = z.enum(LoopStatus);

// Loop Command — all 11 commands across backend, ECS, and Electron
export const LoopCommand = {
  Plan: "PLAN",
  Execute: "EXECUTE",
  Chat: "CHAT",
  Explore: "EXPLORE",
  RequestChanges: "REQUEST_CHANGES",
  RequestPrdChanges: "REQUEST_PRD_CHANGES",
  Decompose: "DECOMPOSE",
  EvaluatePrd: "EVALUATE_PRD",
  GeneratePrd: "GENERATE_PRD",
  EvaluatePlan: "EVALUATE_PLAN",
  EvaluateCode: "EVALUATE_CODE",
} as const;
export type LoopCommand = (typeof LoopCommand)[keyof typeof LoopCommand];

export const LoopCommandSchema = z.enum(LoopCommand);

// Lowercase command keys accepted by the /artifacts/:id/run-loop endpoint.
export const RunLoopCommand = {
  Plan: "plan",
  Execute: "execute",
  RequestChanges: "request_changes",
  RequestPrdChanges: "request_prd_changes",
  Decompose: "decompose",
  EvaluatePrd: "evaluate_prd",
  GeneratePrd: "generate_prd",
  EvaluatePlan: "evaluate_plan",
  EvaluateCode: "evaluate_code",
} as const;
export type RunLoopCommand =
  (typeof RunLoopCommand)[keyof typeof RunLoopCommand];

export const RunLoopCommandSchema = z.enum(RunLoopCommand);

// --- Command input requirements ---

/**
 * Declares what inputs each command requires in the context pack.
 *
 * Both ECS harness and Electron gateway use this to validate inputs before
 * spawning the loop agent, replacing parallel if-chains with a shared
 * source of truth.
 *
 * `repo` is validated separately by each harness since it depends on
 * environment config (ECS uses TARGET_REPO env var, Electron uses
 * localRepoPath or repo.fullName from the request body).
 */
export type CommandInputSpec = {
  /** Whether the command requires a prompt in the context pack */
  prompt: "required" | "optional";
  /** Whether the command requires artifacts in the context pack */
  artifacts: "required" | "optional";
  /** Whether the command requires a target repository */
  repo: "required" | "optional" | "not_required";
  /**
   * When true, at least one of prompt or artifacts must be present
   * (even if both are individually optional).
   */
  requiresPromptOrArtifacts?: boolean;
};

export const CommandInputRequirements: Record<LoopCommand, CommandInputSpec> = {
  [LoopCommand.Plan]: {
    prompt: "optional",
    artifacts: "optional",
    repo: "required",
  },
  [LoopCommand.Execute]: {
    prompt: "optional",
    artifacts: "optional",
    repo: "required",
    requiresPromptOrArtifacts: true,
  },
  [LoopCommand.Chat]: {
    prompt: "required",
    artifacts: "optional",
    repo: "not_required",
  },
  [LoopCommand.Explore]: {
    prompt: "required",
    artifacts: "optional",
    repo: "not_required",
  },
  [LoopCommand.RequestChanges]: {
    prompt: "required",
    artifacts: "optional",
    repo: "required",
  },
  [LoopCommand.RequestPrdChanges]: {
    prompt: "required",
    artifacts: "required",
    repo: "required",
  },
  [LoopCommand.Decompose]: {
    prompt: "optional",
    artifacts: "required",
    repo: "not_required",
  },
  [LoopCommand.GeneratePrd]: {
    prompt: "required",
    artifacts: "optional",
    repo: "required",
  },
  [LoopCommand.EvaluatePrd]: {
    prompt: "optional",
    artifacts: "required",
    repo: "optional",
  },
  [LoopCommand.EvaluatePlan]: {
    prompt: "optional",
    artifacts: "required",
    repo: "required",
  },
  [LoopCommand.EvaluateCode]: {
    prompt: "optional",
    artifacts: "required",
    repo: "required",
  },
};

/**
 * Validate context pack inputs against the command's requirements.
 *
 * Returns an error message string if validation fails, or null if valid.
 * Does NOT validate repo requirements — those depend on environment config
 * and are checked separately by each harness.
 */
export function validateCommandInputs(
  command: string,
  hasPrompt: boolean,
  hasArtifacts: boolean
): string | null {
  const spec = CommandInputRequirements[command as LoopCommand];
  if (!spec) {
    return null;
  }

  if (spec.prompt === "required" && !hasPrompt) {
    return `${command} requires a non-empty prompt`;
  }

  if (spec.artifacts === "required" && !hasArtifacts) {
    return `${command} requires artifacts in the context pack`;
  }

  if (spec.requiresPromptOrArtifacts && !hasPrompt && !hasArtifacts) {
    return `${command} requires either a prompt or artifacts in the context pack`;
  }

  return null;
}
