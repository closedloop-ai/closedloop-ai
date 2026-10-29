import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SpanKind,
  SpanStatusCode,
} from "@closedloop-ai/telemetry-contract/span";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import { describe, expect, it } from "vitest";
import { AUTH_FAILURE_LOGGER_NAME } from "../src/main/cloud/auth-failure-telemetry.js";
import {
  asOtlpRecordArray,
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
  type RendererOtelGenericBridgeRecord,
} from "../src/shared/renderer-otel-bridge-constants.js";

const TRACE_ID = "11111111111111111111111111111111";

type Shipment = { signal: RelayTelemetrySignal; body: Uint8Array };

function recordingSink(): TelemetryExportSink & { shipments: Shipment[] } {
  const shipments: Shipment[] = [];
  return {
    shipments,
    export(signal, body) {
      shipments.push({ signal, body });
      return Promise.resolve(true);
    },
    flush: () => Promise.resolve(),
  };
}

function decode(kind: OtlpExportKind, body: Uint8Array) {
  const type = getOtlpRequestType(kind);
  return type.toObject(type.decode(body), {
    bytes: String,
    longs: String,
  }) as Record<string, unknown>;
}

function traceRecord(
  spanId: string,
  extra: Partial<RendererOtelGenericBridgeRecord> = {}
): RendererOtelGenericBridgeRecord {
  return {
    signal: DesktopOtelSignal.Trace,
    traceId: TRACE_ID,
    spanId,
    name: `span-${spanId}`,
    ...extra,
  };
}

describe("renderer bridge trace relay export", () => {
  it("ships nothing when no record is a complete trace", () => {
    const sink = recordingSink();
    exportRendererBridgeTraceRecordsToRelay({
      resourceAttributes: {},
      sink,
      records: [
        { signal: DesktopOtelSignal.Log, name: "renderer.log" },
        { signal: DesktopOtelSignal.Trace, name: "no-identity" },
      ],
    });
    expect(sink.shipments).toEqual([]);
  });

  it("maps every span kind, the ok status, a missing name, and the end timestamp onto the wire span", () => {
    const sink = recordingSink();
    exportRendererBridgeTraceRecordsToRelay({
      resourceAttributes: {},
      sink,
      records: [
        traceRecord("0000000000000001", { kind: SpanKind.Server }),
        traceRecord("0000000000000002", { kind: SpanKind.Client }),
        traceRecord("0000000000000003", { kind: SpanKind.Producer }),
        traceRecord("0000000000000004", { kind: SpanKind.Consumer }),
        traceRecord("0000000000000005", {
          status: { code: SpanStatusCode.Ok },
          timestampUnixNano: "1700000000123456789",
        }),
        traceRecord("0000000000000006", {
          name: undefined,
          timestampUnixNano: "not-a-number",
        }),
      ],
    });
    expect(sink.shipments).toHaveLength(1);
    expect(sink.shipments[0]?.signal).toBe(KeylessTelemetrySignal.Traces);
    const spans = walkOtlpTraceSpans(
      asOtlpRecordArray(
        decode(
          OtlpExportKind.Traces,
          sink.shipments[0]?.body ?? new Uint8Array()
        ).resourceSpans
      )
    ).map((span) => ({
      name: span.name ?? "",
      kind: span.kind,
      statusCode: asRecord(span.status).code,
      endTimeUnixNano: span.endTimeUnixNano,
      hasParent: span.parentSpanId !== undefined,
    }));
    // OTLP wire kinds: INTERNAL=1, SERVER=2, CLIENT=3, PRODUCER=4, CONSUMER=5;
    // status UNSET=0, OK=1. A missing or unparseable timestamp encodes as time zero.
    expect(spans).toEqual([
      {
        name: "span-0000000000000001",
        kind: 2,
        statusCode: 0,
        endTimeUnixNano: "0",
        hasParent: false,
      },
      {
        name: "span-0000000000000002",
        kind: 3,
        statusCode: 0,
        endTimeUnixNano: "0",
        hasParent: false,
      },
      {
        name: "span-0000000000000003",
        kind: 4,
        statusCode: 0,
        endTimeUnixNano: "0",
        hasParent: false,
      },
      {
        name: "span-0000000000000004",
        kind: 5,
        statusCode: 0,
        endTimeUnixNano: "0",
        hasParent: false,
      },
      {
        name: "span-0000000000000005",
        kind: 1,
        statusCode: 1,
        endTimeUnixNano: "1700000000123456789",
        hasParent: false,
      },
      {
        name: "",
        kind: 1,
        statusCode: 0,
        endTimeUnixNano: "0",
        hasParent: false,
      },
    ]);
  });

  it("carries a parent span, an error status with its message, and the default renderer scope", () => {
    const sink = recordingSink();
    exportRendererBridgeTraceRecordsToRelay({
      resourceAttributes: {},
      sink,
      records: [
        traceRecord("00000000000000aa", {
          parentSpanId: "00000000000000bb",
          status: { code: SpanStatusCode.Error, message: "boom" },
        }),
      ],
    });
    const resourceSpans = asOtlpRecordArray(
      decode(OtlpExportKind.Traces, sink.shipments[0]?.body ?? new Uint8Array())
        .resourceSpans
    );
    const scopeSpans = asOtlpRecordArray(resourceSpans[0]?.scopeSpans);
    expect(asRecord(scopeSpans[0]?.scope).name).toBe(
      "closedloop-desktop-renderer"
    );
    const [span] = walkOtlpTraceSpans(resourceSpans);
    // Bytes decode as base64 strings: 0x..aa / 0x..bb.
    expect(span?.parentSpanId).toBe(
      Buffer.from("00000000000000bb", "hex").toString("base64")
    );
    expect(asRecord(span?.status)).toEqual({ code: 2, message: "boom" });
  });
});

describe("relay log exporter auth-failure resource", () => {
  it("ships an auth failure with only the allow-listed resource attributes that are present", () => {
    const sink = recordingSink();
    const { logRecordExporter } = createRelayOtlpExporters(sink);
    const record: ReadableLogRecord = {
      hrTime: [1_700_000_000, 0],
      hrTimeObserved: [1_700_000_000, 0],
      severityText: "WARN",
      body: "auth failed",
      resource: resourceFromAttributes({
        [TelemetryAttribute.ServiceName]: "closedloop-desktop",
        [TelemetryAttribute.AppInstallationId]: "install-secret",
      }),
      instrumentationScope: { name: AUTH_FAILURE_LOGGER_NAME },
      attributes: {},
      droppedAttributesCount: 0,
    };
    const results: unknown[] = [];
    logRecordExporter.export([record], (result) => results.push(result));
    expect(results).toEqual([{ code: 0 }]);
    expect(sink.shipments).toHaveLength(1);
    const resourceLogs = asOtlpRecordArray(
      decode(OtlpExportKind.Logs, sink.shipments[0]?.body ?? new Uint8Array())
        .resourceLogs
    );
    const attributes = asOtlpRecordArray(
      asRecord(resourceLogs[0]?.resource).attributes
    ).map((entry) => [entry.key, asRecord(entry.value).stringValue]);
    expect(attributes).toEqual([
      [TelemetryAttribute.ServiceName, "closedloop-desktop"],
    ]);
  });
});
