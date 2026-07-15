import type {
  DesktopCommandAckEvent,
  DesktopCommandEvent,
  DesktopCommandStreamEvent,
} from "./cloud-protocol.js";

export type ReservedCommandMatch = "match" | "mismatch" | "not_reserved";

export type ReservedCommandAckPayload = Pick<
  DesktopCommandAckEvent,
  "commandId" | "accepted" | "state" | "reason"
>;

export type ReservedCommandEventPayload = Pick<
  DesktopCommandStreamEvent,
  "commandId" | "sequence" | "eventType" | "data"
>;

type ReservedCommandDescriptor = Pick<
  DesktopCommandEvent,
  "method" | "operationId" | "path"
>;

type ReservedCommandRejectOptions = {
  log?: (level: "warn", message: string) => void;
  sendCommandAck: (event: ReservedCommandAckPayload) => void;
};

/** Classifies server-control commands by exact reserved operation/path/method. */
export function classifyReservedCommand(
  command: Pick<DesktopCommandEvent, "method" | "operationId" | "path">,
  descriptor: ReservedCommandDescriptor
): ReservedCommandMatch {
  const referencesReservedCommand =
    command.operationId === descriptor.operationId ||
    command.path === descriptor.path;
  if (!referencesReservedCommand) {
    return "not_reserved";
  }
  return command.operationId === descriptor.operationId &&
    command.path === descriptor.path &&
    command.method === descriptor.method
    ? "match"
    : "mismatch";
}

/** Rejects a reserved command with the standard failed ack and warning shape. */
export function rejectReservedCommand(
  command: Pick<DesktopCommandEvent, "commandId">,
  options: ReservedCommandRejectOptions,
  commandLabel: string,
  reason: string
): void {
  options.log?.(
    "warn",
    `Rejected ${commandLabel} ${command.commandId}: ${reason}`
  );
  options.sendCommandAck({
    commandId: command.commandId,
    accepted: false,
    state: "failed",
    reason,
  });
}
