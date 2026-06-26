import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultResource } from "@opentelemetry/resources";
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import {
  createRelayOtlpExporters,
  type TelemetryExportSink,
} from "../src/main/relay-otlp-exporters.js";
import type { RelayTelemetrySignal } from "../src/main/relay-telemetry-transport.js";

type Shipment = { signal: RelayTelemetrySignal; body: Uint8Array };

function createRecordingSink(): TelemetryExportSink & {
  shipments: Shipment[];
} {
  const shipments: Shipment[] = [];
  return {
    shipments,
    export(signal, body) {
      shipments.push({ signal, body });
      return Promise.resolve(true);
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
