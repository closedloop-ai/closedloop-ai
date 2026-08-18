import { context, TraceFlags, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteEnvForTest } from "../../__tests__/test-helpers";
import {
  getTraceContext,
  resetTraceContextProvider,
} from "../../trace-context";
import { TracingDisabledReason } from "../config";
import { flushSpans, isTracingActive } from "../hooks";
import { initTracing, resetTracingForTest } from "../provider";

// ---------------------------------------------------------------------------
// tracing/provider.ts — fail-open behaviour (ISS-4659).
//
// Tracing is a diagnostic aid: it must never add latency to, or fail, a
// request. These tests pin the two ways that promise could be broken — an
// init that throws, and a flush that rejects when nothing was ever started.
// ---------------------------------------------------------------------------

const SAMPLED_OUT_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SAMPLED_OUT_SPAN_ID = "00f067aa0ba902b7";

afterEach(async () => {
  // Awaited: the provider drains asynchronously, and a later test's register()
  // must not race a teardown still in flight.
  await resetTracingForTest();
  resetTraceContextProvider();
  vi.unstubAllEnvs();
});

function clearTracingEnv(): void {
  deleteEnvForTest(
    "DD_TRACING_DISABLED",
    "DD_TRACING_ENABLED",
    "DD_API_KEY",
    "DD_OTLP_TRACES_ENDPOINT",
    "DD_TRACE_SAMPLE_RATE",
    "VERCEL"
  );
}

describe("initTracing", () => {
  it("stays inert on an undeployed runtime and reports why", () => {
    clearTracingEnv();

    const result = initTracing();

    expect(result).toEqual({
      enabled: false,
      reason: TracingDisabledReason.NotDeployed,
    });
  });

  it("leaves the logger's trace-context provider untouched when disabled", () => {
    clearTracingEnv();

    initTracing();

    // The logger must emit exactly the pre-ISS-4659 shape when untraced.
    expect(getTraceContext()).toBeUndefined();
  });

  it("does not throw when the kill switch is set", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACING_DISABLED", "1");

    expect(() => initTracing()).not.toThrow();
    expect(initTracing()).toEqual({
      enabled: false,
      reason: TracingDisabledReason.ExplicitlyDisabled,
    });
  });

  it("registers a live trace-context provider once enabled", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACING_ENABLED", "1");
    vi.stubEnv("DD_API_KEY", "dd-test-key");
    vi.stubEnv(
      "DD_OTLP_TRACES_ENDPOINT",
      "https://otlp.example.test/v1/traces"
    );

    const result = initTracing();

    expect(result.enabled).toBe(true);
    // The SDK-free seam now reports a live tracer — this is what
    // `route-utils` gates its flush scheduling on.
    expect(isTracingActive()).toBe(true);
    // A provider is now installed; with no span active it reports undefined
    // rather than throwing, which is what keeps untraced log calls clean.
    expect(getTraceContext()).toBeUndefined();
  });

  it("does not stamp trace ids for a sampled-out span", () => {
    clearTracingEnv();
    vi.stubEnv("DD_TRACING_ENABLED", "1");
    vi.stubEnv("DD_API_KEY", "dd-test-key");
    vi.stubEnv(
      "DD_OTLP_TRACES_ENDPOINT",
      "https://otlp.example.test/v1/traces"
    );
    initTracing();

    // `wrapSpanContext` yields a NonRecordingSpan — exactly what the sampler
    // produces for a request it declined. It still has a real spanContext, so
    // reading ids unconditionally would correlate logs to a trace that is
    // never exported. At the default 10% rate that is most log lines.
    const sampledOut = trace.wrapSpanContext({
      traceId: SAMPLED_OUT_TRACE_ID,
      spanId: SAMPLED_OUT_SPAN_ID,
      traceFlags: TraceFlags.NONE,
    });

    const stamped = context.with(
      trace.setSpan(context.active(), sampledOut),
      () => getTraceContext()
    );

    expect(stamped).toBeUndefined();
  });

  it("returns the first outcome on repeat calls rather than re-reading the env", () => {
    clearTracingEnv();

    const first = initTracing();
    // Re-resolving here would report "enabled" for a tracer that was never
    // installed, and a caller logging that would describe a fiction.
    vi.stubEnv("DD_TRACING_ENABLED", "1");
    vi.stubEnv("DD_API_KEY", "dd-test-key");
    vi.stubEnv(
      "DD_OTLP_TRACES_ENDPOINT",
      "https://otlp.example.test/v1/traces"
    );

    expect(initTracing()).toEqual(first);
    expect(isTracingActive()).toBe(false);
  });
});

describe("flushSpans", () => {
  it("resolves without a tracer rather than rejecting", async () => {
    clearTracingEnv();
    initTracing();

    await expect(flushSpans()).resolves.toBeUndefined();
  });

  it("resolves when never initialised at all", async () => {
    await expect(flushSpans()).resolves.toBeUndefined();
  });
});
