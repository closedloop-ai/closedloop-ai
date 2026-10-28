import {
  type TracingConfig,
  TracingDisabledReason,
} from "@repo/observability/tracing/config";
import { afterEach, describe, expect, it, vi } from "vitest";

const boot = vi.hoisted(() => ({
  loadRealtimeEnvOrExit: vi.fn(),
  initRealtimeTracing: vi.fn(),
  requireTelemetryExportOrExit: vi.fn(),
  createRealtimeInstance: vi.fn(),
}));

vi.mock("../env", () => ({
  loadRealtimeEnvOrExit: boot.loadRealtimeEnvOrExit,
}));
vi.mock("../telemetry/tracing", () => ({
  flushTelemetry: vi.fn(),
  initRealtimeTracing: boot.initRealtimeTracing,
  requireTelemetryExportOrExit: boot.requireTelemetryExportOrExit,
}));
vi.mock("../instance", () => ({
  createRealtimeInstance: boot.createRealtimeInstance,
}));
vi.mock("../telemetry/gauges", () => ({ startGaugeReporter: vi.fn() }));

const ENV = { port: 0, ecsMetadataUri: undefined };

const TRACING: TracingConfig = {
  enabled: false,
  reason: TracingDisabledReason.ExplicitlyDisabled,
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function runEntrypoint(gatePasses: boolean): Promise<void> {
  boot.loadRealtimeEnvOrExit.mockResolvedValue(ENV);
  boot.initRealtimeTracing.mockReturnValue(TRACING);
  boot.requireTelemetryExportOrExit.mockResolvedValue(gatePasses);
  boot.createRealtimeInstance.mockReturnValue({
    httpServer: { on: vi.fn(), listen: vi.fn() },
    io: {},
    drain: {},
    shutdown: vi.fn(),
    readiness: {},
  });
  // The entrypoint's SIGTERM/SIGINT handlers must not attach to the test worker.
  vi.spyOn(process, "once").mockReturnValue(process);
  vi.resetModules();
  await import("../index");
}

describe("realtime entrypoint", () => {
  it("runs the telemetry export gate on the parsed env and the tracer's config before serving", async () => {
    await runEntrypoint(true);

    expect(boot.requireTelemetryExportOrExit).toHaveBeenCalledWith(
      ENV,
      TRACING
    );
    expect(boot.createRealtimeInstance).toHaveBeenCalledOnce();
  });

  it("serves nothing when the gate refuses", async () => {
    await runEntrypoint(false);

    expect(boot.requireTelemetryExportOrExit).toHaveBeenCalledOnce();
    expect(boot.createRealtimeInstance).not.toHaveBeenCalled();
  });
});
