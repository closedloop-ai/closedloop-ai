/**
 * Branch-coverage tests for the ISS-6329 pending-exception retry ladder in
 * app-otel-runtime.ts, on the renderer vitest lane. Covers the retry-then-
 * recover path, the ladder-exhaustion path, and a shutdown racing a scheduled
 * retry (schedulePendingExceptionRetry's `terminalNoop` short-circuit).
 */
import { trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopOtelSignal,
  type RendererOtelBridgePayload,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
} from "../../shared/renderer-otel-bridge-constants";
import {
  createRendererOtelRuntime,
  PENDING_EXCEPTION_MAX_RETRIES,
} from "../app-otel-runtime";

type ExportTelemetry = (
  payload: RendererOtelBridgePayload
) => Promise<RendererOtelExportResult>;

function recoverableFailure(): RendererOtelExportResult {
  return {
    ok: false,
    reason: RendererOtelExportFailureReason.NotStarted,
  };
}

function okResult(): RendererOtelExportResult {
  return { ok: true, acceptedRecords: 1, droppedRecordsCount: 0 };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  trace.disable();
  vi.restoreAllMocks();
});

describe("pending exception retry ladder", () => {
  it("retries a recoverable failure and recovers once the probe succeeds", async () => {
    // Probe fails (buffering), exception queues; first retry still fails,
    // second retry succeeds and starts the runtime, draining the queue.
    const exportTelemetry = vi
      .fn<ExportTelemetry>()
      .mockResolvedValueOnce(recoverableFailure())
      .mockResolvedValueOnce(recoverableFailure())
      .mockResolvedValueOnce(okResult())
      .mockResolvedValue(okResult());
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    runtime.reportException({ error: new Error("first") });
    await flushMicrotasks();
    expect(exportTelemetry).toHaveBeenCalledTimes(1);

    // Advance well past the backoff schedule for two retries; the third
    // attempt succeeds, drains the queue, and re-probes via ensureStarted.
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();
    expect(exportTelemetry.mock.calls.length).toBeGreaterThanOrEqual(3);

    // The runtime is now started: a fresh exception goes straight through the
    // span path instead of re-queuing. The call count alone cannot tell the
    // two apart, since an unstarted runtime drains its queue immediately too;
    // only the signal does (span path = Trace, pre-start queue = Log).
    const callsBeforeDirect = exportTelemetry.mock.calls.length;
    runtime.reportException({ error: new Error("post-recovery") });
    await flushMicrotasks();
    expect(exportTelemetry).toHaveBeenCalledTimes(callsBeforeDirect + 1);
    const [directPayload] = exportTelemetry.mock.calls[callsBeforeDirect];
    expect(directPayload.records).toHaveLength(1);
    expect(directPayload.records[0]).toMatchObject({
      signal: DesktopOtelSignal.Trace,
      name: "exception",
    });
  });

  it("gives up buffering after the max retry count without going terminal", async () => {
    const exportTelemetry = vi
      .fn<ExportTelemetry>()
      .mockResolvedValue(recoverableFailure());
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    runtime.reportException({ error: new Error("never recovers") });
    await flushMicrotasks();

    for (let attempt = 0; attempt < PENDING_EXCEPTION_MAX_RETRIES; attempt++) {
      await vi.advanceTimersByTimeAsync(5000);
      await flushMicrotasks();
    }

    const callsAtLadderEnd = exportTelemetry.mock.calls.length;
    expect(callsAtLadderEnd).toBe(PENDING_EXCEPTION_MAX_RETRIES + 1);

    // Ladder spent: advancing time further schedules no more retries.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(exportTelemetry.mock.calls.length).toBe(callsAtLadderEnd);

    // terminalNoop was never latched by exhausting the ladder — a later
    // successful probe (e.g. triggered by a fresh render commit) still works.
    exportTelemetry.mockResolvedValueOnce(okResult());
    await runtime.start();
    expect(exportTelemetry.mock.calls.length).toBe(callsAtLadderEnd + 1);
  });

  it("drops a scheduled retry when shutdown latches terminal first", async () => {
    const exportTelemetry = vi
      .fn<ExportTelemetry>()
      .mockResolvedValue(recoverableFailure());
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    runtime.reportException({ error: new Error("racing shutdown") });
    await flushMicrotasks();
    expect(exportTelemetry).toHaveBeenCalledTimes(1);

    // A retry timer is now armed. Shut down before it fires: shutdown
    // synchronously clears the timer and the queue and latches terminalNoop.
    await runtime.shutdown();

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    // No further export calls: the retry never fired because shutdown
    // cleared the timer, and nothing new can queue once terminalNoop is set.
    expect(exportTelemetry).toHaveBeenCalledTimes(1);

    runtime.reportException({ error: new Error("after shutdown") });
    await flushMicrotasks();
    expect(exportTelemetry).toHaveBeenCalledTimes(1);
  });
});
