import type { TelemetryTraceContext } from "@repo/observability/telemetry/schema";

export type RelayAuthContext = {
  organizationId: string;
  userId: string;
  clerkUserId?: string | null;
};

export type CorrelationContext = Pick<
  TelemetryTraceContext,
  "commandId" | "computeTargetId" | "gatewaySessionId" | "requestId"
>;

export type EmitInstruction = { event: string; payload: unknown };

export type SocketEventResponse = {
  targetId?: string;
  gatewaySessionId?: string;
  emit: EmitInstruction[];
  disconnect?: boolean;
};
