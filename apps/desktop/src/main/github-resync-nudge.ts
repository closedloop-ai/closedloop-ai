import {
  GITHUB_RESYNC_NUDGE_METHOD,
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
  parseGitHubResyncNudgeBody,
} from "@repo/api/src/types/github-dirty-scope";
import type { DesktopCommandEvent } from "./cloud-protocol.js";
import {
  type ActiveCommandKeyTargetContext,
  browserCommandKeyTargetContextMatches,
  parseBrowserCommandKeyCommandTargetContext,
} from "./command-key-target-context.js";
import {
  type ReservedCommandAckPayload as CommandAckPayload,
  type ReservedCommandEventPayload as CommandEventPayload,
  classifyReservedCommand,
  type ReservedCommandMatch,
  rejectReservedCommand,
} from "./reserved-command-handler.js";

export type GitHubResyncNudgeCommandMatch = ReservedCommandMatch;

export const GITHUB_RESYNC_NUDGE_INVALID_REASON =
  "invalid github resync nudge payload";
export const GITHUB_RESYNC_NUDGE_TARGET_CONTEXT_MISMATCH_REASON =
  "github resync nudge target context mismatch";

export type GitHubResyncNudgeHandlerOptions = {
  getActiveTargetContext?: () => ActiveCommandKeyTargetContext | undefined;
  sendCommandAck: (event: CommandAckPayload) => void;
  sendCommandEvent: (event: CommandEventPayload) => void;
  notifyRendererRefresh: (body: unknown) => void | Promise<void>;
  log?: (level: "warn", message: string) => void;
};

/** Identifies the narrow server-control GitHub resync nudge command. */
export function classifyGitHubResyncNudgeCommand(
  command: Pick<DesktopCommandEvent, "method" | "operationId" | "path">
): GitHubResyncNudgeCommandMatch {
  return classifyReservedCommand(command, {
    method: GITHUB_RESYNC_NUDGE_METHOD,
    operationId: GITHUB_RESYNC_NUDGE_OPERATION_ID,
    path: GITHUB_RESYNC_NUDGE_PATH,
  });
}

export async function handleGitHubResyncNudgeCommand(
  command: DesktopCommandEvent,
  options: GitHubResyncNudgeHandlerOptions
): Promise<void> {
  const parsed = parseGitHubResyncNudgeBody(command.body);
  const targetContext = parseBrowserCommandKeyCommandTargetContext(parsed.body);
  if (targetContext.kind === "invalid") {
    rejectNudge(command, options, GITHUB_RESYNC_NUDGE_INVALID_REASON);
    return;
  }
  if (
    !browserCommandKeyTargetContextMatches({
      commandContext: targetContext,
      activeContext: options.getActiveTargetContext?.(),
    })
  ) {
    rejectNudge(
      command,
      options,
      GITHUB_RESYNC_NUDGE_TARGET_CONTEXT_MISMATCH_REASON
    );
    return;
  }

  options.sendCommandAck({
    commandId: command.commandId,
    accepted: true,
    state: "accepted",
  });
  try {
    await options.notifyRendererRefresh(parsed.body);
  } catch {
    options.log?.(
      "warn",
      `GitHub resync nudge ${command.commandId} refresh failed; relying on pull recovery`
    );
  }
  options.sendCommandEvent({
    commandId: command.commandId,
    sequence: 1,
    eventType: "done",
    data: {
      type: "done",
      fallback: !parsed.ok,
    },
  });
}

function rejectNudge(
  command: DesktopCommandEvent,
  options: GitHubResyncNudgeHandlerOptions,
  reason: string
): void {
  rejectReservedCommand(command, options, "GitHub resync nudge", reason);
}
