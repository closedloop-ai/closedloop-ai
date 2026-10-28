import type { JsonValue } from "@repo/api/src/types/common";
import type { DesktopCommandSummary } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { ErrorClass } from "@repo/observability/telemetry/schema";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import type { DesktopCommandTelemetryContext } from "@/lib/desktop-command-telemetry-context";

type AckTraceContext = DesktopCommandTelemetryContext;

/**
 * Applies shared Desktop command ack side effects across relay HTTP and direct
 * socket transports: command state update and terminal command error event
 * synthesis for rejected acks.
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

  // gatewaySessionId is a session-correlation token that must never be logged in
  // plaintext (see apps/api/docs/command-correlation.md). Log a short stable
  // hash; the raw id still flows into the store/DB context below, which is a
  // non-log contract governed separately.
  log.warn("Command rejected by desktop", {
    commandId: input.commandId,
    reason: input.reason,
    computeTargetId: input.context?.computeTargetId ?? input.targetId,
    gatewaySessionIdHash: redactGatewaySessionId(
      input.context?.gatewaySessionId
    ),
    requestId: input.context?.requestId,
    errorClass: ErrorClass.Execution,
  });

  const errorData: JsonValue = {
    terminal: true,
    error: input.reason || "Command rejected by desktop",
    code: "rejected",
  };
  await desktopCommandStore.ingestCommandEvent({
    commandId: input.commandId,
    eventType: "error",
    data: errorData,
    computeTargetId: input.targetId,
    ...(input.context ? { context: input.context } : {}),
  });

  return acknowledged;
}
