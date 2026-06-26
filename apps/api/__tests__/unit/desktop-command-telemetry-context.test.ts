import { ZERO_GATEWAY_SESSION_ID } from "@repo/observability/telemetry/context";
import { describe, expect, it } from "vitest";
import { getRealDesktopCommandTelemetryContext } from "@/lib/desktop-command-telemetry-context";

describe("getRealDesktopCommandTelemetryContext", () => {
  it("returns context for an explicit non-zero gateway session id", () => {
    const context = {
      commandId: "cmd-1",
      operationId: "op-1",
      computeTargetId: "target-1",
      gatewaySessionId: "550e8400-e29b-41d4-a716-446655440000",
      schemaVersion: "1",
    };

    expect(getRealDesktopCommandTelemetryContext(context)).toEqual(context);
  });

  it("omits context for the zero gateway session sentinel", () => {
    expect(
      getRealDesktopCommandTelemetryContext({
        commandId: "cmd-1",
        operationId: "op-1",
        computeTargetId: "target-1",
        gatewaySessionId: ZERO_GATEWAY_SESSION_ID,
        schemaVersion: "1",
      })
    ).toBeUndefined();
  });
});
