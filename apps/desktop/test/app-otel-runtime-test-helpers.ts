/**
 * Shared fixtures for `app-otel-runtime.test.ts`: runtime/transport doubles,
 * renderer bridge records, the manual activity-root timer, and the resource
 * attribute reconciliation used across the suite. Extracted so the suite file
 * carries its assertions, not its scaffolding.
 */
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SpanKind,
  SpanStatusCode,
} from "@closedloop-ai/telemetry-contract/span";
import type {
  DesktopActivityRootTimerHandle,
  DesktopAppLifecycleEventInput,
  DesktopOtelRuntime,
} from "../src/main/telemetry/app-otel-runtime.js";
import type { DesktopAppLifecycleEvent } from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import type { DesktopTelemetryTransport } from "../src/main/telemetry/relay-telemetry-transport.js";
import {
  type DesktopOtelBufferedRecord,
  DesktopOtelSignal,
  RendererOtelExportFailureReason,
  type RendererOtelGenericBridgeRecord,
} from "../src/shared/renderer-otel-bridge-constants.js";

export function createThrowingTransport(): DesktopTelemetryTransport {
  return {
    start() {},
    stop() {},
    flush() {
      return Promise.resolve();
    },
    export() {
      throw new Error("relay export failed");
    },
  };
}

export function rendererTraceRecord({
  name,
  parentSpanId,
  spanId,
  traceId,
}: {
  name: string;
  parentSpanId?: string;
  spanId: string;
  traceId: string;
}): IdentifiedRendererTraceRecord {
  return {
    signal: DesktopOtelSignal.Trace,
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    kind: SpanKind.Internal,
    status: { code: SpanStatusCode.Unset },
    name,
  };
}

export function createRejectingRuntime({
  startError,
  shutdownError,
}: {
  startError?: Error;
  shutdownError?: Error;
}): DesktopOtelRuntime {
  return {
    start() {
      if (startError) {
        return Promise.reject(startError);
      }
      return Promise.resolve();
    },
    emitAppLifecycleEvent() {},
    emitAppExceptionEvent() {},
    emitIpcPerfEvent() {},
    emitSyncBatchEvent() {},
    emitImportHealthEvent() {},
    flush() {
      return Promise.resolve();
    },
    shutdown() {
      if (shutdownError) {
        return Promise.reject(shutdownError);
      }
      return Promise.resolve();
    },
    getBufferedRecords() {
      return [];
    },
    resetBuffer() {},
    exportExternalRecords() {
      return {
        ok: false,
        reason: RendererOtelExportFailureReason.Unavailable,
      };
    },
  };
}

export function createRecordingRuntime(
  onEmit: (event: DesktopAppLifecycleEvent) => void,
  onShutdown: () => void = () => {}
): DesktopOtelRuntime {
  return {
    start() {
      return Promise.resolve();
    },
    emitAppLifecycleEvent(input) {
      onEmit(input.event);
    },
    emitAppExceptionEvent() {},
    emitIpcPerfEvent() {},
    emitSyncBatchEvent() {},
    emitImportHealthEvent() {},
    flush() {
      return Promise.resolve();
    },
    shutdown() {
      onShutdown();
      return Promise.resolve();
    },
    getBufferedRecords() {
      return [];
    },
    resetBuffer() {},
    exportExternalRecords() {
      return {
        ok: false,
        reason: RendererOtelExportFailureReason.Unavailable,
      };
    },
  };
}

export function collectAppLifecycleRecords(
  runtime: DesktopOtelRuntime
): DesktopOtelBufferedRecord[] {
  return runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.signal === DesktopOtelSignal.Trace &&
        record.name === "app.lifecycle"
    );
}

export function collectResourceAttributeMismatches(
  resourceAttributes: Record<string, unknown> | undefined
): string[] {
  if (!resourceAttributes) {
    return ["resource missing"];
  }

  const mismatches: string[] = [];
  if (
    resourceAttributes[TelemetryAttribute.ServiceName] !== "closedloop-desktop"
  ) {
    mismatches.push(TelemetryAttribute.ServiceName);
  }
  if (resourceAttributes[TelemetryAttribute.ServiceVersion] !== "1.2.3") {
    mismatches.push(TelemetryAttribute.ServiceVersion);
  }
  if (
    resourceAttributes[TelemetryAttribute.AppInstallationId] !==
    "install_0123456789abcdef"
  ) {
    mismatches.push(TelemetryAttribute.AppInstallationId);
  }
  if (
    resourceAttributes[TelemetryAttribute.DeviceId] !==
    "device_0123456789abcdef"
  ) {
    mismatches.push(TelemetryAttribute.DeviceId);
  }
  if (
    resourceAttributes[TelemetryAttribute.DeploymentEnvironmentName] !==
    "desktop-prod"
  ) {
    mismatches.push(TelemetryAttribute.DeploymentEnvironmentName);
  }
  if (resourceAttributes["telemetry.sdk.name"] !== "opentelemetry") {
    mismatches.push("telemetry.sdk.name");
  }
  return mismatches;
}

export function ipcInputAt(startTimeUnixMs: number) {
  return {
    operation: "list" as const,
    startTimeUnixMs,
    durationMs: 10,
    payloadBytes: 1,
    resultCount: 1,
    sessionCount: 1,
  };
}

export function createManualTimers() {
  // Keyed by the handle the runtime actually holds, so `set`/`clear` match the
  // production `DesktopActivityRootTimerHandle` contract (the runtime calls
  // `handle.unref?.()`) instead of a handle shape only this double understands.
  const timers = new Map<DesktopActivityRootTimerHandle, () => void>();
  let lastDelayMs = 0;
  return {
    get lastDelayMs() {
      return lastDelayMs;
    },
    set(callback: () => void, delayMs: number): DesktopActivityRootTimerHandle {
      lastDelayMs = delayMs;
      const handle: DesktopActivityRootTimerHandle = {
        unref: () => undefined,
      };
      timers.set(handle, callback);
      return handle;
    },
    clear(handle: DesktopActivityRootTimerHandle) {
      timers.delete(handle);
    },
    fireLatest() {
      const latest = Array.from(timers).at(-1);
      if (latest) {
        const [handle, callback] = latest;
        timers.delete(handle);
        callback();
      }
    },
    activeCount() {
      return timers.size;
    },
  };
}

/**
 * A renderer trace record whose span identity is proven present, so callers can
 * chain a child off a parent's ids without re-narrowing the bridge-record union.
 */
export type IdentifiedRendererTraceRecord = RendererOtelGenericBridgeRecord & {
  spanId: string;
  traceId: string;
};

/**
 * A runtime double that records the FULL lifecycle input (event plus resolved
 * organization id), for the org-attribution cases `createRecordingRuntime`'s
 * event-only callback cannot express.
 */
export function createLifecycleInputRecordingRuntime(
  onEmit: (input: DesktopAppLifecycleEventInput) => void
): DesktopOtelRuntime {
  return {
    ...createRecordingRuntime(() => {}),
    emitAppLifecycleEvent: onEmit,
  };
}
