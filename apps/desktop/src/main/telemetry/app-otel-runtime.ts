import { AppTelemetrySchema } from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { createEmit } from "@closedloop-ai/telemetry-contract/emit";
import { IpcTelemetrySchema } from "@closedloop-ai/telemetry-contract/ipc";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import {
  type SyncReason,
  SyncTelemetrySchema,
} from "@closedloop-ai/telemetry-contract/sync";
import {
  type Attributes,
  type Context,
  context,
  SpanStatusCode as OTelSpanStatusCode,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  trace,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  CompositePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  type DesktopExceptionTelemetryInput,
  sanitizeDesktopException,
} from "../../shared/exception-sanitizer.js";
import {
  type DesktopOtelBufferedRecord,
  type RendererOtelBridgeRecord,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
} from "../../shared/renderer-otel-bridge-constants.js";
import {
  containsControlCharacter,
  hasSpanIdentity,
  normalizeAttributes,
} from "../../shared/renderer-otel-bridge-utils.js";
import {
  isUsableDesktopServiceVersion,
  UNRESOLVED_DESKTOP_SERVICE_VERSION,
} from "../util/desktop-service-version.js";
import {
  buildImportHealthRecord,
  type DesktopImportHealthEventInput,
  IMPORT_HEALTH_LOGGER_NAME,
} from "./app-otel-runtime-import-health.js";
import {
  DesktopAppLifecycleEvent,
  DesktopAppOperatingMode,
} from "./app-otel-runtime-lifecycle.js";
import {
  DesktopOtelLocalBuffer,
  DesktopOtelLogRecordExporter,
  DesktopOtelMetricExporter,
  DesktopOtelSpanExporter,
} from "./local-buffer-otel-exporters.js";
import {
  createRelayOtlpExporters,
  exportRendererBridgeTraceRecordsToRelay,
} from "./relay-otlp-exporters.js";
import type { DesktopTelemetryTransport } from "./relay-telemetry-transport.js";

export const DesktopOtelRuntimeState = {
  Idle: "idle",
  Disabled: "disabled",
  Starting: "starting",
  Started: "started",
  Failed: "failed",
  Shutdown: "shutdown",
} as const;

export type DesktopOtelRuntimeState =
  (typeof DesktopOtelRuntimeState)[keyof typeof DesktopOtelRuntimeState];

export type DesktopOtelRuntime = {
  start: () => Promise<void>;
  emitAppLifecycleEvent: (input: DesktopAppLifecycleEventInput) => void;
  emitAppExceptionEvent: (input: DesktopAppExceptionEventInput) => void;
  emitIpcPerfEvent: (input: DesktopIpcPerfEventInput) => void;
  emitSyncBatchEvent: (input: DesktopSyncBatchEventInput) => void;
  emitImportHealthEvent: (input: DesktopImportHealthEventInput) => void;
  /**
   * Push everything already emitted onto the wire without shutting the runtime
   * down (ISS-6328). Production uses Batch processors with a ~5s delay, so a
   * crash handler that emits and then exits loses the exception unless it
   * awaits this first. Best-effort and never throws; the CALLER owns the time
   * cap, since a wedged relay socket must not delay a crash exit.
   */
  flush: () => Promise<void>;
  shutdown: () => Promise<void>;
  getBufferedRecords: () => DesktopOtelBufferedRecord[];
  resetBuffer: () => void;
  exportExternalRecords: (
    records: RendererOtelBridgeRecord[]
  ) => RendererOtelExportResult;
};

export type DesktopAppLifecycleEventInput = {
  event: DesktopAppLifecycleEvent;
  operatingMode: DesktopAppOperatingMode;
  /**
   * Authenticated organization id (multiplayer org attribution, FEA-1996).
   * Present only when the install is authenticated; omitted in single-player so
   * unauthenticated lifecycle telemetry never carries org identity.
   */
  organizationId?: string;
};

export type DesktopAppExceptionEventInput = DesktopExceptionTelemetryInput;

/** Instrumented Agent Dashboard IPC handlers carrying perf wide events (FEA-1997). */
export const DesktopIpcOperation = {
  List: "list",
  Detail: "detail",
  Usage: "usage",
} as const;

export type DesktopIpcOperation =
  (typeof DesktopIpcOperation)[keyof typeof DesktopIpcOperation];

