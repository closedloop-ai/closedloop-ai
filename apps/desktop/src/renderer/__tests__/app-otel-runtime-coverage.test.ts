/**
 * Branch-coverage tests for app-otel-runtime.ts (ISS-11284) targeting branches
 * not exercised by the existing renderer-otel-runtime.test.ts suite: shutdown
 * racing an in-flight start / a started provider, span-exporter dropped-count
 * omission vs inclusion, and the exception-attribute message/stacktrace
 * omission branches.
 */
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { trace } from "@opentelemetry/api";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RendererOtelBridgePayload,
  RendererOtelBridgeRecord,
  RendererOtelExportResult,
} from "../../shared/renderer-otel-bridge-constants";
import { createRendererOtelRuntime } from "../app-otel-runtime";

type ExportTelemetry = (
  payload: RendererOtelBridgePayload
) => Promise<RendererOtelExportResult>;

function okResult(): RendererOtelExportResult {
  return { ok: true, acceptedRecords: 1, droppedRecordsCount: 0 };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  trace.disable();
  vi.restoreAllMocks();
});

describe("createRendererOtelRuntime shutdown races", () => {
  it("awaits an in-flight start before finishing shutdown", async () => {
    let resolveExport: (result: RendererOtelExportResult) => void = () =>
      undefined;
    const exportTelemetry = vi.fn<ExportTelemetry>(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve;
        })
    );
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    const startPromise = runtime.start();
    const shutdownPromise = runtime.shutdown();

    // The probe export is still pending, so shutdown must not have resolved
    // yet — it awaits `startPromise` (the `if (startPromise)` true branch).
    let shutdownSettled = false;
    const settledWatch = shutdownPromise.then(() => {
      shutdownSettled = true;
    });
    await flushMicrotasks();
    expect(shutdownSettled).toBe(false);

    resolveExport(okResult());
    await startPromise;
    await shutdownPromise;
    await settledWatch;
    expect(shutdownSettled).toBe(true);
  });

  it("shuts down a started provider (provider truthy branch)", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    await runtime.start();
    const providerShutdown = vi.spyOn(WebTracerProvider.prototype, "shutdown");
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(providerShutdown).toHaveBeenCalledTimes(1);
  });

  it("shuts down cleanly when start never produced a provider (provider null branch)", async () => {
    const runtime = createRendererOtelRuntime({});
    const providerShutdown = vi.spyOn(WebTracerProvider.prototype, "shutdown");

    // No exportTelemetry at all: `ensureStarted` latches terminal-noop
    // synchronously and `provider` is never assigned.
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(providerShutdown).not.toHaveBeenCalled();
  });
});

describe("createRendererOtelRuntime exception attribute omission", () => {
  it("omits the message and stacktrace attributes when sanitizing produces neither", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    await runtime.start();
    // A non-Error, non-string thrown value sanitizes to no message/stack.
    runtime.reportException({ error: undefined });
    await flushMicrotasks();

    const record = exportTelemetry.mock.calls
      .flatMap((call) => call[0].records)
      .find((entry) => entry.name === "exception") as
      | (RendererOtelBridgeRecord & {
          attributes?: Record<string, unknown>;
        })
      | undefined;
    expect(record).toBeDefined();
    expect(record?.attributes).not.toHaveProperty(
      TelemetryAttribute.ExceptionMessage
    );
    expect(record?.attributes).not.toHaveProperty(
      TelemetryAttribute.ExceptionStacktrace
    );
    expect(record?.attributes?.[TelemetryAttribute.AppExceptionOrigin]).toBe(
      AppExceptionOrigin.Renderer
    );
  });
});

describe("createRendererOtelRuntime span dropped-count omission", () => {
  it("omits dropped-count attributes entirely when every count is zero", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    await runtime.start();
    trace.getTracer("dropped-count-zero").startSpan("no-drops").end();
    await flushMicrotasks();

    const record = exportTelemetry.mock.calls
      .flatMap((call) => call[0].records)
      .find((entry) => entry.name === "no-drops");
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty("droppedAttributesCount");
    expect(record).not.toHaveProperty("droppedEventsCount");
    expect(record).not.toHaveProperty("droppedLinksCount");
  });

  it("includes dropped-count attributes when spans report non-zero drops", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    await runtime.start();
    const tracer = trace.getTracer("dropped-count-nonzero");
    const span = tracer.startSpan("has-drops");
    // Exceed the span attribute/event/link limits so the SDK increments the
    // dropped counters that the exporter's mapper then surfaces.
    for (let index = 0; index < 200; index++) {
      span.setAttribute(`attr-${index}`, index);
      span.addEvent(`event-${index}`);
      span.addLink({ context: span.spanContext() });
    }
    span.end();
    await flushMicrotasks();

    const record = exportTelemetry.mock.calls
      .flatMap((call) => call[0].records)
      .find((entry) => entry.name === "has-drops") as
      | Record<string, unknown>
      | undefined;
    expect(record).toBeDefined();
    const droppedAttributes = record?.droppedAttributesCount;
    const droppedEvents = record?.droppedEventsCount;
    const droppedLinks = record?.droppedLinksCount;
    expect(typeof droppedAttributes).toBe("number");
    expect(droppedAttributes).toBeGreaterThan(0);
    expect(typeof droppedEvents).toBe("number");
    expect(droppedEvents).toBeGreaterThan(0);
    expect(typeof droppedLinks).toBe("number");
    expect(droppedLinks).toBeGreaterThan(0);
  });
});
