import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteEnvForTest } from "../../__tests__/test-helpers";

// ---------------------------------------------------------------------------
// tracing/provider.ts — bootstrap failure is survivable (ISS-4659).
//
// Lives in its own file because the SDK mock below has to be module-scoped: a
// throwing NodeTracerProvider would break every other provider test.
//
// The contract under test is the one that matters most in production. Tracing
// is a diagnostic aid bolted onto the request path, so a broken exporter, a bad
// endpoint, or an SDK version skew must degrade to "untraced" — never to a
// failed cold start, which would take the whole API down for a telemetry
// problem.
// ---------------------------------------------------------------------------

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class {
    constructor() {
      throw new Error("simulated SDK bootstrap failure");
    }
  },
  BatchSpanProcessor: class {},
  ParentBasedSampler: class {},
  TraceIdRatioBasedSampler: class {},
}));

afterEach(async () => {
  const { resetTracingForTest } = await import("../provider");
  await resetTracingForTest();
  const { resetTraceContextProvider } = await import("../../trace-context");
  resetTraceContextProvider();
  vi.unstubAllEnvs();
});

function stubEnabledEnv(): void {
  deleteEnvForTest(
    "DD_TRACING_DISABLED",
    "DD_TRACING_ENABLED",
    "DD_API_KEY",
    "DD_OTLP_TRACES_ENDPOINT",
    "DD_TRACE_SAMPLE_RATE",
    "VERCEL"
  );
  vi.stubEnv("DD_TRACING_ENABLED", "1");
  vi.stubEnv("DD_API_KEY", "dd-test-key");
  vi.stubEnv("DD_OTLP_TRACES_ENDPOINT", "https://otlp.example.test/v1/traces");
}

describe("initTracing when the SDK bootstrap throws", () => {
  it("swallows the failure instead of propagating it to the caller", async () => {
    stubEnabledEnv();
    const { initTracing } = await import("../provider");

    expect(() => initTracing()).not.toThrow();
  });

  it("reports the failure as a disabled reason rather than claiming success", async () => {
    stubEnabledEnv();
    const { initTracing } = await import("../provider");
    const { TracingDisabledReason } = await import("../config");

    expect(initTracing()).toEqual({
      enabled: false,
      reason: TracingDisabledReason.InitFailed,
    });
  });

  it("leaves the logger untraced rather than half-wired", async () => {
    stubEnabledEnv();
    const { initTracing } = await import("../provider");
    const { getTraceContext } = await import("../../trace-context");

    initTracing();

    // A provider registered against a tracer that failed to build would stamp
    // log lines with ids no trace will ever arrive for.
    expect(getTraceContext()).toBeUndefined();
  });

  it("still resolves a flush after the failed bootstrap", async () => {
    stubEnabledEnv();
    const { initTracing } = await import("../provider");
    const { flushSpans, isTracingActive } = await import("../hooks");

    initTracing();

    // No flush hook was ever registered, so the seam reports inactive and
    // callers skip scheduling flush work entirely.
    expect(isTracingActive()).toBe(false);
    await expect(flushSpans()).resolves.toBeUndefined();
  });
});
