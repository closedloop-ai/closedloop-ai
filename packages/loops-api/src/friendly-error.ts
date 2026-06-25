import type { JsonObject, JsonValue } from "./common";
import { LoopErrorCode, LoopErrorCodeSchema } from "./error-codes";

export type FriendlyErrorDetails = {
  title: string;
  description: string;
  remediation: string[];
};

export type FriendlyErrorInput = {
  code?: string | null;
  message?: string | null;
  details?: JsonObject | null;
  result?: JsonObject | null;
  timestamp?: string | null;
};

export type FriendlyErrorOutput = FriendlyErrorDetails & {
  code?: string;
  timestamp?: string;
  technicalDetails: JsonObject;
};

type FriendlyErrorTemplate = FriendlyErrorDetails;

type TemplateVariables = {
  action?: string;
  binaryName?: string;
  branch?: string;
  exitCode?: string;
  repoFullName?: string;
  repoPath?: string;
};

/**
 * Exact desktop fail-fast message that should receive first-class visible loop
 * error copy instead of being hidden only in technical details.
 */
export const DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE =
  "Signed loop launch requires a desktop-managed key with request signing; the active config uses a manually configured key or cannot load its signing key. Re-run managed onboarding." as const;

const GitGatewayErrorCategory = {
  ComputeTargetOffline: "compute_target_offline",
  ComputeTargetUnavailable: "compute_target_unavailable",
  GitCommandFailed: "git_command_failed",
  GitPushAuth: "git_push_auth",
  PreCommitHook: "pre_commit_hook",
  RepoNotAllowed: "repo_not_allowed",
  RepoNotFound: "repo_not_found",
  SpawnFailed: "spawn_failed",
} as const;

type GitGatewayErrorCategory =
  (typeof GitGatewayErrorCategory)[keyof typeof GitGatewayErrorCategory];

const GitHookType = {
  Format: "format",
  Lint: "lint",
  Test: "test",
  Typecheck: "typecheck",
  Unknown: "unknown",
} as const;

type GitHookType = (typeof GitHookType)[keyof typeof GitHookType];

const ExternalRunnerErrorSubcode = {
  MaxIterationsNoProgress: "MAX_ITERATIONS_NO_PROGRESS",
} as const;

const RunnerErrorSubcode = {
  BadPlanState: "BAD_PLAN_STATE",
  ClaudeAuthChallenge: "CLAUDE_AUTH_CHALLENGE",
  ClaudeContextLimit: "CLAUDE_CONTEXT_LIMIT",
  ClaudeUnknownSkill: "CLAUDE_UNKNOWN_SKILL",
  ClaudeRateLimit: "CLAUDE_RATE_LIMIT",
  PendingTasksAtCompletion: "PENDING_TASKS_AT_COMPLETION",
  PendingTasksBlockedByQuestions: "PENDING_TASKS_BLOCKED_BY_QUESTIONS",
  ...ExternalRunnerErrorSubcode,
} as const;

type RunnerErrorSubcode =
  (typeof RunnerErrorSubcode)[keyof typeof RunnerErrorSubcode];

