/**
 * Shared fixtures for the `app-otel-runtime*` suites: runtime/transport doubles,
 * renderer bridge records, the manual activity-root timer, the tracked-runtime
 * factory with its teardown, and the resource attribute reconciliation used
 * across them. Extracted so each suite file carries its assertions, not its
 * scaffolding.
 */
import {
  TelemetryAttribute,
  TelemetryServiceName,
} from "@closedloop-ai/telemetry-contract/attributes";
import {
  SpanKind,
  SpanStatusCode,
} from "@closedloop-ai/telemetry-contract/span";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  createDesktopOtelRuntime,
  type DesktopActivityRootTimerHandle,
  type DesktopAppLifecycleEventInput,
  type DesktopOtelRuntime,
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
    emitSanitizedAppExceptionEvent() {},
    emitIpcPerfEvent() {},
    emitSyncBatchEvent() {},
    emitImportHealthEvent() {},
    emitAuthFailureEvent() {
      return false;
    },
    emitDeadEndEvent() {
      return true;
    },
    emitOnboardingEvent() {},
    emitOnboardingDiscardEvent() {},
    emitGenAiRequestEvent() {},
    emitUpdateEvent() {
      return true;
    },
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
    emitSanitizedAppExceptionEvent() {},
    emitIpcPerfEvent() {},
    emitSyncBatchEvent() {},
    emitImportHealthEvent() {},
    emitAuthFailureEvent() {
      return false;
    },
    emitDeadEndEvent() {
      return true;
    },
    emitOnboardingEvent() {},
    emitOnboardingDiscardEvent() {},
    emitGenAiRequestEvent() {},
    emitUpdateEvent() {
      return true;
    },
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
  runtime: DesktopOtelRuntime,
  signal: DesktopOtelSignal = DesktopOtelSignal.Trace
): DesktopOtelBufferedRecord[] {
  return runtime
    .getBufferedRecords()
    .filter(
      (record) => record.signal === signal && record.name === "app.lifecycle"
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
    resourceAttributes[TelemetryAttribute.ServiceName] !==
    TelemetryServiceName.Desktop
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

/**
 * A REAL `DesktopOtelRuntime` on the in-memory buffer transport, with the
 * defaults every suite here shares.
 *
 * Shared rather than duplicated because `pre-init-crash-capture.test.ts` needs
 * the same real runtime: its stub double cannot show that a queued record
 * survives schema validation, carries its capture timestamp through to the
 * span, or is dropped whole when the origin is not a contract member.
 */
export function createRealTestRuntime(
  options: Partial<Parameters<typeof createDesktopOtelRuntime>[0]> = {}
): DesktopOtelRuntime {
  return createDesktopOtelRuntime({
    appVersion: "0.0.0-test",
    bufferLimit: 100,
    env: {},
    getAppInstallationId: () => "install_test",
    getDeviceId: () => "device_0123456789abcdef",
    isPackaged: false,
    metricExportIntervalMs: 60_000,
    ...options,
  });
}

/**
 * The runtime tracker every `app-otel-runtime*` suite needs: a factory that
 * remembers the runtime it last built, plus the teardown that shuts it down and
 * clears the OTel global providers.
 *
 * Shared rather than re-declared per suite because the teardown's two halves are
 * separable and only one of them is loud. Forgetting `runtime.shutdown()` leaks
 * a timer into the suite that forgot it; forgetting `trace/metrics/logs.disable()`
 * leaves a registered global provider behind, and node:test runs a file per
 * process while Vitest's node lane shares one across a fork — so the cost of a
 * half-copied teardown is the NEXT suite's first assertion, in a file that did
 * nothing wrong.
 */
export function createTrackedRuntimeFactory(): {
  createTestRuntime: (
    options?: Parameters<typeof createRealTestRuntime>[0]
  ) => DesktopOtelRuntime;
  resetTrackedRuntime: () => Promise<void>;
} {
  let activeRuntime: DesktopOtelRuntime | null = null;
  return {
    createTestRuntime(options = {}) {
      activeRuntime = createRealTestRuntime(options);
      return activeRuntime;
    },
    async resetTrackedRuntime() {
      await activeRuntime?.shutdown();
      activeRuntime = null;
      trace.disable();
      metrics.disable();
      logs.disable();
    },
  };
}

/**
 * A lifecycle `setIntervalFn` that hands back its callback instead of
 * scheduling it, so a heartbeat is driven by the test rather than by a clock.
 */
export function manualHeartbeat() {
  const held: { callback: (() => void) | null } = { callback: null };
  return {
    setIntervalFn: (callback: () => void) => {
      held.callback = callback;
      return {};
    },
    tick: () => held.callback?.(),
  };
}
