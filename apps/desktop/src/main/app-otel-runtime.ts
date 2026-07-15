import { AppTelemetrySchema } from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { createEmit } from "@closedloop-ai/telemetry-contract/emit";
import { IpcTelemetrySchema } from "@closedloop-ai/telemetry-contract/ipc";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import { SyncTelemetrySchema } from "@closedloop-ai/telemetry-contract/sync";
import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  type LogRecordExporter,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  type DesktopExceptionTelemetryInput,
  sanitizeDesktopException,
} from "../shared/exception-sanitizer.js";
import {
  type DesktopOtelBufferedRecord,
  DesktopOtelSignal,
  type RendererOtelBridgeRecord,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
} from "../shared/renderer-otel-bridge-constants.js";
import {
  containsControlCharacter,
  hrTimeToUnixNanoString,
  normalizeAttributes,
  normalizeInstrumentationScope,
} from "../shared/renderer-otel-bridge-utils.js";
import type {
  DesktopAppLifecycleEvent,
  DesktopAppOperatingMode,
} from "./app-otel-runtime-lifecycle.js";
import {
  isUsableDesktopServiceVersion,
  UNRESOLVED_DESKTOP_SERVICE_VERSION,
} from "./desktop-service-version.js";
import { createRelayOtlpExporters } from "./relay-otlp-exporters.js";
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

/**
 * Transport-health outcome of a single agent-session sync batch (FEA-1995). The
 * permanent-removal class (`dead_letter`) is the oversized-session wedge the
 * sync service drops after the >256 KiB cap or repeated ack timeouts/rate
 * limits; the dashboard surfaces it instead of waiting for a user complaint.
 */
export type DesktopSyncBatchOutcome = "success" | "failure" | "dead_letter";

/**
 * Strictly transport-health (PRD-468/FEA-1981 guardrail): counts, bytes,
 * latency, and outcome only — never session ids or content. `latencyMs` is
 * omitted for dead-letters dropped before any send (no round-trip occurred).
 */
export type DesktopSyncBatchEventInput = {
  outcome: DesktopSyncBatchOutcome;
  payloadBytes: number;
  latencyMs?: number;
};

export type CreateDesktopOtelRuntimeOptions = {
  appVersion: string;
  env: NodeJS.ProcessEnv;
  getAppInstallationId: () => string | Promise<string>;
  isPackaged: boolean;
  bufferLimit?: number;
  metricExportIntervalMs?: number;
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
const IPC_PERF_TRACER_NAME = "closedloop-desktop-ipc";
const IPC_PERF_SPAN_NAME_PREFIX = "ipc.";
const SYNC_LOGGER_NAME = "closedloop-desktop-sync";
const SERVICE_NAME = "closedloop-desktop";

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

      const attributes = AppTelemetrySchema.parse({
        [TelemetryAttribute.AppLifecycleEvent]: input.event,
        [TelemetryAttribute.AppOperatingMode]: input.operatingMode,
        ...(input.organizationId
          ? { [TelemetryAttribute.AppOrganizationId]: input.organizationId }
          : {}),
      });
      createEmit(createDesktopOtelLogEmitChannel(APP_LIFECYCLE_LOGGER_NAME))(
        TelemetrySchemaName.App,
        {
          name: APP_LIFECYCLE_EVENT_NAME,
          attributes,
        }
      );
    },
    emitAppExceptionEvent(input) {
      if (state !== DesktopOtelRuntimeState.Started) {
        return;
      }

      try {
        const attributes = AppTelemetrySchema.parse(
          sanitizeDesktopException(input)
        );
        createEmit(createDesktopOtelLogEmitChannel(APP_LIFECYCLE_LOGGER_NAME))(
          TelemetrySchemaName.App,
          {
            name: APP_EXCEPTION_EVENT_NAME,
            attributes,
          }
        );
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
        const span = trace
          .getTracer(IPC_PERF_TRACER_NAME)
          .startSpan(`${IPC_PERF_SPAN_NAME_PREFIX}${input.operation}`, {
            startTime: input.startTimeUnixMs,
            attributes: normalizeAttributes(attributes),
          });
        if (input.errorType) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: input.errorType,
          });
        }
        span.end(input.startTimeUnixMs + input.durationMs);
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
        // four sync.* transport-health keys, so a regression that tried to
        // attach session content would throw here rather than leak it.
        const attributes = SyncTelemetrySchema.parse({
          [TelemetryAttribute.SyncEvent]: "batch",
          [TelemetryAttribute.SyncOutcome]: input.outcome,
          [TelemetryAttribute.SyncPayloadBytes]: input.payloadBytes,
          ...(input.latencyMs === undefined
            ? {}
            : { [TelemetryAttribute.SyncLatencyMs]: input.latencyMs }),
        });
        createEmit(createDesktopOtelLogEmitChannel(SYNC_LOGGER_NAME))(
          TelemetrySchemaName.Sync,
          {
            name: SYNC_BATCH_EVENT_NAME,
            attributes,
          }
        );
      } catch {
        // Transport-health telemetry is best-effort. A schema rejection must
        // never propagate into the sync loop's catch (where it would log a
        // misleading "sync failed" for a batch that actually succeeded) or
        // otherwise affect sync semantics. Mirrors emitAppExceptionEvent.
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
      // Shut the SDK down first so Batch processors hand their final batches to
      // the relay exporters, THEN stop the transport. The exporters ack the SDK
      // immediately and ship fire-and-forget, so transport.stop() performs a
      // bounded drain of those in-flight sends (so the final app.lifecycle
      // shutdown event has a chance to reach the relay) before disconnecting —
      // time-capped so a degraded relay never blocks app quit.
      await sdk?.shutdown();
      await options.telemetryTransport?.stop();
      sdk = null;
      startPromise = null;
      resourceAttributesSnapshot = null;
    },
    getBufferedRecords() {
      return buffer.snapshot();
    },
    resetBuffer() {
      buffer.reset();
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
      for (const record of records) {
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
      sdk = new NodeSDK({
        autoDetectResources: false,
        instrumentations: [],
        logRecordProcessors: [
          new BatchLogRecordProcessor(exporters.logRecordExporter),
        ],
        metricReaders: [relayMetricReader],
        resource,
        spanProcessors: [new BatchSpanProcessor(exporters.spanExporter)],
        textMapPropagator: null,
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
      logRecordProcessors: [new SimpleLogRecordProcessor(logExporter)],
      metricReaders: [metricReader],
      resource,
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
      textMapPropagator: null,
    });
    sdk.start();
    state = DesktopOtelRuntimeState.Started;
  }
}

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