const loopErrorMessages = {
  [LoopErrorCode.RunnerError]: {
    title: "Runner failed",
    description: "The local runner stopped before it could finish the loop.",
    remediation: [
      "Open the technical details to inspect the runner output.",
      "Fix the reported runner issue, then restart the loop.",
    ],
  },
  [LoopErrorCode.ConfigValidationFailed]: {
    title: "Runner configuration is invalid",
    description:
      "The loop runner rejected its configuration before starting work.",
    remediation: [
      "Check the configured model, command, and repository settings.",
      "Restart the loop after correcting the configuration.",
    ],
  },
  [LoopErrorCode.SecretsValidationFailed]: {
    title: "Required credentials are unavailable",
    description:
      "The runner could not validate the credentials required for this loop.",
    remediation: [
      "Reconnect or refresh the required integration credentials.",
      "Restart the loop after credentials are available.",
    ],
  },
  [LoopErrorCode.ContextPackDownloadFailed]: {
    title: "Context pack download failed",
    description:
      "The runner could not download the context bundle needed to start.",
    remediation: [
      "Check network connectivity and retry the loop.",
      "If the issue persists, regenerate the context and start a new loop.",
    ],
  },
  [LoopErrorCode.ContextPackInvalid]: {
    title: "Context pack is invalid",
    description:
      "The downloaded context bundle could not be read by the runner.",
    remediation: [
      "Regenerate the loop context.",
      "Restart the loop with a fresh context bundle.",
    ],
  },
  [LoopErrorCode.ContextPackWriteFailed]: {
    title: "Context pack could not be written",
    description:
      "The runner could not write the context bundle into the work directory.",
    remediation: [
      "Check disk space and file permissions for the work directory.",
      "Restart the loop after the directory is writable.",
    ],
  },
  [LoopErrorCode.GitCloneFailed]: {
    title: "Repository clone failed",
    description:
      "The runner could not clone the repository before starting the loop.",
    remediation: [
      "Confirm repository access and branch availability.",
      "Retry after the repository can be cloned from this environment.",
    ],
  },
  [LoopErrorCode.BranchCreateFailed]: {
    title: "Branch could not be created",
    description: "The runner could not create or switch to the working branch.",
    remediation: [
      "Check for conflicting local branch names or repository permissions.",
      "Retry after the branch can be created.",
    ],
  },
  [LoopErrorCode.PreRunValidationFailed]: {
    title: "Pre-run validation failed",
    description:
      "The loop did not start because required pre-run checks failed.",
    remediation: [
      "Review the technical details for the failed check.",
      "Fix the validation issue and restart the loop.",
    ],
  },
  [LoopErrorCode.RunLoopNotFound]: {
    title: "Runner script was not found",
    description:
      "The runner could not locate the script used to execute the loop.",
    remediation: [
      "Update the local Closedloop plugins and try again.",
      "If this is a managed target, reconnect the compute target.",
    ],
  },
  [LoopErrorCode.ArtifactWriteFailed]: {
    title: "Artifact write failed",
    description:
      "The loop completed work but could not write one or more artifacts.",
    remediation: [
      "Check write permissions and available disk space.",
      "Use the technical details to recover any generated output.",
    ],
  },
  [LoopErrorCode.ProcessFailed]: {
    title: "Command failed",
    description:
      "A required command exited unsuccessfully before the operation finished.",
    remediation: [
      "Review the technical details for the command output.",
      "Fix the command failure and retry.",
    ],
  },
  [LoopErrorCode.ProcessStopped]: {
    title: "Process stopped",
    description: "The process was stopped before the operation could complete.",
    remediation: [
      "Start the operation again when the target is available.",
      "Check whether the process was cancelled or the target restarted.",
    ],
  },
  [LoopErrorCode.AuthChallenge]: {
    title: "Authentication is required",
    description:
      "The runner needs an interactive authentication step before it can continue.",
    remediation: [
      "Complete the authentication challenge in the relevant CLI or service.",
      "Restart the loop after authentication succeeds.",
    ],
  },
  [LoopErrorCode.BinaryNotFound]: {
    title: "Required binary was not found",
    description:
      "A required command-line tool is missing or unavailable on the target.",
    remediation: [
      "Install the missing tool or update the configured binary path.",
      "Run the system check again before retrying.",
    ],
  },
  [LoopErrorCode.ScriptNotFound]: {
    title: "Required script was not found",
    description:
      "A script needed by the runner is missing from the local environment.",
    remediation: [
      "Update the Closedloop plugin installation.",
      "Reconnect the compute target if the script is still missing.",
    ],
  },
  [LoopErrorCode.SpawnFailed]: {
    title: "Command could not start",
    description: "The target could not start a required process.",
    remediation: [
      "Check that the required binary exists and is executable.",
      "Run the system check to confirm the target environment.",
    ],
  },
  [LoopErrorCode.TimedOut]: {
    title: "Loop timed out",
    description: "The loop ran longer than the allowed time and was stopped.",
    remediation: [
      "Restart the loop with a smaller task or more focused prompt.",
      "Review the audit log for the last completed step.",
    ],
  },
  [LoopErrorCode.Cancelled]: {
    title: "Loop was cancelled",
    description: "The loop stopped because it was cancelled before completion.",
    remediation: ["Restart the loop if the work should continue."],
  },
  [LoopErrorCode.RepoNotAllowed]: {
    title: "Repository is outside the allowed directory",
    description:
      "The target refused to access this repository because it is outside the configured sandbox.",
    remediation: [
      "Move the repository under the allowed workspace directory.",
      "Update the target settings if this repository should be allowed.",
    ],
  },
  [LoopErrorCode.RepoNotFound]: {
    title: "Repository was not found",
    description:
      "The target could not find the repository path needed for this operation.",
    remediation: [
      "Confirm the repository still exists on the target machine.",
      "Re-select or re-clone the repository before retrying.",
    ],
  },
  [LoopErrorCode.NoWorkProduced]: {
    title: "No output produced",
    description: "The loop finished without producing the expected work.",
    remediation: [
      "Review the prompt and source context.",
      "Restart with a more specific request if work is still needed.",
    ],
  },
  [LoopErrorCode.ContextLimitExceeded]: {
    title: "Context limit exceeded",
    description:
      "The model could not continue because the conversation or context became too large.",
    remediation: [
      "Start a new loop with a narrower prompt.",
      "Reduce attached context or split the task into smaller pieces.",
    ],
  },
  [LoopErrorCode.PlanStateUnavailable]: {
    title: "Plan state is unavailable",
    description: "The loop could not read the plan state needed to continue.",
    remediation: [
      "Refresh the plan and confirm it still exists.",
      "Restart the loop after the plan state is available.",
    ],
  },
  [LoopErrorCode.StaleDispatch]: {
    title: "Dispatch was stale",
    description: "The loop dispatch no longer matched the current loop state.",
    remediation: [
      "Refresh the loop page.",
      "Start a new loop if the work still needs to run.",
    ],
  },
  [LoopErrorCode.RepoNotInProjectPool]: {
    title: "Repository is not in this project's pool",
    description:
      "One or more requested repositories aren't part of any team curated on this project.",
    remediation: [
      "Add the repository to a team that curates this project.",
      "Pick a repository from the project's available pool and retry.",
    ],
  },
} satisfies Record<LoopErrorCode, FriendlyErrorTemplate>;

