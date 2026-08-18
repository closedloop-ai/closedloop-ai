/**
 * Relay OTLP exporters (FEA-1993 / PRD-481 C5).
 *
 * SDK exporters that serialize each batch to OTLP protobuf and hand the opaque
 * bytes to the keyless {@link DesktopTelemetryTransport}. They replace the
 * local-buffer exporters from FEA-1983 when a transport is wired in. Shipping
 * is fire-and-forget — `transport.export()` never throws and the body-size
 * guard / rate-limit handling live in the transport (the session's
 * `maxBodyBytes` is the authoritative limit), so each exporter immediately acks
 * the SDK with success and lets the transport account for any drop.
 */

import {
  type Attributes,
  type HrTime,
  SpanKind as OTelSpanKind,
  SpanStatusCode as OTelSpanStatusCode,
  type SpanContext,
  TraceFlags,
} from "@opentelemetry/api";
import {
  ProtobufLogsSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import type {
  PushMetricExporter,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import {
  DesktopOtelSignal,
  type RendererOtelBridgeRecord,
  type RendererOtelGenericBridgeRecord,
} from "../../shared/renderer-otel-bridge-constants.js";
import { hasSpanIdentity } from "../../shared/renderer-otel-bridge-utils.js";
import type {
  DesktopTelemetryTransport,
  RelayTelemetrySignal,
} from "./relay-telemetry-transport.js";

/**
 * The transport capabilities the exporters need: `export` to ship a batch, and
 * `flush` so `forceFlush()` can honour the SDK contract (ISS-6328) — shipping is
 * fire-and-forget, so "the batch was handed over" is not "the batch left".
 */
export type TelemetryExportSink = Pick<
  DesktopTelemetryTransport,
  "export" | "flush"
>;

/** Best-effort success: mirror the existing local-buffer exporters' ack. */
const EXPORT_SUCCESS = { code: 0 } as const;

export type RelayOtlpExporters = {
  spanExporter: SpanExporter;
  logRecordExporter: LogRecordExporter;
  metricExporter: PushMetricExporter;
};

export function createRelayOtlpExporters(
  sink: TelemetryExportSink
): RelayOtlpExporters {
  return {
    spanExporter: new RelayOtlpSpanExporter(sink),
    logRecordExporter: new RelayOtlpLogRecordExporter(sink),
    metricExporter: new RelayOtlpMetricExporter(sink),
  };
}

export function exportRendererBridgeTraceRecordsToRelay({
  records,
  resourceAttributes,
  sink,
}: {
  records: RendererOtelBridgeRecord[];
  resourceAttributes: Attributes;
  sink: TelemetryExportSink;
}): void {
  const spans = records.flatMap((record) =>
    rendererBridgeRecordToReadableSpan(record, resourceAttributes)
  );
  if (spans.length === 0) {
    return;
  }
  try {
    shipSerialized(
      sink,
      KeylessTelemetrySignal.Traces,
      ProtobufTraceSerializer.serializeRequest(spans)
    );
  } catch {
    // Renderer relay export is best-effort; local buffering must still succeed.
  }
}

/** Serialize a batch and ship it; an empty/undefined body is a no-op. */
function shipSerialized(
  sink: TelemetryExportSink,
  signal: RelayTelemetrySignal,
  body: Uint8Array | undefined
): void {
  if (!body || body.byteLength === 0) {
    return;
  }
  // Fire-and-forget: the transport swallows all failures and accounts drops.
  sink.export(signal, body).catch(() => undefined);
}

/** True when the metrics batch carries at least one data point worth shipping. */
function hasMetricData(metrics: ResourceMetrics): boolean {
  return metrics.scopeMetrics.some((scope) =>
    scope.metrics.some((metric) => metric.dataPoints.length > 0)
  );
}

function rendererBridgeRecordToReadableSpan(
  record: RendererOtelBridgeRecord,
  resourceAttributes: Attributes
): ReadableSpan[] {
  if (record.signal !== DesktopOtelSignal.Trace || !hasSpanIdentity(record)) {
    return [];
  }
  const endTime = unixNanoStringToHrTime(record.timestampUnixNano);
  return [
    {
      attributes: record.attributes ?? {},
      droppedAttributesCount: record.droppedAttributesCount ?? 0,
      droppedEventsCount: record.droppedEventsCount ?? 0,
      droppedLinksCount: record.droppedLinksCount ?? 0,
      // The renderer bridge currently carries only span end time.
      duration: [0, 0],
      ended: true,
      endTime,
      events: [],
      instrumentationScope: record.instrumentationScope ?? {
        name: "closedloop-desktop-renderer",
      },
      kind: mapSpanKind(record.kind),
      links: [],
      name: record.name ?? "",
      ...(record.parentSpanId
        ? {
            parentSpanContext: spanContext(record.traceId, record.parentSpanId),
          }
        : {}),
      resource: resourceFromAttributes(resourceAttributes),
      spanContext: () => spanContext(record.traceId, record.spanId),
      startTime: endTime,
      status: {
        code: mapSpanStatusCode(record.status?.code),
        ...(record.status?.message ? { message: record.status.message } : {}),
      },
    },
  ];
}

function unixNanoStringToHrTime(value: string | undefined): HrTime {
  if (!value) {
    return [0, 0];
  }
  try {
    const unixNano = BigInt(value);
    return [
      Number(unixNano / 1_000_000_000n),
      Number(unixNano % 1_000_000_000n),
    ];
  } catch {
    return [0, 0];
  }
}

function spanContext(traceId: string, spanId: string): SpanContext {
  return {
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    traceId,
  };
}

function mapSpanKind(
  kind: RendererOtelGenericBridgeRecord["kind"]
): OTelSpanKind {
  switch (kind) {
    case "server":
      return OTelSpanKind.SERVER;
    case "client":
      return OTelSpanKind.CLIENT;
    case "producer":
      return OTelSpanKind.PRODUCER;
    case "consumer":
      return OTelSpanKind.CONSUMER;
    default:
      return OTelSpanKind.INTERNAL;
  }
}

function mapSpanStatusCode(
  code:
    | NonNullable<RendererOtelGenericBridgeRecord["status"]>["code"]
    | undefined
): OTelSpanStatusCode {
  switch (code) {
    case "ok":
      return OTelSpanStatusCode.OK;
    case "error":
      return OTelSpanStatusCode.ERROR;
    default:
      return OTelSpanStatusCode.UNSET;
  }
}

class RelayOtlpSpanExporter implements SpanExporter {
  private readonly sink: TelemetryExportSink;

  constructor(sink: TelemetryExportSink) {
    this.sink = sink;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: Parameters<SpanExporter["export"]>[1]
  ): void {
    try {
      if (spans.length > 0) {
        shipSerialized(
          this.sink,
          KeylessTelemetrySignal.Traces,
          ProtobufTraceSerializer.serializeRequest(spans)
        );
      }
    } catch {
      // Serialization must never break the SDK export contract or the app:
      // ack success (best-effort) and drop this batch.
    }
    resultCallback(EXPORT_SUCCESS);
  }

  async forceFlush(): Promise<void> {
    try {
      await this.sink.flush();
    } catch {
      // See export() — the exporter boundary must never throw through a
      // runtime export API, flush included.
    }
  }

  async shutdown(): Promise<void> {}
}

class RelayOtlpLogRecordExporter implements LogRecordExporter {
  private readonly sink: TelemetryExportSink;

  constructor(sink: TelemetryExportSink) {
    this.sink = sink;
  }

  export(
    logs: ReadableLogRecord[],
    resultCallback: Parameters<LogRecordExporter["export"]>[1]
  ): void {
    try {
      if (logs.length > 0) {
        shipSerialized(
          this.sink,
          KeylessTelemetrySignal.Logs,
          ProtobufLogsSerializer.serializeRequest(logs)
        );
      }
    } catch {
      // See RelayOtlpSpanExporter.export — best-effort, never throw.
    }
    resultCallback(EXPORT_SUCCESS);
  }

  async forceFlush(): Promise<void> {
    try {
      await this.sink.flush();
    } catch {
      // See export() — the exporter boundary must never throw through a
      // runtime export API, flush included.
    }
  }

  async shutdown(): Promise<void> {}
}

class RelayOtlpMetricExporter implements PushMetricExporter {
  private readonly sink: TelemetryExportSink;

  constructor(sink: TelemetryExportSink) {
    this.sink = sink;
  }

  export(
    metrics: ResourceMetrics,
    resultCallback: Parameters<PushMetricExporter["export"]>[1]
  ): void {
    try {
      // The periodic reader fires every interval even with nothing recorded;
      // skip empty collections so we don't burn a relay export (and a slot in
      // the per-session rate limit) on a data-point-free payload.
      if (hasMetricData(metrics)) {
        shipSerialized(
          this.sink,
          KeylessTelemetrySignal.Metrics,
          ProtobufMetricsSerializer.serializeRequest(metrics)
        );
      }
    } catch {
      // See RelayOtlpSpanExporter.export — best-effort, never throw.
    }
    resultCallback(EXPORT_SUCCESS);
  }

  async forceFlush(): Promise<void> {
    try {
      await this.sink.flush();
    } catch {
      // See export() — the exporter boundary must never throw through a
      // runtime export API, flush included.
    }
  }

  async shutdown(): Promise<void> {}
}
