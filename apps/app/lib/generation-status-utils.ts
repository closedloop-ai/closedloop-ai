import type { GenerationStatus } from "@repo/api/src/types/artifact";

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
  const name = [initiatedBy.firstName, initiatedBy.lastName]
    .filter(Boolean)
    .join(" ");
  return name || null;
}

/** Build a running/active message for the given command, optionally prefixed with initiator name. */
function getRunningMessage(
  command: GenerationStatus["command"],
  initiatorName: string | null
): string {
  const prefix = initiatorName ? `${initiatorName} is ` : "";

  switch (command) {
    case "execute":
      return `${prefix}${initiatorName ? "e" : "E"}xecuting plan and creating PR...`;
    case "request_changes":
      return `${prefix}${initiatorName ? "a" : "A"}pplying requested changes...`;
    case "explore":
      return `${prefix}${initiatorName ? "e" : "E"}xploring codebase...`;
    case "chat":
      return `${prefix}${initiatorName ? "p" : "P"}rocessing chat request...`;
    default:
      return `${prefix}${initiatorName ? "g" : "G"}enerating implementation plan...`;
  }
}

/** Build a failure message for the given command. */
function getFailureMessage(command: GenerationStatus["command"]): string {
  switch (command) {
    case "execute":
      return "Plan execution failed";
    case "request_changes":
      return "Change request failed";
    case "explore":
      return "Codebase exploration failed";
    case "chat":
      return "Chat request failed";
    default:
      return "Plan generation failed";
  }
}

export function getStatusMessage(
  status: GenerationStatus["status"],
  command: GenerationStatus["command"],
  initiatedBy?: GenerationStatus["initiatedBy"]
): string {
  const initiatorName = getInitiatorName(initiatedBy);

  switch (status) {
    case "PENDING":
      return "Waiting to start...";
    case "QUEUED": {
      if (command === "execute") {
        return "Queued for execution...";
      }
      return "Queued for generation...";
    }
    case "RUNNING":
      return getRunningMessage(command, initiatorName);
    case "FAILURE":
      return getFailureMessage(command);
    default:
      return "";
  }
}
