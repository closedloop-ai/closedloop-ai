import { COMMAND_ACK_REJECTION_REASONS } from "../../shared/ack-reasons.js";
import { resolveOperationId } from "../approvals/approval-operations.js";
import { classifyGitHubResyncNudgeCommand } from "../github/github-resync-nudge.js";
import type {
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  ProtocolEnvelope,
} from "./cloud-protocol.js";

/**
 * The ack shape `CloudSocketService.sendCommandAck` accepts — the socket stamps
 * the envelope fields itself, so a caller must not supply them.
 */
type CommandAckInput = Omit<DesktopCommandAckEvent, keyof ProtocolEnvelope>;

export type CloudCommandAdmissionDeps = {
  sendCommandAck: (event: CommandAckInput) => void;
  /**
   * Fire-and-forget: the reserved nudge handler is async, and this path has
   * never awaited it. The caller owns discarding the promise, so the `void`
   * marker stays at the call site rather than here.
   */
  handleGitHubResyncNudgeCommand: (command: DesktopCommandEvent) => void;
  isDesktopSetupComplete: () => boolean;
  areCloudCommandsPaused: () => boolean;
  enqueue: (command: DesktopCommandEvent) => void;
};

/**
 * Admission for every inbound cloud command: route the reserved GitHub resync
 * nudge to its own handler, then either reject with a named reason or hand the
 * command to the executor.
 *
 * Lifted out of the `onCommand` callback inside `DesktopApplication`'s
 * constructor so this path has a callable entry point. ISS-7486 (#5723) found
 * that the reject reasons produced here were the ones its parity test could not
 * reach, precisely because they were inline literals buried in constructor
 * wiring with nothing to call.
 */
export function admitInboundCloudCommand(
  command: DesktopCommandEvent,
  deps: CloudCommandAdmissionDeps
): void {
  const githubResyncNudgeMatch = classifyGitHubResyncNudgeCommand(command);
  if (githubResyncNudgeMatch === "match") {
    deps.handleGitHubResyncNudgeCommand(command);
    return;
  }
  if (githubResyncNudgeMatch === "mismatch") {
    deps.sendCommandAck({
      commandId: command.commandId,
      accepted: false,
      state: "failed",
      reason: COMMAND_ACK_REJECTION_REASONS.unroutableOperation,
    });
    return;
  }
  if (!deps.isDesktopSetupComplete()) {
    deps.sendCommandAck({
      commandId: command.commandId,
      accepted: false,
      state: "failed",
      reason: COMMAND_ACK_REJECTION_REASONS.onboardingIncomplete,
    });
    return;
  }
  const resolvedOperationId = resolveOperationId(command.path);
  // Accept the command if either:
  // 1. The operationId matches exactly (explicit dispatch like git_action)
  // 2. The path resolves to a known operation (relay HTTP proxy uses random UUIDs)
  if (!resolvedOperationId) {
    deps.sendCommandAck({
      commandId: command.commandId,
      accepted: false,
      state: "failed",
      reason: COMMAND_ACK_REJECTION_REASONS.unroutableOperation,
    });
    return;
  }
  if (deps.areCloudCommandsPaused()) {
    deps.sendCommandAck({
      commandId: command.commandId,
      accepted: false,
      state: "failed",
      reason: COMMAND_ACK_REJECTION_REASONS.commandsPaused,
    });
    return;
  }
  deps.enqueue(command);
}
