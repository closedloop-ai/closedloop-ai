import type { JsonValue } from "@repo/api/src/types/common";
import type { DesktopCommandEventType } from "@repo/api/src/types/compute-target";
import {
  DesktopCommandStatus,
  isTerminalStatus,
} from "@repo/api/src/types/compute-target";
import { isRecord } from "@/lib/type-guards";

/**
 * The desktop command state machine: what an incoming event does to the
 * command's stored status. Pure — the store owns persistence, this owns the
 * transition.
 */

/** The only fields a transition decision reads off the stored command. */
type CommandTransitionSource = {
  status: DesktopCommandStatus;
  startedAt?: Date;
};

export type CommandTransition = {
  status?: DesktopCommandStatus;
  startedAt?: Date;
  finishedAt?: Date;
  error?: string | null;
};

export function resolveCommandUpdate(
  command: CommandTransitionSource,
  eventType: DesktopCommandEventType,
  data: JsonValue
): CommandTransition {
  // A terminal command is frozen: late events are recorded, never re-opened.
  if (isTerminalStatus(command.status)) {
    return {};
  }

  if (eventType === "done") {
    const cancelled = isRecord(data) && data.cancelled === true;
    return {
      status: cancelled
        ? DesktopCommandStatus.Cancelled
        : DesktopCommandStatus.Done,
      finishedAt: new Date(),
    };
  }

  if (eventType === "error" && isRecord(data) && data.terminal === true) {
    return {
      status: DesktopCommandStatus.Failed,
      finishedAt: new Date(),
      error: typeof data.error === "string" ? data.error : "Command failed",
    };
  }

  if (eventType === "result" && isRecord(data) && data.terminal === true) {
    const cancelled = data.cancelled === true;
    return {
      status: cancelled
        ? DesktopCommandStatus.Cancelled
        : DesktopCommandStatus.Done,
      finishedAt: new Date(),
    };
  }

  if (
    command.status === DesktopCommandStatus.Queued ||
    command.status === DesktopCommandStatus.Accepted
  ) {
    return {
      status: DesktopCommandStatus.Running,
      startedAt: command.startedAt ?? new Date(),
    };
  }

  return {};
}
