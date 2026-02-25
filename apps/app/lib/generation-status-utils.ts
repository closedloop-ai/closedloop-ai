import type { GenerationStatus } from "@repo/api/src/types/artifact";
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
  const name = getUserDisplayName(initiatedBy);
  return name === "Unknown" ? null : name;
}

/** Build a queued message for the given command. */
function getQueuedMessage(command: GenerationStatus["command"]): string {
  switch (command) {
    case "plan":
      return "Queued for plan generation...";
    case "execute":
      return "Queued for execution...";
    case "request_changes":
      return "Queued for change request...";
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
    case "plan":
      return "Generating implementation plan...";
    case "execute":
      return "Executing plan and creating PR...";
    case "request_changes":
      return "Applying requested changes...";
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
    case "plan":
      return "Plan generation failed";
    case "execute":
      return "Plan execution failed";
    case "request_changes":
      return "Change request failed";
    case "explore":
      return "Codebase exploration failed";
    case "chat":
      return "Chat request failed";
    default:
      return "Generation failed";
  }
}
