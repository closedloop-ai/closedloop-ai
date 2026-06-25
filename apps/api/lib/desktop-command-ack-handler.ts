import type { JsonValue } from "@repo/api/src/types/common";
import type { DesktopCommandSummary } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import type { DesktopCommandTelemetryContext } from "@/lib/desktop-command-telemetry-context";
import { publishLegacyRelayEvent } from "@/lib/desktop-relay-event-bridge";
import { failLoopFromRejectedCommand } from "@/lib/loops/rejected-command-loop-failure";

type AckTraceContext = DesktopCommandTelemetryContext;

/**
 * Applies shared Desktop command ack side effects across relay HTTP and direct
 * socket transports: command state update, narrow loop failure on key-auth
 * rejections, and terminal command error event synthesis for rejected acks.
 */
export async function acknowledgeDesktopCommand(input: {
  commandId: string;
  accepted: boolean;
  reason?: string;
  targetId: string;
  context?: AckTraceContext;
}): Promise<DesktopCommandSummary | null> {
  const acknowledged = await desktopCommandStore.acknowledgeCommand(
    input.commandId,
    input.accepted,
    input.reason,
    input.targetId,
    input.context
  );

  if (input.accepted) {
    return acknowledged;
  }

  log.warn("Command rejected by desktop", {
    commandId: input.commandId,
    reason: input.reason,
    computeTargetId: input.context?.computeTargetId ?? input.targetId,
    gatewaySessionId: input.context?.gatewaySessionId,
    requestId: input.context?.requestId,
    errorClass: ErrorClass.Execution,
  });

  try {
    await failLoopFromRejectedCommand({
      commandId: input.commandId,
      targetId: input.targetId,
      reason: input.reason,
    });
  } catch (loopFailureError) {
    log.error("Failed applying rejected command loop failure", {
      commandId: input.commandId,
      reason: input.reason,
      computeTargetId: input.context?.computeTargetId ?? input.targetId,
      error: loopFailureError,
    });
  }

  const errorData: JsonValue = {
    terminal: true,
    error: input.reason || "Command rejected by desktop",
    code: "rejected",
  };
  const result = await desktopCommandStore.ingestCommandEvent({
    commandId: input.commandId,
    eventType: "error",
    data: errorData,
    computeTargetId: input.targetId,
    ...(input.context ? { context: input.context } : {}),
  });
  if (result.accepted && !result.duplicate) {
    await publishLegacyRelayEvent(input.commandId, {
      commandId: input.commandId,
      eventType: "error",
      data: errorData,
      sequence: result.sequence,
    });
  }

  return acknowledged;
}
