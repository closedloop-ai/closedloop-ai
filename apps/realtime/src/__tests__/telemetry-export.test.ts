import { log } from "@repo/observability/log";
import {
  type TracingConfig,
  TracingDisabledReason,
} from "@repo/observability/tracing/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REALTIME_TELEMETRY_UNEXPORTED_EVENT,
  requireTelemetryExportOrExit,
  TelemetrySignal,
} from "../telemetry/tracing";

const ON_ECS = { ecsMetadataUri: "http://169.254.170.2/v4/task" };

const TRACING_ON: TracingConfig = {
  enabled: true,
  endpoint: "http://localhost:4318/v1/traces",
  apiKey: undefined,
  service: "cl-realtime",
  env: "stage",
  sampleRate: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function fatalDeps(logExportOpen: boolean, logExportDisabled = false) {
  const order: string[] = [];
  return {
    order,
    deps: {
      logExportOpen,
      logExportDisabled,
      exit: vi.fn(() => {
        order.push("exit");
      }),
      flushLogs: vi.fn(() => {
        order.push("flush");
        return Promise.resolve();
      }),
    },
  };
}

describe("requireTelemetryExportOrExit", () => {
  it("boots on ECS when logs and traces both have a way out", async () => {
    const { deps } = fatalDeps(true);

    expect(await requireTelemetryExportOrExit(ON_ECS, TRACING_ON, deps)).toBe(
      true
    );
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("refuses to boot on ECS, loudly, naming each signal with no way out", async () => {
    const { deps, order } = fatalDeps(false);
    const error = vi.spyOn(log, "error").mockImplementation(() => {
      order.push("log");
    });

    const booted = await requireTelemetryExportOrExit(
      ON_ECS,
      { enabled: false, reason: TracingDisabledReason.MissingApiKey },
      deps
    );

    expect(booted).toBe(false);
    expect(order).toEqual(["log", "flush", "exit"]);
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.any(String), {
      event: REALTIME_TELEMETRY_UNEXPORTED_EVENT,
      fatal: true,
      signals: [TelemetrySignal.Logs, TelemetrySignal.Traces],
    });
  });

  it.each([
    TracingDisabledReason.MissingEndpoint,
    TracingDisabledReason.NotDeployed,
  ])(
    "counts tracing disabled as %s as traces with no way out",
    async (reason) => {
      const { deps } = fatalDeps(true);
      const error = vi.spyOn(log, "error").mockImplementation(() => {
        // asserted below
      });

      expect(
        await requireTelemetryExportOrExit(
          ON_ECS,
          { enabled: false, reason },
          deps
        )
      ).toBe(false);
      expect(error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signals: [TelemetrySignal.Traces] })
      );
    }
  );

  it.each([
    TracingDisabledReason.ExplicitlyDisabled,
    TracingDisabledReason.InitFailed,
  ])("does not refuse over tracing disabled as %s", async (reason) => {
    const { deps } = fatalDeps(true);

    expect(
      await requireTelemetryExportOrExit(
        ON_ECS,
        { enabled: false, reason },
        deps
      )
    ).toBe(true);
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("boots on ECS with log export closed because DD_LOGS_DISABLED switched it off", async () => {
    const { deps } = fatalDeps(false, true);

    expect(await requireTelemetryExportOrExit(ON_ECS, TRACING_ON, deps)).toBe(
      true
    );
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it("does not check off ECS, where the console is the intended sink", async () => {
    const { deps } = fatalDeps(false);

    expect(
      await requireTelemetryExportOrExit(
        { ecsMetadataUri: undefined },
        { enabled: false, reason: TracingDisabledReason.NotDeployed },
        deps
      )
    ).toBe(true);
    expect(deps.exit).not.toHaveBeenCalled();
  });
});

// The task definition's two shapes, through the real env resolution and the
// production defaults: the sidecar path with no key, and no path at all.
describe("requireTelemetryExportOrExit against the task environment", () => {
  async function bootWithEnv(env: Record<string, string>) {
    for (const key of [
      "DD_API_KEY",
      "DD_LOGS_DISABLED",
      "DD_LOGS_FORWARDER_URL",
      "DD_OTLP_TRACES_ENDPOINT",
      "DD_TRACING_DISABLED",
      "VERCEL",
    ]) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv("DD_TRACING_ENABLED", "1");
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 })
    );
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      // asserted by the caller
    }) as never);
    vi.resetModules();
    const fresh = await import("../telemetry/tracing");
    const { resolveTracingConfig } = await import(
      "@repo/observability/tracing/config"
    );
    const freshLog = await import("@repo/observability/log");
    const error = vi.spyOn(freshLog.log, "error");
    const booted = await fresh.requireTelemetryExportOrExit(
      ON_ECS,
      resolveTracingConfig()
    );
    return { booted, exit, error };
  }

  it("boots with no DD_API_KEY when the sidecar carries logs and traces", async () => {
    const { booted, exit } = await bootWithEnv({
      DD_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
      DD_LOGS_FORWARDER_URL: "http://localhost:6060",
    });

    expect(booted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it("boots with Datadog logs and traces both switched off on purpose", async () => {
    const { booted, exit } = await bootWithEnv({
      DD_TRACING_DISABLED: "1",
      DD_LOGS_DISABLED: "1",
      DD_LOGS_FORWARDER_URL: "http://localhost:6060",
    });

    expect(booted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a forwarder that is not loopback",
      { DD_LOGS_FORWARDER_URL: "https://logs.example.test" },
    ],
    [
      "DD_LOGS_DISABLED set to a value that does not disable",
      { DD_LOGS_DISABLED: "0" },
    ],
  ])(
    "refuses to boot when logs have no way out through %s",
    async (_label, logsEnv) => {
      const { booted, exit, error } = await bootWithEnv({
        DD_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
        ...logsEnv,
      });

      expect(booted).toBe(false);
      expect(exit).toHaveBeenCalledWith(1);
      expect(error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signals: [TelemetrySignal.Logs] })
      );
    }
  );

  it("refuses to boot with no DD_API_KEY and no sidecar path", async () => {
    const { booted, exit, error } = await bootWithEnv({
      DD_OTLP_TRACES_ENDPOINT: "https://otlp.example.test/v1/traces",
    });

    expect(booted).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        signals: [TelemetrySignal.Logs, TelemetrySignal.Traces],
      })
    );
  });
});
