import { TelemetryCategory } from "@repo/observability/telemetry/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleTelemetryEvent } from "@/lib/desktop-telemetry-handler";
import { dispatchSocketEvent } from "./service";

vi.mock("@/lib/desktop-telemetry-handler", () => ({
  handleTelemetryEvent: vi.fn(),
}));

describe("dispatchSocketEvent desktop.telemetry", () => {
  beforeEach(() => {
    vi.mocked(handleTelemetryEvent).mockReset();
  });

  it("routes relay telemetry to the desktop telemetry handler with target context", async () => {
    vi.mocked(handleTelemetryEvent).mockReturnValue({ ok: true });

    const payload = {
      schemaVersion: "1",
      category: TelemetryCategory.LoopPerfIteration,
      severity: "info",
      timestamp: "2026-05-12T00:00:00.000Z",
      trace: {
        commandId: "cmd-1",
        operationId: "op-1",
        computeTargetId: "target-1",
      },
      diagnostics: {
        loopPerf: {
          event: "iteration",
          command: "EXECUTE",
          runId: "run-1",
        },
      },
    };

    await expect(
      dispatchSocketEvent({
        event: "desktop.telemetry",
        payload,
        auth: {
          organizationId: "org-1",
          userId: "user-db-1",
          clerkUserId: "clerk-user-1",
        },
        targetId: "target-1",
        correlation: { gatewaySessionId: "session-1" },
        pluginVersion: "1.0.0",
        relaySocketId: "socket-1",
        requestArrivedAt: 1000,
      })
    ).resolves.toEqual({
      ok: true,
      response: { emit: [] },
    });

    expect(handleTelemetryEvent).toHaveBeenCalledWith(payload, {
      authenticatedTargetId: "target-1",
      pluginVersion: "1.0.0",
      gatewaySessionId: "session-1",
      organizationId: "org-1",
      userId: "user-db-1",
    });
  });

  it("returns handler emits when telemetry validation fails", async () => {
    vi.mocked(handleTelemetryEvent).mockReturnValue({
      ok: false,
      validationFailed: true,
      emits: [{ event: "desktop.telemetry.nack", payload: { reason: "bad" } }],
    });

    await expect(
      dispatchSocketEvent({
        event: "desktop.telemetry",
        payload: {},
        auth: null,
        targetId: "target-1",
        correlation: {},
        pluginVersion: undefined,
        relaySocketId: "socket-1",
        requestArrivedAt: 1000,
      })
    ).resolves.toEqual({
      ok: true,
      response: {
        emit: [{ event: "desktop.telemetry.nack", payload: { reason: "bad" } }],
      },
    });
  });
});