const runnerSubcodeMessages = {
  [RunnerErrorSubcode.BadPlanState]: {
    title: "Plan state is unavailable",
    description:
      "The runner could not read the local plan state needed to continue.",
    remediation: [
      "Check that the plan files exist in the worktree.",
      "Restart the loop after the plan state is restored.",
    ],
  },
  [RunnerErrorSubcode.ClaudeAuthChallenge]: {
    title: "Claude authentication is required",
    description:
      "Claude stopped because it needs an interactive authentication step.",
    remediation: [
      "Run Claude locally and complete the authentication prompt.",
      "Restart the loop after authentication succeeds.",
    ],
  },
  [RunnerErrorSubcode.ClaudeContextLimit]: {
    title: "Claude context limit exceeded",
    description:
      "Claude could not continue because the context window was exhausted.",
    remediation: [
      "Restart with a narrower prompt or fewer attached files.",
      "Split the task into smaller loops.",
    ],
  },
  [RunnerErrorSubcode.ClaudeUnknownSkill]: {
    title: "Closedloop plugin command unavailable",
    description:
      "Claude could not find the required Closedloop plugin command for this loop.",
    remediation: [
      "Run System Check and use Re-check to retry plugin repair.",
      "If the issue persists, reinstall or enable the required closedloop-ai plugins.",
    ],
  },
  [RunnerErrorSubcode.ClaudeRateLimit]: {
    title: "Claude rate limit reached",
    description: "Claude was rate limited before the runner completed.",
    remediation: [
      "Wait for the rate limit to reset.",
      "Restart the loop after Claude is accepting requests again.",
    ],
  },
  [RunnerErrorSubcode.PendingTasksAtCompletion]: {
    title: "Tasks were still pending",
    description:
      "The runner reached completion with unfinished tasks still recorded.",
    remediation: [
      "Review the remaining tasks in the loop output.",
      "Restart or follow up with a narrower continuation prompt.",
    ],
  },
  [RunnerErrorSubcode.PendingTasksBlockedByQuestions]: {
    title: "Tasks are blocked by unanswered questions",
    description:
      "The runner could not finish because it needed answers to continue.",
    remediation: [
      "Answer the pending questions in the loop context.",
      "Restart the loop after the required information is available.",
    ],
  },
  [RunnerErrorSubcode.MaxIterationsNoProgress]: {
    title: "Loop stopped after no progress",
    description:
      "The runner reached the maximum iteration limit without making progress.",
    remediation: [
      "Restart with a more specific goal and smaller scope.",
      "Review the audit log for the step where progress stalled.",
    ],
  },
} satisfies Record<RunnerErrorSubcode, FriendlyErrorTemplate>;