export type DesktopIpcPerfEventInput = {
  operation: DesktopIpcOperation;
  /** Wall-clock span start (epoch ms); span duration is exactly `durationMs`. */
  startTimeUnixMs: number;
  /** Measured handler duration in whole milliseconds (already rounded). */
  durationMs: number;
  payloadBytes: number;
  resultCount: number;
  sessionCount: number;
  /** Set only when the handler threw; marks the span ERROR for tail retention. */
  errorType?: string;
};

export const DesktopSyncBatchOutcome = {
  Success: "success",
  Failure: "failure",
  DeadLetter: "dead_letter",
} as const;

/**
 * Transport-health outcome of a single agent-session sync batch (FEA-1995). The
 * permanent-removal class (`dead_letter`) is the oversized-session wedge the
 * sync service drops after the >256 KiB cap or repeated ack timeouts/rate
 * limits; the dashboard surfaces it instead of waiting for a user complaint.
 */
export type DesktopSyncBatchOutcome =
  (typeof DesktopSyncBatchOutcome)[keyof typeof DesktopSyncBatchOutcome];

/**
 * Strictly transport-health (PRD-468/FEA-1981 guardrail): counts, bytes,
 * latency, outcome, and reason only — never session ids or content. `latencyMs`
 * is omitted for dead-letters dropped before any send (no round-trip occurred).
 * `reason` (FEA-3426) names why a `failure`/`dead_letter` batch failed and is
 * omitted for `success`; it is the closed `SyncReason` enum from the contract.
 */
export type DesktopSyncBatchEventInput = {
  outcome: DesktopSyncBatchOutcome;
  payloadBytes: number;
  latencyMs?: number;
  reason?: SyncReason;
};

export type CreateDesktopOtelRuntimeOptions = {
  appVersion: string;
  env: NodeJS.ProcessEnv;
  getAppInstallationId: () => string | Promise<string>;
  getDeviceId?: () => string | Promise<string>;
  getOperatingMode?: () => DesktopAppOperatingMode;
  getOrganizationId?: () => string | undefined;
  isPackaged: boolean;
  bufferLimit?: number;
  metricExportIntervalMs?: number;
  setActivityRootTimeout?: (
    callback: () => void,
    delayMs: number
  ) => DesktopActivityRootTimerHandle;
  clearActivityRootTimeout?: (handle: DesktopActivityRootTimerHandle) => void;
  /**
   * Keyless relay egress (FEA-1993). When provided, SDK signals are serialized
   * to OTLP protobuf and shipped over the relay via Batch processors instead of
   * the local buffer. When omitted, the local-buffer exporters are used (the
   * FEA-1983 behavior retained for tests/dev and the renderer bridge).
   */
  telemetryTransport?: DesktopTelemetryTransport;
};

const DEFAULT_BUFFER_LIMIT = 1000;
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;
const DEPLOYMENT_ENVIRONMENT_MAX_LENGTH = 128;
const OTEL_DISABLED_VALUES = new Set(["1", "true", "yes"]);
const APP_LIFECYCLE_EVENT_NAME = "app.lifecycle";
const APP_EXCEPTION_EVENT_NAME = "exception";
const SYNC_BATCH_EVENT_NAME = "sync.batch";
const APP_LIFECYCLE_LOGGER_NAME = "closedloop-desktop-app-lifecycle";
const APP_LIFECYCLE_TRACER_NAME = "closedloop-desktop-app-lifecycle";
const IPC_PERF_TRACER_NAME = "closedloop-desktop-ipc";
const IPC_PERF_SPAN_NAME_PREFIX = "ipc.";
export const DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS = 5 * 60_000;
export const DESKTOP_ACTIVITY_ROOT_IDLE_TIMEOUT_MS = 30_000;
const DESKTOP_ACTIVITY_ROOT_TRACER_NAME = "closedloop-desktop-activity";
const DESKTOP_ACTIVITY_ROOT_SPAN_NAME = "cl-desktop";
const SYNC_TRACER_NAME = "closedloop-desktop-sync";
const SERVICE_NAME = "closedloop-desktop";
const DESKTOP_TRACE_CONTEXT_PROPAGATOR = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator()],
});

export type DesktopActivityRootTimerHandle =
  | ReturnType<typeof setTimeout>
  | { unref?: () => void };

