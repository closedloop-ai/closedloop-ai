import {
  TelemetryAttribute,
  TelemetryServiceName,
} from "@closedloop-ai/telemetry-contract/attributes";
import type { Attributes } from "@opentelemetry/api";
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
  containsControlCharacter,
  normalizeAttributes,
} from "../../shared/renderer-otel-bridge-utils.js";
import {
  isUsableDesktopServiceVersion,
  UNRESOLVED_DESKTOP_SERVICE_VERSION,
} from "../util/desktop-service-version.js";
import { withFleetScopedResource } from "./fleet-scoped-metric-exporter.js";
import {
  type DesktopOtelLocalBuffer,
  DesktopOtelLogRecordExporter,
  DesktopOtelMetricExporter,
  DesktopOtelSpanExporter,
} from "./local-buffer-otel-exporters.js";
import { createRelayOtlpExporters } from "./relay-otlp-exporters.js";
import type { DesktopTelemetryTransport } from "./relay-telemetry-transport.js";

const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 60_000;
const OTEL_DISABLED_VALUES = new Set(["1", "true", "yes"]);
const DEPLOYMENT_ENVIRONMENT_MAX_LENGTH = 128;
const DESKTOP_TRACE_CONTEXT_PROPAGATOR = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator()],
});

export type StartDesktopOtelSdkOptions = {
  appVersion: string;
  env: NodeJS.ProcessEnv;
  getAppInstallationId: () => string | Promise<string>;
  getDeviceId?: () => string | Promise<string>;
  isPackaged: boolean;
  metricExportIntervalMs?: number;
  telemetryTransport?: DesktopTelemetryTransport;
};

export type StartedDesktopOtelSdk = {
  sdk: NodeSDK;
  resourceAttributes: Attributes;
  deviceId: string | undefined;
  /**
   * Set only on the relay path, where Batch processors hold signals the caller's
   * `flush()` must be able to push without shutting the runtime down. The
   * local-buffer path exports synchronously and has nothing to force.
   */
  flushPendingSignals: (() => Promise<void>) | null;
};

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

export async function startDesktopOtelSdk({
  buffer,
  options,
}: {
  buffer: DesktopOtelLocalBuffer;
  options: StartDesktopOtelSdkOptions;
}): Promise<StartedDesktopOtelSdk> {
  const appInstallationId = await options.getAppInstallationId();
  const deviceId = await options.getDeviceId?.();
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
      [TelemetryAttribute.ServiceName]: TelemetryServiceName.Desktop,
      [TelemetryAttribute.ServiceVersion]: serviceVersion,
      [TelemetryAttribute.AppInstallationId]: appInstallationId,
      ...(deviceId ? { [TelemetryAttribute.DeviceId]: deviceId } : {}),
      [TelemetryAttribute.DeploymentEnvironmentName]: deploymentEnvironmentName,
    })
  );
  const resourceAttributes = normalizeAttributes(resource.attributes);

  const transport = options.telemetryTransport;
  if (transport) {
    // Relay egress path (FEA-1993): serialize SDK signals to OTLP protobuf and
    // ship them over the keyless relay channel. Batch processors coalesce
    // signals so export frequency stays well under the relay's per-session
    // rate limit (one socket event per span would burn it immediately).
    const exporters = createRelayOtlpExporters(transport);
    const relayMetricReader = new PeriodicExportingMetricReader({
      exporter: withFleetScopedResource(exporters.metricExporter),
      exportIntervalMillis:
        options.metricExportIntervalMs ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS,
    });
    // Held so `flush()` can reach them: `NodeSDK` exposes only start/shutdown,
    // and shutting down is not an option on a path the app may survive.
    const logRecordProcessor = new BatchLogRecordProcessor({
      exporter: exporters.logRecordExporter,
    });
    const spanProcessor = new BatchSpanProcessor(exporters.spanExporter);
    const flushPendingSignals = async () => {
      // Processors first (they hand their batches to the exporters), then the
      // transport (the exporters ack the SDK immediately and ship
      // fire-and-forget, so the bytes are still in flight at this point).
      //
      // ISS-7497: the metric reader is drained here too. `forceFlush()` on a
      // MetricReader collects and exports, and without it the crash path shipped
      // the sync SPANS while discarding up to a full export interval of
      // `sync.batch.count` increments for those same batches — a loss
      // correlated with the health of the install, which is the exact bias the
      // counter exists to remove.
      await Promise.allSettled([
        spanProcessor.forceFlush(),
        logRecordProcessor.forceFlush(),
        relayMetricReader.forceFlush(),
      ]);
      await transport.flush();
    };
    const sdk = new NodeSDK({
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
    return { sdk, resourceAttributes, deviceId, flushPendingSignals };
  }

  // Local-buffer path (no egress) — the FEA-1983 behavior, retained for
  // tests/dev and the renderer-bridge diagnostics.
  const spanExporter = new DesktopOtelSpanExporter(buffer);
  const logExporter = new DesktopOtelLogRecordExporter(buffer);
  const metricExporter = new DesktopOtelMetricExporter(buffer);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: withFleetScopedResource(metricExporter),
    exportIntervalMillis:
      options.metricExportIntervalMs ?? DEFAULT_METRIC_EXPORT_INTERVAL_MS,
  });

  const sdk = new NodeSDK({
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
  return { sdk, resourceAttributes, deviceId, flushPendingSignals: null };
}

export function isOtelSdkDisabled(env: NodeJS.ProcessEnv): boolean {
  const rawValue = env.OTEL_SDK_DISABLED?.trim().toLowerCase();
  return rawValue ? OTEL_DISABLED_VALUES.has(rawValue) : false;
}
