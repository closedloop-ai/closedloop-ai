import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RendererRenderCause,
  RendererRenderPhase,
  RendererRenderView,
} from "../../shared/render-commit-event";
import {
  DesktopOtelSignal,
  RendererOtelAllowedAttributeKey,
  type RendererOtelBridgePayload,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
} from "../../shared/renderer-otel-bridge-constants";
import { createRendererOtelRuntime } from "../app-otel-runtime";

type ExportTelemetry = (
  payload: RendererOtelBridgePayload
) => Promise<RendererOtelExportResult>;

afterEach(() => {
  trace.disable();
  vi.restoreAllMocks();
});

describe("renderer OTel runtime", () => {
  it("does not start or export when the bridge is missing", async () => {
    const runtime = createRendererOtelRuntime({});

    await runtime.start();
    runtime.reportException({ error: new Error("not exported") });
    trace.getTracer("renderer-test").startSpan("not-exported").end();
    await flushMicrotasks();

    expect(true).toBe(true);
  });

  it("exports scrubbed renderer exceptions through the bridge", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({ exportTelemetry });
    const error = new Error("Renderer failed");
    error.stack = "Error: failed at /Users/example/project/app.ts";

    runtime.reportException({ error });
    await flushMicrotasks();

    expect(exportTelemetry).toHaveBeenCalledTimes(1);
    expect(exportTelemetry.mock.calls[0]?.[0]).toEqual({
      records: [
        {
          signal: DesktopOtelSignal.Log,
          name: "exception",
          attributes: {
            [TelemetryAttribute.ExceptionType]: "Error",
            [TelemetryAttribute.ExceptionMessage]: "Renderer failed",
            [TelemetryAttribute.ExceptionStacktrace]: "[redacted]",
            [TelemetryAttribute.AppExceptionOrigin]:
              AppExceptionOrigin.Renderer,
          },
        },
      ],
    });
  });

  it("exports React boundary component stack as the scrubbed stack field", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    runtime.reportException({
      error: new Error("Boundary failed"),
      componentStack: ["Root", "    at Dashboard (panel.tsx:10:2)"].join("\n"),
    });
    await flushMicrotasks();

    expect(exportTelemetry.mock.calls[0]?.[0].records[0]).toMatchObject({
      signal: DesktopOtelSignal.Log,
      name: "exception",
      attributes: {
        [TelemetryAttribute.ExceptionMessage]: "Boundary failed",
        [TelemetryAttribute.ExceptionStacktrace]:
          "Root at Dashboard (panel.tsx:10:2)",
        [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
      },
    });
  });

  it("starts once and exports spans through the bridge without resource attributes", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    await runtime.start();
    await runtime.start();
    trace
      .getTracer("renderer-test", "1.0.0")
      .startSpan("renderer.visible", {
        attributes: { [RendererOtelAllowedAttributeKey.Mode]: "unit" },
      })
      .end();
    await flushMicrotasks();

    expect(exportTelemetry).toHaveBeenCalledTimes(2);
    expect(exportTelemetry.mock.calls[0]?.[0]).toEqual({
      records: [
        {
          signal: DesktopOtelSignal.Trace,
          instrumentationScope: { name: "closedloop-desktop-renderer" },
          name: "desktop.renderer.otel.bootstrap",
        },
      ],
    });
    const spanPayload = exportTelemetry.mock.calls[1]?.[0];
    expect(spanPayload?.records[0]).toMatchObject({
      signal: DesktopOtelSignal.Trace,
      instrumentationScope: { name: "renderer-test", version: "1.0.0" },
      name: "renderer.visible",
      attributes: { [RendererOtelAllowedAttributeKey.Mode]: "unit" },
    });
    expect("resourceAttributes" in (spanPayload?.records[0] ?? {})).toBe(false);
  });

  it("treats disabled probe results as terminal for the renderer session", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => ({
      ok: false,
      reason: RendererOtelExportFailureReason.Disabled,
    }));
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    await runtime.start();
    await runtime.start();
    trace.getTracer("renderer-test").startSpan("after-disabled").end();
    await flushMicrotasks();

    expect(exportTelemetry).toHaveBeenCalledTimes(1);
  });

  it("stops later bridge calls after an unavailable export result", async () => {
    const exportTelemetry = vi
      .fn<ExportTelemetry>()
      .mockResolvedValueOnce(okResult())
      .mockResolvedValueOnce({
        ok: false,
        reason: RendererOtelExportFailureReason.Unavailable,
      });
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    await runtime.start();
    trace.getTracer("renderer-test").startSpan("terminal").end();
    await flushMicrotasks();
    trace.getTracer("renderer-test").startSpan("skipped").end();
    await flushMicrotasks();

    expect(exportTelemetry).toHaveBeenCalledTimes(2);
  });

  it("stops later exception bridge calls after a terminal result", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => ({
      ok: false,
      reason: RendererOtelExportFailureReason.Unavailable,
    }));
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    runtime.reportException({ error: new Error("terminal") });
    await flushMicrotasks();
    runtime.reportException({ error: new Error("skipped") });
    await flushMicrotasks();

    expect(exportTelemetry).toHaveBeenCalledTimes(1);
  });

  it("swallows bridge rejections without crashing renderer startup", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(() =>
      Promise.reject(new Error("bridge unavailable"))
    );
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(exportTelemetry).toHaveBeenCalledTimes(1);
  });

  it("swallows bridge rejections from exception reporting", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(() =>
      Promise.reject(new Error("bridge unavailable"))
    );
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    expect(() =>
      runtime.reportException({ error: new Error("bridge unavailable") })
    ).not.toThrow();
    await flushMicrotasks();

    expect(exportTelemetry).toHaveBeenCalledTimes(1);
  });
});

