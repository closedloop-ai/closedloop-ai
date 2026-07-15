import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import {
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../src/main/app-otel-runtime.js";
import type {
  DesktopTelemetryTransport,
  RelayTelemetrySignal,
  TelemetrySessionContext,
} from "../src/main/relay-telemetry-transport.js";

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

type StubTransport = DesktopTelemetryTransport & {
  shipments: Array<{ signal: RelayTelemetrySignal; bodyLength: number }>;
  startContexts: TelemetrySessionContext[];
  stopCount: number;
};

function createStubTransport(): StubTransport {
  const shipments: Array<{
    signal: RelayTelemetrySignal;
    bodyLength: number;
  }> = [];
  const startContexts: TelemetrySessionContext[] = [];
  return {
    shipments,
    startContexts,
    stopCount: 0,
    start(context) {
      this.startContexts.push(context);
    },
    stop() {
      this.stopCount += 1;
    },
    export(signal, body) {
      this.shipments.push({ signal, bodyLength: body.byteLength });
      return Promise.resolve(true);
    },
  };
}

test("ships OTLP traces, logs, and metrics through the relay transport", async () => {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_relay_test",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();

  // The transport is started with the resolved resource identity.
  assert.equal(transport.startContexts.length, 1);
  assert.deepEqual(transport.startContexts[0], {
    appInstallationId: "install_relay_test",
    serviceVersion: "9.9.9",
    deploymentEnvironmentName: "desktop-prod",
  });

  trace.getTracer("relay-otel-test", "1.0.0").startSpan("desktop.boot").end();
  logs.getLogger("relay-otel-test", "1.0.0").emit({
    eventName: "desktop.log",
    body: "relay log body",
  });
  metrics
    .getMeter("relay-otel-test", "1.0.0")
    .createCounter("desktop.boot.count")
    .add(1);

  // shutdown() flushes the Batch processors + metric reader through the
  // exporters, which serialize to protobuf and ship via the transport.
  await runtime.shutdown();

  const signals = new Set(transport.shipments.map((s) => s.signal));
  assert.ok(signals.has(KeylessTelemetrySignal.Traces));
  assert.ok(signals.has(KeylessTelemetrySignal.Logs));
  assert.ok(signals.has(KeylessTelemetrySignal.Metrics));
  for (const shipment of transport.shipments) {
    assert.ok(shipment.bodyLength > 0);
  }
  assert.equal(transport.stopCount, 1);
});

test("OTEL_SDK_DISABLED keeps the relay transport inert", async () => {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { OTEL_SDK_DISABLED: "1" },
    getAppInstallationId: () => "install_disabled",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();

  trace.getTracer("relay-otel-test", "1.0.0").startSpan("desktop.boot").end();
  await runtime.shutdown();

  assert.equal(transport.startContexts.length, 0);
  assert.equal(transport.shipments.length, 0);
});

test("relay handshake context carries the normalized service.version, never 0.0 (FEA-2199)", async () => {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "0.0",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_relay_version",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();

  // The transport handshake must agree with the resource attribute: an unusable
  // version is normalized to the sentinel before BOTH are stamped.
  assert.equal(transport.startContexts.length, 1);
  assert.equal(transport.startContexts[0]?.serviceVersion, "0.0.0-unknown");
  assert.notEqual(transport.startContexts[0]?.serviceVersion, "0.0");
});
