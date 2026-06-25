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
  ProtobufLogsSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
} from "@opentelemetry/otlp-transformer";
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
import type {
  DesktopTelemetryTransport,
  RelayTelemetrySignal,
} from "./relay-telemetry-transport.js";

/** The only transport capability the exporters need. */
export type TelemetryExportSink = Pick<DesktopTelemetryTransport, "export">;

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

  async forceFlush(): Promise<void> {}

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

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
