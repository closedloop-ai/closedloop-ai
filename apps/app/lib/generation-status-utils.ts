import {
  type GenerationStatus,
  isActiveGenerationStatus,
} from "@repo/api/src/types/document";
import { getUserDisplayName } from "@/lib/user-utils";

export function getStatusMessage(
  status: GenerationStatus["status"],
  command: GenerationStatus["command"],
  initiatedBy?: GenerationStatus["initiatedBy"]
): string {
  const initiatorName = getInitiatorName(initiatedBy);

  switch (status) {
    case "PENDING":
      return "Waiting to start...";
    case "QUEUED":
      return getQueuedMessage(command);
    case "RUNNING":
      return getRunningMessage(command, initiatorName);
    case "FAILURE":
      return getFailureMessage(command);
    default:
      return "";
  }
}

/**
 * Get the display name from initiatedBy user info.
 * Returns null if no user info is available.
 */
function getInitiatorName(
  initiatedBy?: GenerationStatus["initiatedBy"]
): string | null {
  if (!initiatedBy) {
    return null;
  }
  return getUserDisplayName(initiatedBy);
}

/** Build a queued message for the given command. */
function getQueuedMessage(command: GenerationStatus["command"]): string {
  switch (command) {
    case "execute":
      return "Queued for execution...";
    case "request_changes":
      return "Queued for change request...";
    case "request_prd_changes":
      return "Queued for PRD change request...";
    case "explore":
      return "Queued for exploration...";
    default:
      return "Queued for generation...";
  }
}

/** Build a running/active message for the given command, optionally prefixed with initiator name. */
function getRunningMessage(
  command: GenerationStatus["command"],
  initiatorName: string | null
): string {
  const verb = getRunningVerb(command);
  if (initiatorName) {
    return `${initiatorName} is ${verb.charAt(0).toLowerCase()}${verb.slice(1)}`;
  }
  return verb;
}

/** Get the running verb phrase for a command. */
function getRunningVerb(command: GenerationStatus["command"]): string {
  switch (command) {
    case "execute":
      return "Executing plan and creating PR...";
    case "request_changes":
      return "Applying requested changes...";
    case "request_prd_changes":
      return "Applying requested PRD changes...";
    case "explore":
      return "Exploring codebase...";
    case "chat":
      return "Processing chat request...";
    default:
      return "Generating...";
  }
}

/** Build a failure message for the given command. */
function getFailureMessage(command: GenerationStatus["command"]): string {
  switch (command) {
    case "execute":
      return "Plan execution failed";
    case "request_changes":
      return "Change request failed";
    case "request_prd_changes":
      return "PRD change request failed";
    case "explore":
      return "Codebase exploration failed";
    case "chat":
      return "Chat request failed";
    default:
      return "Generation failed";
  }
}

/**
 * Per-command disabled predicate for run-loop menu items.
 *
 * Returns true (disabled) when:
 * - The generation-status poll reports an active loop matching `targetCommand`, OR
 * - The generation-status fetch is still loading (`isLoading`), OR
 * - A local mutation is pending (`localMutationPending`).
 *
 * Unrelated commands (active loop for command A does NOT disable command B).
 */
export function isCommandDisabled(opts: {
  generationStatus: GenerationStatus | undefined;
  isLoading: boolean;
  targetCommand: GenerationStatus["command"];
  localMutationPending: boolean;
}): boolean {
  const { generationStatus, isLoading, targetCommand, localMutationPending } =
    opts;

  if (localMutationPending) {
    return true;
  }

  if (isLoading) {
    return true;
  }

  if (
    generationStatus &&
    generationStatus.command === targetCommand &&
    isActiveGenerationStatus(generationStatus.status)
  ) {
    return true;
  }

  return false;
}