class DesktopOtelLocalBuffer {
  private readonly records: DesktopOtelBufferedRecord[] = [];
  private readonly limit: number;
  private droppedRecordsCount = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  append(record: Omit<DesktopOtelBufferedRecord, "droppedRecordsCount">): void {
    while (this.records.length >= this.limit) {
      this.records.shift();
      this.droppedRecordsCount += 1;
    }

    this.records.push({
      ...record,
      droppedRecordsCount: this.droppedRecordsCount,
    });
  }

  snapshot(): DesktopOtelBufferedRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  droppedCount(): number {
    return this.droppedRecordsCount;
  }

  reset(): void {
    this.records.length = 0;
    this.droppedRecordsCount = 0;
  }
}

class DesktopOtelSpanExporter implements SpanExporter {
  private readonly buffer: DesktopOtelLocalBuffer;

  constructor(buffer: DesktopOtelLocalBuffer) {
    this.buffer = buffer;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: Parameters<SpanExporter["export"]>[1]
  ): void {
    for (const span of spans) {
      this.buffer.append({
        signal: DesktopOtelSignal.Trace,
        resourceAttributes: normalizeAttributes(span.resource.attributes),
        instrumentationScope: normalizeInstrumentationScope(
          span.instrumentationScope
        ),
        timestampUnixNano: hrTimeToUnixNanoString(span.endTime),
        name: span.name,
        attributes: normalizeAttributes(span.attributes),
        droppedAttributesCount: span.droppedAttributesCount,
        droppedEventsCount: span.droppedEventsCount,
        droppedLinksCount: span.droppedLinksCount,
      });
    }
    resultCallback({ code: 0 });
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

class DesktopOtelLogRecordExporter implements LogRecordExporter {
  private readonly buffer: DesktopOtelLocalBuffer;

  constructor(buffer: DesktopOtelLocalBuffer) {
    this.buffer = buffer;
  }

  export(
    logs: ReadableLogRecord[],
    resultCallback: Parameters<LogRecordExporter["export"]>[1]
  ): void {
    for (const logRecord of logs) {
      this.buffer.append({
        signal: DesktopOtelSignal.Log,
        resourceAttributes: normalizeAttributes(logRecord.resource.attributes),
        instrumentationScope: normalizeInstrumentationScope(
          logRecord.instrumentationScope
        ),
        timestampUnixNano: hrTimeToUnixNanoString(logRecord.hrTime),
        ...(logRecord.eventName ? { name: logRecord.eventName } : {}),
        ...(logRecord.body === undefined ? {} : { body: logRecord.body }),
        attributes: normalizeAttributes(logRecord.attributes),
        droppedAttributesCount: logRecord.droppedAttributesCount,
      });
    }
    resultCallback({ code: 0 });
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

class DesktopOtelMetricExporter implements PushMetricExporter {
  private readonly buffer: DesktopOtelLocalBuffer;

  constructor(buffer: DesktopOtelLocalBuffer) {
    this.buffer = buffer;
  }

  export(
    metrics: ResourceMetrics,
    resultCallback: Parameters<PushMetricExporter["export"]>[1]
  ): void {
    for (const scopeMetrics of metrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        for (const dataPoint of metric.dataPoints) {
          this.buffer.append({
            signal: DesktopOtelSignal.Metric,
            resourceAttributes: normalizeAttributes(
              metrics.resource.attributes
            ),
            instrumentationScope: normalizeInstrumentationScope(
              scopeMetrics.scope
            ),
            timestampUnixNano: hrTimeToUnixNanoString(dataPoint.endTime),
            name: metric.descriptor.name,
            attributes: normalizeAttributes(dataPoint.attributes),
            value: dataPoint.value,
          });
        }
      }
    }
    resultCallback({ code: 0 });
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
