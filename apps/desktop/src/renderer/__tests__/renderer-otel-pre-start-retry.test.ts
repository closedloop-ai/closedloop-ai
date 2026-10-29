import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { trace } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRendererOtelBridgePayload } from "../../shared/renderer-otel-bridge";
import {
  type RendererOtelBridgePayload,
  type RendererOtelBridgeRecord,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
} from "../../shared/renderer-otel-bridge-constants";
import {
  createRendererOtelRuntime,
  PENDING_EXCEPTION_MAX_RETRIES,
  PENDING_EXCEPTION_QUEUE_LIMIT,
} from "../app-otel-runtime";

/**
 * ISS-6329 — one renderer exception raised while the main OTel runtime was
 * still booting used to latch `terminalNoop` and silence the window for its
 * whole life. These cover the un-latching AND its bound: the ladder has to stop
 * on its own when the runtime genuinely never comes up.
 *
 * `delivered` holds only records the fake bridge ACCEPTED, so every assertion
 * below is about telemetry that actually reached the exporter — not about a
 * call that was attempted and rejected.
 */

type ExportTelemetry = (
  payload: RendererOtelBridgePayload
) => Promise<RendererOtelExportResult>;

const RENDERER_TEST_TRACER = "renderer-pre-start-test";
const EXCEPTION_RECORD_NAME = "exception";
/** 250ms base doubling to a 4s cap over six retries, plus slack. */
const LADDER_WINDOW_MS = 60_000;
/** One immediate attempt plus `PENDING_EXCEPTION_MAX_RETRIES` scheduled ones. */
const MAX_PRE_START_BRIDGE_CALLS = PENDING_EXCEPTION_MAX_RETRIES + 1;
const MAX_QUEUED_EXCEPTIONS = PENDING_EXCEPTION_QUEUE_LIMIT;
const OVERFLOWING_EXCEPTION_COUNT = MAX_QUEUED_EXCEPTIONS + 12;
const POISON_MARKER = "unparseable-record";
/** Long enough that MAX_QUEUED_EXCEPTIONS of them cannot share one payload. */
const BULKY_STACK_FRAMES = 700;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  trace.disable();
  vi.restoreAllMocks();
});