const gitCategoryMessages = {
  [GitGatewayErrorCategory.ComputeTargetOffline]: {
    title: "Compute target is offline",
    description:
      "The loop was not restarted because the selected compute target is not online.",
    remediation: [
      "Start the Closedloop Desktop app on the selected target.",
      "Retry after the target shows online.",
    ],
  },
  [GitGatewayErrorCategory.ComputeTargetUnavailable]: {
    title: "No compute target is online",
    description:
      "The loop was not restarted because no local compute target is online.",
    remediation: [
      "Start the Closedloop Desktop app on the target you want to use.",
      "Retry after a compute target shows online.",
    ],
  },
  [GitGatewayErrorCategory.PreCommitHook]: {
    title: "Pre-commit hook failed",
    description:
      "Git refused the commit because a local pre-commit hook failed.",
    remediation: [
      "Open the technical details to see the hook output.",
      "Fix the reported issue, then commit again.",
    ],
  },
  [GitGatewayErrorCategory.GitPushAuth]: {
    title: "Git push authentication failed",
    description:
      "Git could not push because the remote rejected the credentials or permissions.",
    remediation: [
      "Check GitHub authentication and repository write access.",
      "Push again after credentials are valid.",
    ],
  },
  [GitGatewayErrorCategory.GitCommandFailed]: {
    title: "Git command failed",
    description:
      "A git command exited unsuccessfully before the operation finished.",
    remediation: [
      "Review the technical details for the git output.",
      "Fix the repository state and retry the operation.",
    ],
  },
  [GitGatewayErrorCategory.SpawnFailed]: {
    title: "Git could not start",
    description: "The target could not start the git process.",
    remediation: [
      "Confirm git is installed and executable on the target.",
      "Run the system check again before retrying.",
    ],
  },
  [GitGatewayErrorCategory.RepoNotFound]:
    loopErrorMessages[LoopErrorCode.RepoNotFound],
  [GitGatewayErrorCategory.RepoNotAllowed]:
    loopErrorMessages[LoopErrorCode.RepoNotAllowed],
} satisfies Record<GitGatewayErrorCategory, FriendlyErrorTemplate>;

const hookTypeRemediation = {
  [GitHookType.Format]: "Run the formatter and commit the formatted files.",
  [GitHookType.Lint]: "Fix the lint errors and run the commit again.",
  [GitHookType.Test]: "Fix the failing tests and run the commit again.",
  [GitHookType.Typecheck]: "Fix the type errors and run the commit again.",
  [GitHookType.Unknown]: "Fix the hook failure and commit again.",
} satisfies Record<GitHookType, string>;

const VARIABLE_PATTERN = /\{([a-zA-Z]+)\}/g;

const fallbackMessage: FriendlyErrorTemplate = {
  title: "Operation failed",
  description:
    "The operation did not complete. Technical details are available for debugging.",
  remediation: [
    "Review the technical details.",
    "Retry after fixing the underlying issue.",
  ],
};

const desktopSignedLaunchManagedKeyMessage: FriendlyErrorTemplate = {
  title: "Desktop managed signing is not ready",
  description: DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE,
  remediation: [
    "Re-run managed onboarding on the selected desktop target.",
    "Reconnect the compute target after the desktop-managed key is ready.",
  ],
};

