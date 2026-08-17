import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SpanKind,
  SpanStatusCode,
} from "@closedloop-ai/telemetry-contract/span";
import { defaultResource } from "@opentelemetry/resources";
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import {
  asOtlpRecordArray,
  decodeOtlpBytesToHex,
  walkOtlpTraceSpans,
} from "../src/main/otlp/decode-utilities.js";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../src/main/otlp/proto-descriptor.js";
import {
  createRelayOtlpExporters,
  exportRendererBridgeTraceRecordsToRelay,
  type TelemetryExportSink,
} from "../src/main/telemetry/relay-otlp-exporters.js";
import type { RelayTelemetrySignal } from "../src/main/telemetry/relay-telemetry-transport.js";
import { asRecord } from "../src/main/util/api-response-utils.js";
import {
  DesktopOtelSignal,
  RendererOtelAllowedAttributeKey,
} from "../src/shared/renderer-otel-bridge-constants.js";

type Shipment = { signal: RelayTelemetrySignal; body: Uint8Array };

function createRecordingSink(
  onFlush: () => Promise<void> = () => Promise.resolve()
): TelemetryExportSink & {
  shipments: Shipment[];
  flushCount: number;
} {
  const shipments: Shipment[] = [];
  return {
    shipments,
    flushCount: 0,
    export(signal, body) {
      shipments.push({ signal, body });
      return Promise.resolve(true);
    },
    flush() {
      this.flushCount += 1;
      return onFlush();
    },
  };
}

const emptyResourceMetrics = (): ResourceMetrics => ({
  resource: defaultResource(),
  scopeMetrics: [],
});

test("span exporter skips an empty batch but still reports success", () => {
  const sink = createRecordingSink();
  const { spanExporter } = createRelayOtlpExporters(sink);

  let result: { code: number } | null = null;
  spanExporter.export([], (r) => {
    result = r as { code: number };
  });

  assert.equal(sink.shipments.length, 0);
  assert.deepEqual(result, { code: 0 });
});

test("log exporter skips an empty batch but still reports success", () => {
  const sink = createRecordingSink();
  const { logRecordExporter } = createRelayOtlpExporters(sink);

  let result: { code: number } | null = null;
  logRecordExporter.export([], (r) => {
    result = r as { code: number };
  });

  assert.equal(sink.shipments.length, 0);
  assert.deepEqual(result, { code: 0 });
});

test("metric exporter skips a collection with no data points", () => {
  // The periodic reader fires every interval even when nothing was recorded;
  // an empty collection must not burn a relay export. (The with-data ship path
  // is covered end-to-end by app-otel-runtime-relay.test.ts, which emits a real
  // counter and asserts a Metrics shipment with a non-empty body.)
  const sink = createRecordingSink();
  const { metricExporter } = createRelayOtlpExporters(sink);

  let result: { code: number } | null = null;
  metricExporter.export(emptyResourceMetrics(), (r) => {
    result = r as { code: number };
  });

  assert.deepEqual(result, { code: 0 });
  assert.equal(sink.shipments.length, 0);
});

test("renderer relay export ships complete traces and drops incomplete or log records", () => {
  const sink = createRecordingSink();

  exportRendererBridgeTraceRecordsToRelay({
    resourceAttributes: {},
    sink,
    records: [
      {
        signal: DesktopOtelSignal.Log,
        name: "renderer.log",
      },
      {
        signal: DesktopOtelSignal.Trace,
        name: "renderer.incomplete",
      },
      {
        signal: DesktopOtelSignal.Trace,
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        parentSpanId: "3333333333333333",
        kind: SpanKind.Internal,
        status: { code: SpanStatusCode.Error, message: "renderer failed" },
        name: "renderer.complete",
        attributes: {
          [RendererOtelAllowedAttributeKey.Mode]: "relay",
        },
      },
    ],
  });

  assert.equal(sink.shipments.length, 1);
  assert.equal(sink.shipments[0]?.signal, KeylessTelemetrySignal.Traces);
  const spans = decodeExportedSpans(
    sink.shipments[0]?.body ?? new Uint8Array()
  );
  assert.deepEqual(spans, [
    {
      name: "renderer.complete",
      parentSpanId: "3333333333333333",
      spanId: "2222222222222222",
      statusCode: 2,
      statusMessage: "renderer failed",
      traceId: "11111111111111111111111111111111",
    },
  ]);
});

function decodeExportedSpans(body: Uint8Array): DecodedSpan[] {
  const traceRequestType = getOtlpRequestType(OtlpExportKind.Traces);
  const request = traceRequestType.toObject(traceRequestType.decode(body), {
    bytes: String,
    longs: String,
  }) as DecodedTraceRequest;
  return walkOtlpTraceSpans(asOtlpRecordArray(request.resourceSpans)).map(
    (span) => {
      const status = asRecord(span.status);
      return {
        name: stringValue(span.name),
        parentSpanId: decodeOtlpBytesToHex(span.parentSpanId, {
          bytes: "base64",
        }),
        spanId: decodeOtlpBytesToHex(span.spanId, { bytes: "base64" }),
        statusCode: numberValue(status.code),
        ...(typeof status.message === "string"
          ? { statusMessage: status.message }
          : {}),
        traceId: decodeOtlpBytesToHex(span.traceId, { bytes: "base64" }),
      };
    }
  );
}

type DecodedSpan = {
  name?: string;
  parentSpanId?: string;
  spanId?: string;
  statusCode?: number;
  statusMessage?: string;
  traceId?: string;
};

type DecodedTraceRequest = {
  resourceSpans?: unknown;
};

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

test("forceFlush drains the transport on every exporter (ISS-6328)", async () => {
  // Shipping is fire-and-forget — export() hands the bytes to the transport and
  // acks the SDK immediately — so an exporter whose forceFlush() is a no-op
  // tells the SDK "flushed" while the bytes are still in flight.
  const sink = createRecordingSink();
  const { spanExporter, logRecordExporter, metricExporter } =
    createRelayOtlpExporters(sink);

  await spanExporter.forceFlush?.();
  assert.equal(sink.flushCount, 1, "span exporter must drain the transport");

  await logRecordExporter.forceFlush?.();
  assert.equal(sink.flushCount, 2, "log exporter must drain the transport");

  await metricExporter.forceFlush?.();
  assert.equal(sink.flushCount, 3, "metric exporter must drain the transport");
});

test("a rejected transport flush never throws through forceFlush", async () => {
  // The desktop exporter-boundary rule: a dispatch failure must not throw
  // through a runtime export API. This runs on the crash path, where a throw
  // would replace the crash with a different one.
  const sink = createRecordingSink(() =>
    Promise.reject(new Error("relay socket wedged"))
  );
  const { spanExporter } = createRelayOtlpExporters(sink);

  await spanExporter.forceFlush?.();

  assert.equal(sink.flushCount, 1, "the flush was still attempted");
});