describe("renderer OTel pre-start retry ladder", () => {
  it("reaches the bridge while the main runtime is up (positive control)", async () => {
    const bridge = createBridge({ mainRuntimeStarted: true });
    const runtime = createRendererOtelRuntime({
      exportTelemetry: bridge.exportTelemetry,
    });

    await runtime.start();
    trace.getTracer(RENDERER_TEST_TRACER).startSpan("control-span").end();
    await settle();

    expect(bridge.deliveredNames()).toContain("control-span");
  });

  it("delivers a pre-start exception once the main runtime starts", async () => {
    const bridge = createBridge({ mainRuntimeStarted: false });
    const runtime = createRendererOtelRuntime({
      exportTelemetry: bridge.exportTelemetry,
    });

    await runtime.start();
    runtime.reportException({ error: new Error("early renderer failure") });
    await settle();
    expect(bridge.deliveredNames()).not.toContain(EXCEPTION_RECORD_NAME);

    bridge.startMainRuntime();
    await vi.advanceTimersByTimeAsync(LADDER_WINDOW_MS);

    expect(bridge.deliveredNames()).toContain(EXCEPTION_RECORD_NAME);
  });

  it("delivers the re-offered exception scrubbed of PII", async () => {
    const bridge = createBridge({ mainRuntimeStarted: false });
    const runtime = createRendererOtelRuntime({
      exportTelemetry: bridge.exportTelemetry,
    });
    const error = new Error("failed for owner@example.com");
    error.stack =
      "Error: failed for owner@example.com\n    at load (file:///Users/example/Closedloop.app/main.js:4:9)";

    await runtime.start();
    runtime.reportException({ error });
    await settle();
    bridge.startMainRuntime();
    await vi.advanceTimersByTimeAsync(LADDER_WINDOW_MS);

    const exception = bridge
      .deliveredRecords()
      .find((record) => record.name === EXCEPTION_RECORD_NAME);
    expect(exception).toBeDefined();
    const serialized = JSON.stringify(exception?.attributes);
    // Anchored on surviving non-PII text so the two absence assertions below
    // cannot pass by the stacktrace simply not being there.
    expect(serialized).toContain("at load (");
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("file:///Users/example");
  });

  it("keeps emitting later spans after a pre-start exception", async () => {
    const bridge = createBridge({ mainRuntimeStarted: false });
    const runtime = createRendererOtelRuntime({
      exportTelemetry: bridge.exportTelemetry,
    });

    await runtime.start();
    runtime.reportException({ error: new Error("early renderer failure") });
    await settle();

    bridge.startMainRuntime();
    await runtime.start();
    trace.getTracer(RENDERER_TEST_TRACER).startSpan("after-the-race").end();
    await settle();

    expect(bridge.deliveredNames()).toContain("after-the-race");
  });

  it("stops re-offering when the main runtime never starts", async () => {
    const bridge = createBridge({ mainRuntimeStarted: false });
    const runtime = createRendererOtelRuntime({
      exportTelemetry: bridge.exportTelemetry,
    });

    runtime.reportException({ error: new Error("never delivered") });
    await vi.advanceTimersByTimeAsync(LADDER_WINDOW_MS);
    const callsAfterLadder = bridge.exportTelemetry.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LADDER_WINDOW_MS);

    expect(callsAfterLadder).toBe(MAX_PRE_START_BRIDGE_CALLS);
    expect(bridge.exportTelemetry).toHaveBeenCalledTimes(
      MAX_PRE_START_BRIDGE_CALLS
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still latches off on a terminal pre-start result", async () => {
    const exportTelemetry = vi.fn<ExportTelemetry>(async () => ({
      ok: false,
      reason: RendererOtelExportFailureReason.Unavailable,
    }));
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    runtime.reportException({ error: new Error("terminal") });
    await vi.advanceTimersByTimeAsync(LADDER_WINDOW_MS);
    runtime.reportException({ error: new Error("skipped") });
    await vi.advanceTimersByTimeAsync(LADDER_WINDOW_MS);

    expect(exportTelemetry).toHaveBeenCalledTimes(1);
  });

  it("delivers every queued exception when one merged batch would exceed the payload cap", async () => {
    // Drives the REAL main-side parser, so the 64KB whole-payload cap and the
    // batch-fails-on-one-bad-record rule are production's, not this test's.
    const bridge = createParsingBridge({ mainRuntimeStarted: false });
    const runtime = createRendererOtelRuntime({
      exportTelemetry: bridge.exportTelemetry,
    });

    for (let index = 0; index < MAX_QUEUED_EXCEPTIONS; index += 1) {
      runtime.reportException({ error: bulkyError(index) });
    }
    await settle();
    bridge.startMainRuntime();
    await vi.advanceTimersByTimeAsync(LADDER_WINDOW_MS);

    const delivered = bridge
      .deliveredNames()
      .filter((name) => name === EXCEPTION_RECORD_NAME);
    expect(delivered.length).toBe(MAX_QUEUED_EXCEPTIONS);
  });

  it("drops an unparseable record without burning the ladder for the next one", async () => {
    let mainRuntimeStarted = false;
    const delivered: RendererOtelBridgeRecord[] = [];
    const exportTelemetry = vi.fn<ExportTelemetry>((payload) => {
      const message = exceptionMessageOf(payload.records[0]);
      if (message.includes(POISON_MARKER)) {
        return Promise.resolve({
          ok: false,
          reason: RendererOtelExportFailureReason.InvalidPayload,
        });
      }
      if (!mainRuntimeStarted) {
        return Promise.resolve({
          ok: false,
          reason: RendererOtelExportFailureReason.NotStarted,
        });
      }
      delivered.push(...payload.records);
      return Promise.resolve({
        ok: true,
        acceptedRecords: payload.records.length,
        droppedRecordsCount: 0,
      });
    });
    const runtime = createRendererOtelRuntime({ exportTelemetry });

    runtime.reportException({ error: new Error(POISON_MARKER) });
    runtime.reportException({ error: new Error("well formed neighbour") });
    await settle();
    mainRuntimeStarted = true;
    await vi.advanceTimersByTimeAsync(LADDER_WINDOW_MS);

    const poisonAttempts = exportTelemetry.mock.calls.filter(([payload]) =>
      exceptionMessageOf(payload.records[0]).includes(POISON_MARKER)
    );
    const deliveredExceptions = delivered.filter(
      (record) => record.name === EXCEPTION_RECORD_NAME
    );
    expect(poisonAttempts).toHaveLength(1);
    expect(deliveredExceptions).toHaveLength(1);
    expect(exceptionMessageOf(deliveredExceptions[0])).toContain(
      "well formed neighbour"
    );
  });

  it("bounds the pre-start queue while the main runtime is down", async () => {
    const bridge = createBridge({ mainRuntimeStarted: false });
    const runtime = createRendererOtelRuntime({
      exportTelemetry: bridge.exportTelemetry,
    });

    for (let index = 0; index < OVERFLOWING_EXCEPTION_COUNT; index += 1) {
      runtime.reportException({ error: new Error(`overflow ${index}`) });
    }
    await settle();

    bridge.startMainRuntime();
    await vi.advanceTimersByTimeAsync(LADDER_WINDOW_MS);

    const messages = bridge
      .deliveredRecords()
      .filter((record) => record.name === EXCEPTION_RECORD_NAME)
      .map(exceptionMessageOf);
    // Exactly the cap, and specifically the OLDEST ones — the documented
    // overflow policy. A `<=` assertion here would pass for any cap from 1 to 8.
    expect(messages).toHaveLength(MAX_QUEUED_EXCEPTIONS);
    for (let index = 0; index < MAX_QUEUED_EXCEPTIONS; index += 1) {
      expect(messages[index]).toContain(`overflow ${index}`);
    }
  });

  it("drops the pending queue and its retry timer on shutdown", async () => {
    const bridge = createBridge({ mainRuntimeStarted: false });
    const runtime = createRendererOtelRuntime({
      exportTelemetry: bridge.exportTelemetry,
    });

    runtime.reportException({ error: new Error("abandoned") });
    await settle();
    expect(vi.getTimerCount()).toBe(1);

    await runtime.shutdown();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LADDER_WINDOW_MS);
    expect(bridge.exportTelemetry).toHaveBeenCalledTimes(1);
  });
});