describe("renderer render-commit telemetry", () => {
  const baseEvent = {
    view: RendererRenderView.SessionsList,
    cause: RendererRenderCause.Paginate,
    itemCount: 25,
    actualMs: 8.27,
    baseMs: 14.55,
  } as const;

  it("exports a mount commit as a Log wide event even when sampling would drop it", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({
      exportTelemetry,
      renderCommitSampler: () => false,
    });

    runtime.reportRenderCommit({
      ...baseEvent,
      phase: RendererRenderPhase.Mount,
      cause: RendererRenderCause.Mount,
    });
    await flushMicrotasks();

    expect(exportTelemetry).toHaveBeenCalledTimes(1);
    expect(exportTelemetry.mock.calls[0]?.[0].records[0]).toEqual({
      signal: DesktopOtelSignal.Log,
      instrumentationScope: { name: "closedloop-desktop-renderer" },
      name: "desktop.renderer.render_commit.sessions_list",
      attributes: {
        [RendererOtelAllowedAttributeKey.Values]: [8.3, 14.6],
        [RendererOtelAllowedAttributeKey.Count]: 25,
        [RendererOtelAllowedAttributeKey.Mode]: "mount",
        [RendererOtelAllowedAttributeKey.Status]: "mount",
      },
    });
  });

  it("drops a sampled-out update commit", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({
      exportTelemetry,
      renderCommitSampler: () => false,
    });

    runtime.reportRenderCommit({
      ...baseEvent,
      phase: RendererRenderPhase.Update,
    });
    await flushMicrotasks();

    expect(exportTelemetry).not.toHaveBeenCalled();
  });

  it("keeps a sampled-in update commit", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({
      exportTelemetry,
      renderCommitSampler: () => true,
    });

    runtime.reportRenderCommit({
      ...baseEvent,
      phase: RendererRenderPhase.Update,
    });
    await flushMicrotasks();

    expect(exportTelemetry).toHaveBeenCalledTimes(1);
    expect(exportTelemetry.mock.calls[0]?.[0].records[0]).toMatchObject({
      name: "desktop.renderer.render_commit.sessions_list",
      attributes: { [RendererOtelAllowedAttributeKey.Mode]: "paginate" },
    });
  });

  it("head-samples nested-update commits like ordinary updates (only mount bypasses)", async () => {
    const dropped = vi.fn<ExportTelemetry>(async () => okResult());
    const droppedRuntime = createRendererOtelRuntime({
      exportTelemetry: dropped,
      renderCommitSampler: () => false,
    });
    droppedRuntime.reportRenderCommit({
      ...baseEvent,
      phase: RendererRenderPhase.NestedUpdate,
    });
    await flushMicrotasks();
    expect(dropped).not.toHaveBeenCalled();

    const kept = vi.fn<ExportTelemetry>(async () => okResult());
    const keptRuntime = createRendererOtelRuntime({
      exportTelemetry: kept,
      renderCommitSampler: () => true,
    });
    keptRuntime.reportRenderCommit({
      ...baseEvent,
      phase: RendererRenderPhase.NestedUpdate,
    });
    await flushMicrotasks();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it("uses the default Math.random sampler when none is injected", async () => {
    const randomSpy = vi.spyOn(Math, "random");
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => okResult());
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    // Below the 0.1 rate → kept.
    randomSpy.mockReturnValue(0.05);
    runtime.reportRenderCommit({
      ...baseEvent,
      phase: RendererRenderPhase.Update,
    });
    await flushMicrotasks();
    expect(exportTelemetry).toHaveBeenCalledTimes(1);

    // At/above the 0.1 rate → dropped.
    randomSpy.mockReturnValue(0.5);
    runtime.reportRenderCommit({
      ...baseEvent,
      phase: RendererRenderPhase.Update,
    });
    await flushMicrotasks();
    expect(exportTelemetry).toHaveBeenCalledTimes(1);
  });

  it("does not export render commits when the bridge is missing", async () => {
    const runtime = createRendererOtelRuntime({
      renderCommitSampler: () => true,
    });

    expect(() =>
      runtime.reportRenderCommit({
        ...baseEvent,
        phase: RendererRenderPhase.Mount,
      })
    ).not.toThrow();
    await flushMicrotasks();
  });

  it("stops exporting render commits after a terminal bridge result", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => ({
      ok: false,
      reason: RendererOtelExportFailureReason.Unavailable,
    }));
    const runtime = createRendererOtelRuntime({
      exportTelemetry,
      renderCommitSampler: () => true,
    });

    runtime.reportRenderCommit({
      ...baseEvent,
      phase: RendererRenderPhase.Mount,
    });
    await flushMicrotasks();
    runtime.reportRenderCommit({
      ...baseEvent,
      phase: RendererRenderPhase.Mount,
    });
    await flushMicrotasks();

    expect(exportTelemetry).toHaveBeenCalledTimes(1);
  });

  it("swallows bridge rejections from render-commit reporting", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(() =>
      Promise.reject(new Error("bridge unavailable"))
    );
    const runtime = createRendererOtelRuntime({
      exportTelemetry,
      renderCommitSampler: () => true,
    });

    expect(() =>
      runtime.reportRenderCommit({
        ...baseEvent,
        phase: RendererRenderPhase.Mount,
      })
    ).not.toThrow();
    await flushMicrotasks();

    expect(exportTelemetry).toHaveBeenCalledTimes(1);
  });
});

function okResult(): RendererOtelExportResult {
  return {
    ok: true,
    acceptedRecords: 1,
    droppedRecordsCount: 0,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