export function resolveFriendlyError(
  input: FriendlyErrorInput
): FriendlyErrorOutput {
  const knownCode = LoopErrorCodeSchema.safeParse(input.code);
  const baseMessage = knownCode.success
    ? loopErrorMessages[knownCode.data]
    : fallbackMessage;
  const categorizedMessage = getScopedCategoryMessage(
    knownCode.success ? knownCode.data : null,
    input.details
  );
  const runnerMessage =
    knownCode.success && knownCode.data === LoopErrorCode.RunnerError
      ? getRunnerSubcodeMessage(input.result)
      : null;
  const exactMessage =
    knownCode.success && knownCode.data === LoopErrorCode.ProcessFailed
      ? getExactMessageTemplate(input.message)
      : null;
  const template =
    runnerMessage ?? exactMessage ?? categorizedMessage ?? baseMessage;
  const variables = getTemplateVariables(input);
  const timestamp = input.timestamp ?? undefined;

  return {
    title: interpolate(template.title, variables),
    description: interpolate(template.description, variables),
    remediation: getRemediation(template, input.details).map((step) =>
      interpolate(step, variables)
    ),
    ...(input.code ? { code: input.code } : {}),
    ...(timestamp ? { timestamp } : {}),
    technicalDetails: buildTechnicalDetails(input),
  };
}

function getExactMessageTemplate(
  message: string | null | undefined
): FriendlyErrorTemplate | null {
  if (message === DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE) {
    return desktopSignedLaunchManagedKeyMessage;
  }
  return null;
}

export function humanizeErrorCode(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getRunnerSubcodeMessage(
  result: JsonObject | null | undefined
): FriendlyErrorTemplate | null {
  const subcode = getString(result, "subcode");
  if (!subcode) {
    return null;
  }
  return (
    runnerSubcodeMessages[subcode as RunnerErrorSubcode] ?? {
      title: humanizeErrorCode(subcode),
      description: "The runner reported an unrecognized failure reason.",
      remediation: [
        "Review the technical details for the runner output.",
        "Retry after addressing the reported reason.",
      ],
    }
  );
}

function getScopedCategoryMessage(
  code: LoopErrorCode | null,
  details: JsonObject | null | undefined
): FriendlyErrorTemplate | null {
  const category = getString(details, "category");
  if (!category) {
    return null;
  }
  if (
    code === null ||
    code === LoopErrorCode.ProcessFailed ||
    (code === LoopErrorCode.PreRunValidationFailed &&
      isComputeTargetCategory(category))
  ) {
    return gitCategoryMessages[category as GitGatewayErrorCategory] ?? null;
  }
  return null;
}

function isComputeTargetCategory(category: string): boolean {
  return (
    category === GitGatewayErrorCategory.ComputeTargetOffline ||
    category === GitGatewayErrorCategory.ComputeTargetUnavailable
  );
}

function getRemediation(
  template: FriendlyErrorTemplate,
  details: JsonObject | null | undefined
): string[] {
  const hookType = getString(details, "hookType") as GitHookType | null;
  if (!(hookType && hookTypeRemediation[hookType])) {
    return template.remediation;
  }
  return [...template.remediation, hookTypeRemediation[hookType]];
}

function getTemplateVariables(input: FriendlyErrorInput): TemplateVariables {
  const details = input.details;
  const exitCode = getNumber(details, "exitCode");
  return {
    action: getString(details, "action") ?? undefined,
    binaryName: getString(details, "binaryName") ?? undefined,
    branch: getString(details, "branch") ?? undefined,
    exitCode: typeof exitCode === "number" ? String(exitCode) : undefined,
    repoFullName: getString(details, "repoFullName") ?? undefined,
    repoPath: getString(details, "repoPath") ?? undefined,
  };
}

function interpolate(template: string, variables: TemplateVariables): string {
  return template.replaceAll(VARIABLE_PATTERN, (match, key: string) => {
    const value = variables[key as keyof TemplateVariables];
    return value && value.length > 0 ? value : match;
  });
}

function buildTechnicalDetails(input: FriendlyErrorInput): JsonObject {
  return compactJsonObject({
    code: input.code ?? undefined,
    message: input.message ?? undefined,
    timestamp: input.timestamp ?? undefined,
    details: input.details ?? undefined,
    result: input.result ?? undefined,
  });
}

function compactJsonObject(
  value: Record<string, JsonValue | undefined>
): JsonObject {
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      output[key] = item;
    }
  }
  return output;
}

function getString(
  value: JsonObject | null | undefined,
  key: string
): string | null {
  const item = value?.[key];
  return typeof item === "string" && item.length > 0 ? item : null;
}

function getNumber(
  value: JsonObject | null | undefined,
  key: string
): number | null {
  const item = value?.[key];
  return typeof item === "number" && Number.isFinite(item) ? item : null;
}
