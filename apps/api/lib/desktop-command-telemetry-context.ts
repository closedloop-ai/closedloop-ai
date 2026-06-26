import { ZERO_GATEWAY_SESSION_ID as OBSERVABILITY_ZERO_GATEWAY_SESSION_ID } from "@repo/observability/telemetry/context";
import type { TelemetryTraceContext } from "@repo/observability/telemetry/schema";

export type DesktopCommandTelemetryContext = Pick<
  TelemetryTraceContext,
  "gatewaySessionId" | "schemaVersion"
> &
  Partial<TelemetryTraceContext>;

export function getRealDesktopCommandTelemetryContext(
  context: TelemetryTraceContext
): DesktopCommandTelemetryContext | undefined {
  if (context.gatewaySessionId === OBSERVABILITY_ZERO_GATEWAY_SESSION_ID) {
    return undefined;
  }
  return context;
}