export function createDesktopOtelRuntime(
  options: CreateDesktopOtelRuntimeOptions
): DesktopOtelRuntime {
  const buffer = new DesktopOtelLocalBuffer(
    options.bufferLimit ?? DEFAULT_BUFFER_LIMIT
  );
  let state: DesktopOtelRuntimeState = DesktopOtelRuntimeState.Idle;
  let startPromise: Promise<void> | null = null;
  let sdk: NodeSDK | null = null;
  let resourceAttributesSnapshot: Attributes | null = null;
  const rendererTraceContexts = new Map<string, SpanContext>();
  let deviceIdSnapshot: string | undefined;
  let activityRoot: DesktopActivityRoot | null = null;
  /**
   * Drain pending SDK batches and in-flight relay sends. Null on the
   * local-buffer path, where the exporters append synchronously and there is
   * nothing to wait for.
   */
  let flushPendingSignals: (() => Promise<void>) | null = null;

  return {
    start() {
      if (
        state === DesktopOtelRuntimeState.Disabled ||
        state === DesktopOtelRuntimeState.Started ||
        state === DesktopOtelRuntimeState.Shutdown
      ) {
        return Promise.resolve();
      }
      if (startPromise) {
        return startPromise;
      }

      startPromise = startRuntime()
        .catch((error) => {
          sdk = null;
          deviceIdSnapshot = undefined;
          resourceAttributesSnapshot = null;
          flushPendingSignals = null;
          state = DesktopOtelRuntimeState.Failed;
          throw error;
        })
        .finally(() => {
          startPromise = null;
        });
      return startPromise;
    },
    emitAppLifecycleEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        const attributes = AppTelemetrySchema.parse({
          [TelemetryAttribute.AppLifecycleEvent]: input.event,
          [TelemetryAttribute.AppOperatingMode]: input.operatingMode,
          ...(input.organizationId
            ? { [TelemetryAttribute.AppOrganizationId]: input.organizationId }
            : {}),
        });
        if (input.event === DesktopAppLifecycleEvent.Heartbeat) {
          // Heartbeat is high-frequency liveness, not a useful trace child.
          createEmit(
            createDesktopOtelLogEmitChannel(APP_LIFECYCLE_LOGGER_NAME)
          )(TelemetrySchemaName.App, {
            name: APP_LIFECYCLE_EVENT_NAME,
            attributes,
          });
          return;
        }
        emitChildSpan({
          attributes,
          name: APP_LIFECYCLE_EVENT_NAME,
          tracerName: APP_LIFECYCLE_TRACER_NAME,
        });
      } catch {
        // Lifecycle telemetry is best-effort and must not affect boot/shutdown.
      }
    },
    emitAppExceptionEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        const attributes = AppTelemetrySchema.parse(
          sanitizeDesktopException(input)
        );
        emitChildSpan({
          attributes,
          name: APP_EXCEPTION_EVENT_NAME,
          status: { code: OTelSpanStatusCode.ERROR },
          tracerName: APP_LIFECYCLE_TRACER_NAME,
        });
      } catch {
        // Exception telemetry is best-effort. It must never affect process
        // crash handling, renderer reporting, or Desktop shutdown paths.
      }
    },
    emitIpcPerfEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        // Validate against the closed-world ipc contract; an out-of-range value
        // (negative count, over-cap duration) throws and is swallowed below
        // rather than shipping a malformed wide event.
        const attributes = IpcTelemetrySchema.parse({
          [TelemetryAttribute.IpcOperation]: input.operation,
          [TelemetryAttribute.DurationMs]: input.durationMs,
          [TelemetryAttribute.IpcPayloadBytes]: input.payloadBytes,
          [TelemetryAttribute.IpcResultCount]: input.resultCount,
          [TelemetryAttribute.IpcSessionCount]: input.sessionCount,
          ...(input.errorType
            ? { [TelemetryAttribute.ErrorType]: input.errorType }
            : {}),
        });
        // Wide event = one span. Span duration (end - start) is the source of
        // truth the collector tail-sampling latency policy reads; duration_ms is
        // also carried as an explicit, flat query dimension.
        emitChildSpan({
          attributes,
          durationMs: input.durationMs,
          name: `${IPC_PERF_SPAN_NAME_PREFIX}${input.operation}`,
          startTimeUnixMs: input.startTimeUnixMs,
          status: input.errorType
            ? {
                code: OTelSpanStatusCode.ERROR,
                message: input.errorType,
              }
            : undefined,
          tracerName: IPC_PERF_TRACER_NAME,
        });
      } catch {
        // IPC perf telemetry is best-effort and must never affect the handler
        // result it wraps.
      }
    },
    emitSyncBatchEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        // `.strict()` closed-world validation rejects any attribute outside the
        // sync.* transport-health keys, so a regression that tried to attach
        // session content would throw here rather than leak it.
        const attributes = SyncTelemetrySchema.parse({
          [TelemetryAttribute.SyncEvent]: "batch",
          [TelemetryAttribute.SyncOutcome]: input.outcome,
          [TelemetryAttribute.SyncPayloadBytes]: input.payloadBytes,
          ...(input.latencyMs === undefined
            ? {}
            : { [TelemetryAttribute.SyncLatencyMs]: input.latencyMs }),
          ...(input.reason === undefined
            ? {}
            : { [TelemetryAttribute.SyncReason]: input.reason }),
        });
        emitChildSpan({
          attributes,
          durationMs: input.latencyMs,
          name: SYNC_BATCH_EVENT_NAME,
          startTimeUnixMs:
            input.latencyMs === undefined
              ? undefined
              : Date.now() - input.latencyMs,
          status:
            input.outcome === DesktopSyncBatchOutcome.Success
              ? undefined
              : syncBatchErrorStatus(input.reason),
          tracerName: SYNC_TRACER_NAME,
        });
      } catch {
        // Transport-health telemetry is best-effort. A schema rejection must
        // never propagate into the sync loop's catch (where it would log a
        // misleading "sync failed" for a batch that actually succeeded) or
        // otherwise affect sync semantics. Mirrors emitAppExceptionEvent.
      }
    },
    emitImportHealthEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        // Log records (not spans) — these are low-frequency counters, mirroring
        // the lifecycle heartbeat's channel. The builder's `.strict()` parse is
        // what keeps anything but the import.* counts off the wire.
        createEmit(createDesktopOtelLogEmitChannel(IMPORT_HEALTH_LOGGER_NAME))(
          TelemetrySchemaName.App,
          buildImportHealthRecord(input)
        );
      } catch {
        // Import-health telemetry is best-effort per the desktop exporter
        // boundary rule: a serialization/dispatch failure must never throw
        // through this export API or affect the import pipeline it describes.
      }
    },
    async flush() {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }
      try {
        await flushPendingSignals?.();
      } catch {
        // Best-effort per the desktop exporter boundary rule: a flush failure
        // must never throw through this API or change the caller's control
        // flow — least of all a crash handler's.
      }
    },
    async shutdown() {
      if (state === DesktopOtelRuntimeState.Shutdown) {
        return;
      }
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // Startup failure is already reported by the boot caller. Shutdown
          // must remain best-effort so a rejected start does not poison quit.
        }
      }
      state = DesktopOtelRuntimeState.Shutdown;
      closeActivityRoot(Date.now());
      // Shut the SDK down first so Batch processors hand their final batches to
      // the relay exporters, THEN stop the transport. The exporters ack the SDK
      // immediately and ship fire-and-forget, so transport.stop() performs a
      // bounded drain of those in-flight sends (so the final app.lifecycle
      // shutdown event has a chance to reach the relay) before disconnecting —
      // time-capped so a degraded relay never blocks app quit.
      await sdk?.shutdown();
      await options.telemetryTransport?.stop();
      sdk = null;
      flushPendingSignals = null;
      startPromise = null;
      resourceAttributesSnapshot = null;
      rendererTraceContexts.clear();
      deviceIdSnapshot = undefined;
    },
    getBufferedRecords() {
      return buffer.snapshot();
    },
    resetBuffer() {
      buffer.reset();
      rendererTraceContexts.clear();
    },
    exportExternalRecords(records) {
      if (state === DesktopOtelRuntimeState.Disabled) {
        return {
          ok: false,
          reason: RendererOtelExportFailureReason.Disabled,
        };
      }
      if (
        state !== DesktopOtelRuntimeState.Started ||
        !resourceAttributesSnapshot
      ) {
        return {
          ok: false,
          reason: RendererOtelExportFailureReason.Unavailable,
        };
      }

      const droppedBefore = buffer.droppedCount();
      const identityContext = records.some(hasSpanIdentity)
        ? context.with(getActivityRootContext(Date.now()), () =>
            resolveRendererIdentityContext(
              records,
              rendererTraceContexts,
              Math.max(1, options.bufferLimit ?? DEFAULT_BUFFER_LIMIT)
            )
          )
        : null;
      const rebasedRecords = rebaseRendererRecords(records, identityContext);
      if (options.telemetryTransport) {
        exportRendererBridgeTraceRecordsToRelay({
          records: rebasedRecords,
          resourceAttributes: resourceAttributesSnapshot,
          sink: options.telemetryTransport,
        });
      }
      for (const record of rebasedRecords) {
        buffer.append({
          ...record,
          resourceAttributes: resourceAttributesSnapshot,
        });
      }
      return {
        ok: true,
        acceptedRecords: records.length,
        // Report only the evictions this call caused, not the buffer's
        // cumulative since-reset total (which also counts main-process drops).
        droppedRecordsCount: buffer.droppedCount() - droppedBefore,
      };
    },
  };

  async function startRuntime(): Promise<void> {
    if (isOtelSdkDisabled(options.env)) {
      state = DesktopOtelRuntimeState.Disabled;
      resourceAttributesSnapshot = null;
      return;
    }

    state = DesktopOtelRuntimeState.Starting;
    const appInstallationId = await options.getAppInstallationId();
    deviceIdSnapshot = await options.getDeviceId?.();
    const deploymentEnvironmentName = resolveDeploymentEnvironmentName({
      env: options.env,
      isPackaged: options.isPackaged,
    });
    // Backstop guard (FEA-2199): never stamp an unusable `service.version` onto
    // the resource. `app.getVersion()` can return Electron's `"0.0"` sentinel (no
    // resolvable manifest) or the Electron runtime version (unpackaged); either
    // poisons the per-version fleet slicing. Caller resolution (app.ts) normally
    // supplies the build-time version, but normalizing here makes the runtime
    // self-protecting for ANY caller and covers renderer-bridge records, which
    // inherit this snapshot. The same value feeds the transport handshake below
    // so the resource and the relay session can never disagree.
    const serviceVersion = isUsableDesktopServiceVersion(options.appVersion, {
      electronVersion: process.versions.electron,
    })
      ? options.appVersion
      : UNRESOLVED_DESKTOP_SERVICE_VERSION;
    const resource = defaultResource().merge(
      resourceFromAttributes({
        [TelemetryAttribute.ServiceName]: SERVICE_NAME,
        [TelemetryAttribute.ServiceVersion]: serviceVersion,
        [TelemetryAttribute.AppInstallationId]: appInstallationId,
        ...(deviceIdSnapshot
          ? { [TelemetryAttribute.DeviceId]: deviceIdSnapshot }
          : {}),
        [TelemetryAttribute.DeploymentEnvironmentName]:
          deploymentEnvironmentName,
      })
    );
    resourceAttributesSnapshot = normalizeAttributes(resource.attributes);

    const transport = options.telemetryTransport;
    if (transport) {
      // Relay egress path (FEA-1993): serialize SDK signals to OTLP protobuf and
      // ship them over the keyless relay channel. Batch processors coalesce
      // signals so export frequency stays well under the relay's per-session
      // rate limit (one socket event per span would burn it immediately).
      const exporters = createRelayOtlpExporters(transport);
      const relayMetricReader = new PeriodicExportingMetricReader({
        exporter: exporters.metricExporter,
        exportIntervalMillis:
          options.metricExportIntervalMs ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS,
      });
      // Held so `flush()` can reach them: `NodeSDK` exposes only start/shutdown,
      // and shutting down is not an option on a path the app may survive.
      const logRecordProcessor = new BatchLogRecordProcessor({
        exporter: exporters.logRecordExporter,
      });
      const spanProcessor = new BatchSpanProcessor(exporters.spanExporter);
      flushPendingSignals = async () => {
        // Processors first (they hand their batches to the exporters), then the
        // transport (the exporters ack the SDK immediately and ship
        // fire-and-forget, so the bytes are still in flight at this point).
        await Promise.allSettled([
          spanProcessor.forceFlush(),
          logRecordProcessor.forceFlush(),
        ]);
        await transport.flush();
      };
      sdk = new NodeSDK({
        autoDetectResources: false,
        instrumentations: [],
        logRecordProcessors: [logRecordProcessor],
        metricReaders: [relayMetricReader],
        resource,
        spanProcessors: [spanProcessor],
        textMapPropagator: DESKTOP_TRACE_CONTEXT_PROPAGATOR,
      });
      sdk.start();
      // Start the transport AFTER the SDK so the first emitted signals find a
      // connecting transport (early exports land in its warm-up queue).
      transport.start({
        appInstallationId,
        serviceVersion,
        deploymentEnvironmentName,
      });
      state = DesktopOtelRuntimeState.Started;
      return;
    }

    // Local-buffer path (no egress) — the FEA-1983 behavior, retained for
    // tests/dev and the renderer-bridge diagnostics.
    const spanExporter = new DesktopOtelSpanExporter(buffer);
    const logExporter = new DesktopOtelLogRecordExporter(buffer);
    const metricExporter = new DesktopOtelMetricExporter(buffer);
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis:
        options.metricExportIntervalMs ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS,
    });

    sdk = new NodeSDK({
      autoDetectResources: false,
      instrumentations: [],
      logRecordProcessors: [
        new SimpleLogRecordProcessor({ exporter: logExporter }),
      ],
      metricReaders: [metricReader],
      resource,
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
      textMapPropagator: DESKTOP_TRACE_CONTEXT_PROPAGATOR,
    });
    sdk.start();
    state = DesktopOtelRuntimeState.Started;
  }

  function getActivityRootContext(activityTimeUnixMs: number): Context {
    if (
      activityRoot &&
      activityTimeUnixMs - activityRoot.startedAtUnixMs >=
        DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS
    ) {
      closeActivityRoot(activityTimeUnixMs);
    }
    if (!activityRoot) {
      activityRoot = openActivityRoot(activityTimeUnixMs);
    }
    scheduleActivityRootIdleClose();
    return trace.setSpan(context.active(), activityRoot.span);
  }

  function openActivityRoot(startTimeUnixMs: number): DesktopActivityRoot {
    const serviceVersion =
      resourceAttributesSnapshot?.[TelemetryAttribute.ServiceVersion];
    const operatingMode = getActivityOperatingMode();
    const attributes = normalizeAttributes({
      ...(typeof serviceVersion === "string"
        ? { [TelemetryAttribute.ServiceVersion]: serviceVersion }
        : {}),
      [TelemetryAttribute.AppOperatingMode]: operatingMode,
      ...(deviceIdSnapshot
        ? { [TelemetryAttribute.DeviceId]: deviceIdSnapshot }
        : {}),
      ...getActivityOrganizationAttribute(operatingMode),
    });
    const span = trace
      .getTracer(DESKTOP_ACTIVITY_ROOT_TRACER_NAME)
      .startSpan(
        DESKTOP_ACTIVITY_ROOT_SPAN_NAME,
        { startTime: startTimeUnixMs, attributes },
        ROOT_CONTEXT
      );
    return { span, startedAtUnixMs: startTimeUnixMs, idleTimer: null };
  }

  function getActivityOperatingMode(): DesktopAppOperatingMode {
    try {
      return (
        options.getOperatingMode?.() ?? DesktopAppOperatingMode.SinglePlayer
      );
    } catch {
      return DesktopAppOperatingMode.SinglePlayer;
    }
  }

  function getActivityOrganizationAttribute(
    operatingMode: DesktopAppOperatingMode
  ): Attributes {
    try {
      const organizationId = options.getOrganizationId?.();
      return organizationId &&
        operatingMode === DesktopAppOperatingMode.Multiplayer
        ? { [TelemetryAttribute.AppOrganizationId]: organizationId }
        : {};
    } catch {
      return {};
    }
  }

  function emitChildSpan({
    attributes,
    durationMs = 0,
    name,
    startTimeUnixMs = Date.now(),
    status,
    tracerName,
  }: {
    attributes: Attributes;
    durationMs?: number;
    name: string;
    startTimeUnixMs?: number;
    status?: { code: OTelSpanStatusCode; message?: string };
    tracerName: string;
  }): void {
    const span = context.with(getActivityRootContext(startTimeUnixMs), () =>
      trace.getTracer(tracerName).startSpan(
        name,
        {
          startTime: startTimeUnixMs,
          attributes: normalizeAttributes(attributes),
        },
        context.active()
      )
    );
    if (status) {
      span.setStatus(status);
    }
    span.end(startTimeUnixMs + durationMs);
  }

  function syncBatchErrorStatus(reason: SyncReason | undefined): {
    code: OTelSpanStatusCode;
    message?: string;
  } {
    return reason
      ? { code: OTelSpanStatusCode.ERROR, message: reason }
      : { code: OTelSpanStatusCode.ERROR };
  }

  function scheduleActivityRootIdleClose(): void {
    if (!activityRoot) {
      return;
    }
    clearActivityRootIdleTimer();
    activityRoot.idleTimer = (options.setActivityRootTimeout ?? setTimeout)(
      () => closeActivityRoot(Date.now()),
      DESKTOP_ACTIVITY_ROOT_IDLE_TIMEOUT_MS
    );
    activityRoot.idleTimer?.unref?.();
  }

  function clearActivityRootIdleTimer(): void {
    if (!activityRoot?.idleTimer) {
      return;
    }
    if (options.clearActivityRootTimeout) {
      options.clearActivityRootTimeout(activityRoot.idleTimer);
    } else {
      clearTimeout(activityRoot.idleTimer as ReturnType<typeof setTimeout>);
    }
    activityRoot.idleTimer = null;
  }

  function closeActivityRoot(endTimeUnixMs: number): void {
    if (!activityRoot) {
      return;
    }
    const span = activityRoot.span;
    clearActivityRootIdleTimer();
    activityRoot = null;
    span.end(endTimeUnixMs);
  }
}

