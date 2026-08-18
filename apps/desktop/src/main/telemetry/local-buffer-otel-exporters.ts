/**
 * Local-buffer OTel exporters (FEA-1983).
 *
 * The no-egress path: SDK signals are normalized and appended to an in-process
 * ring buffer instead of being shipped anywhere. Retained for tests/dev and the
 * renderer-bridge diagnostics; the shipping path is `relay-otlp-exporters.ts`.
 *
 * Split out of `app-otel-runtime.ts` when that file reached the 1,000-line
 * ceiling — this is the exact sibling of the relay exporters module.
 */

import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import type {
  PushMetricExporter,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  type DesktopOtelBufferedRecord,
  DesktopOtelSignal,
} from "../../shared/renderer-otel-bridge-constants.js";
import {
  hrTimeToUnixNanoString,
  normalizeAttributes,
  normalizeInstrumentationScope,
  normalizeSpanKind,
  normalizeSpanStatus,
} from "../../shared/renderer-otel-bridge-utils.js";

export class DesktopOtelLocalBuffer {
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

export class DesktopOtelSpanExporter implements SpanExporter {
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
        ...spanIdentityFields(span),
        name: span.name,
        attributes: normalizeAttributes(span.attributes),
        droppedAttributesCount: span.droppedAttributesCount,
        droppedEventsCount: span.droppedEventsCount,
        droppedLinksCount: span.droppedLinksCount,
      });
    }
    resultCallback({ code: 0 });
  }

  // Genuinely nothing to flush: `buffer.append()` above is synchronous, so by
  // the time export() returns the record is already in the local buffer.
  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

function spanIdentityFields(span: ReadableSpan) {
  const spanContext = span.spanContext();
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    ...(span.parentSpanContext
      ? { parentSpanId: span.parentSpanContext.spanId }
      : {}),
    kind: normalizeSpanKind(span.kind),
    status: normalizeSpanStatus(span.status),
  };
}

export class DesktopOtelLogRecordExporter implements LogRecordExporter {
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

  // Genuinely nothing to flush: `buffer.append()` above is synchronous, so by
  // the time export() returns the record is already in the local buffer.
  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

export class DesktopOtelMetricExporter implements PushMetricExporter {
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

  // Genuinely nothing to flush: `buffer.append()` above is synchronous, so by
  // the time export() returns the record is already in the local buffer.
  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