function createBridge({ mainRuntimeStarted }: { mainRuntimeStarted: boolean }) {
  let started = mainRuntimeStarted;
  const delivered: RendererOtelBridgeRecord[] = [];
  const exportTelemetry = vi.fn<ExportTelemetry>((payload) => {
    if (!started) {
      return Promise.resolve({
        ok: false,
        reason: RendererOtelExportFailureReason.NotStarted,
      });
    }
    delivered.push(...payload.records);
    return Promise.resolve({
      ok: true,
      acceptedRecords: payload.records.length,
      droppedRecordsCount: 0,
    });
  });

  return {
    exportTelemetry,
    startMainRuntime() {
      started = true;
    },
    deliveredNames(): (string | undefined)[] {
      return delivered.map((record) => record.name);
    },
    deliveredRecords(): RendererOtelBridgeRecord[] {
      return delivered;
    },
  };
}

/**
 * Drives the REAL main-side parser, so the 64KB whole-payload cap and the
 * fails-the-whole-batch-on-one-bad-record rule under test are production's.
 */
function createParsingBridge({
  mainRuntimeStarted,
}: {
  mainRuntimeStarted: boolean;
}) {
  let started = mainRuntimeStarted;
  const delivered: RendererOtelBridgeRecord[] = [];
  const exportTelemetry = vi.fn<ExportTelemetry>((payload) => {
    const parsed = parseRendererOtelBridgePayload(payload);
    if (!parsed.ok) {
      return Promise.resolve(parsed.result);
    }
    if (!started) {
      return Promise.resolve({
        ok: false,
        reason: RendererOtelExportFailureReason.NotStarted,
      });
    }
    delivered.push(...parsed.payload.records);
    return Promise.resolve({
      ok: true,
      acceptedRecords: parsed.payload.records.length,
      droppedRecordsCount: 0,
    });
  });

  return {
    exportTelemetry,
    startMainRuntime() {
      started = true;
    },
    deliveredNames(): (string | undefined)[] {
      return delivered.map((record) => record.name);
    },
  };
}

function bulkyError(index: number): Error {
  const error = new Error(`bulky ${index}`);
  error.stack = `Error: bulky ${index}\n${"    at frame ()\n".repeat(
    BULKY_STACK_FRAMES
  )}`;
  return error;
}

/** The attributes union is not indexable by an exception key without this. */
function exceptionMessageOf(
  record: RendererOtelBridgeRecord | undefined
): string {
  const attributes: Record<string, unknown> = record?.attributes ?? {};
  const message = attributes[TelemetryAttribute.ExceptionMessage];
  return typeof message === "string" ? message : "";
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