type DesktopActivityRoot = {
  span: Span;
  startedAtUnixMs: number;
  idleTimer: DesktopActivityRootTimerHandle | null;
};

function createDesktopOtelLogEmitChannel(loggerName: string) {
  return {
    info(message: string, meta: Record<string, unknown>): void {
      logs.getLogger(loggerName).emit({
        eventName: message,
        attributes: normalizeAttributes(meta),
      });
    },
  };
}

export function isOtelSdkDisabled(env: NodeJS.ProcessEnv): boolean {
  const rawValue = env.OTEL_SDK_DISABLED?.trim().toLowerCase();
  return rawValue ? OTEL_DISABLED_VALUES.has(rawValue) : false;
}

export function resolveDeploymentEnvironmentName({
  env,
  isPackaged,
}: {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
}): string {
  const rawValue = env.CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME?.trim();
  if (
    rawValue &&
    rawValue.length <= DEPLOYMENT_ENVIRONMENT_MAX_LENGTH &&
    !containsControlCharacter(rawValue)
  ) {
    return rawValue;
  }
  return isPackaged ? "production" : "development";
}

function resolveRendererIdentityContext(
  records: RendererOtelBridgeRecord[],
  rendererTraceContexts: Map<string, SpanContext>,
  contextLimit: number
): SpanContext | null {
  const traceIds = records
    .filter(hasSpanIdentity)
    .map((record) => record.traceId);
  if (traceIds.length === 0) {
    return null;
  }
  const existingContext = traceIds
    .map((traceId) => rendererTraceContexts.get(traceId))
    .find(
      (spanContext): spanContext is SpanContext => spanContext !== undefined
    );
  const activeSpanContext = trace.getSpan(context.active())?.spanContext();
  const identityContext =
    activeSpanContext ?? existingContext ?? createRendererIngestSpanContext();
  for (const traceId of traceIds) {
    const hasCachedContext = rendererTraceContexts.has(traceId);
    if (!hasCachedContext) {
      while (rendererTraceContexts.size >= contextLimit) {
        const oldestTraceId = rendererTraceContexts.keys().next().value;
        if (oldestTraceId === undefined) {
          break;
        }
        rendererTraceContexts.delete(oldestTraceId);
      }
    }
    if (
      !hasCachedContext ||
      rendererTraceContexts.get(traceId) !== identityContext
    ) {
      rendererTraceContexts.set(traceId, identityContext);
    }
  }
  return identityContext;
}

function rebaseRendererRecords(
  records: RendererOtelBridgeRecord[],
  identityContext: SpanContext | null
): RendererOtelBridgeRecord[] {
  if (!identityContext) {
    return records;
  }

  return records.map((record) => {
    if (!hasSpanIdentity(record)) {
      return record;
    }
    return {
      ...record,
      traceId: identityContext.traceId,
      parentSpanId: record.parentSpanId ?? identityContext.spanId,
    };
  });
}

function createRendererIngestSpanContext(): SpanContext {
  const span = trace
    .getTracer("closedloop-desktop-renderer-ingest")
    .startSpan("desktop.renderer.otel.ingest", undefined, context.active());
  span.end();
  return span.spanContext();
}
