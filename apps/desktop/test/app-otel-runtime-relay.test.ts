import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SpanKind as ContractSpanKind,
  SpanStatusCode as ContractSpanStatusCode,
} from "@closedloop-ai/telemetry-contract/span";
import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { KeylessTelemetrySignal } from "@repo/shared-platform/keyless-telemetry";
import { vi } from "vitest";
import {
  asOtlpRecordArray,
  decodeOtlpAttributes,
  decodeOtlpBytesToHex,
  walkOtlpTraceSpans,
} from "../src/main/otlp/decode-utilities.js";
import {
  getOtlpRequestType,
  OtlpExportKind,
} from "../src/main/otlp/proto-descriptor.js";
import {
  createDesktopOtelRuntime,
  DesktopIpcOperation,
  type DesktopOtelRuntime,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  DesktopAppLifecycleEvent,
  DesktopAppOperatingMode,
} from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import type {
  DesktopTelemetryTransport,
  RelayTelemetrySignal,
  TelemetrySessionContext,
} from "../src/main/telemetry/relay-telemetry-transport.js";
import { asRecord } from "../src/main/util/api-response-utils.js";
import { DesktopOtelSignal } from "../src/shared/renderer-otel-bridge-constants.js";

let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
  vi.restoreAllMocks();
});

type StubTransport = DesktopTelemetryTransport & {
  shipments: Array<{
    signal: RelayTelemetrySignal;
    body: Uint8Array;
    bodyLength: number;
  }>;
  startContexts: TelemetrySessionContext[];
  stopCount: number;
  flushCount: number;
};

function createStubTransport(): StubTransport {
  const shipments: Array<{
    signal: RelayTelemetrySignal;
    body: Uint8Array;
    bodyLength: number;
  }> = [];
  const startContexts: TelemetrySessionContext[] = [];
  return {
    shipments,
    startContexts,
    stopCount: 0,
    flushCount: 0,
    start(context) {
      this.startContexts.push(context);
    },
    stop() {
      this.stopCount += 1;
    },
    flush() {
      this.flushCount += 1;
      return Promise.resolve();
    },
    export(signal, body) {
      this.shipments.push({
        signal,
        body: Uint8Array.from(body),
        bodyLength: body.byteLength,
      });
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

test("runtime SDK paths install W3C trace-context propagation", async () => {
  const runtimeCases = [
    {
      getRuntime: () =>
        createDesktopOtelRuntime({
          appVersion: "9.9.9",
          env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
          getAppInstallationId: () => "install_relay_propagator",
          isPackaged: false,
          telemetryTransport: createStubTransport(),
        }),
      name: "relay",
    },
    {
      getRuntime: () =>
        createDesktopOtelRuntime({
          appVersion: "9.9.9",
          env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
          getAppInstallationId: () => "install_local_propagator",
          isPackaged: false,
        }),
      name: "local-buffer",
    },
  ];

  for (const runtimeCase of runtimeCases) {
    const runtime = runtimeCase.getRuntime();
    activeRuntime = runtime;
    await runtime.start();

    const tracer = trace.getTracer(
      `relay-otel-${runtimeCase.name}-propagator-test`,
      "1.0.0"
    );
    const span = tracer.startSpan(`${runtimeCase.name}.propagator`);
    const carrier: Record<string, string> = {};
    context.with(trace.setSpan(context.active(), span), () => {
      propagation.inject(context.active(), carrier);
    });
    span.end();
    await runtime.shutdown();
    activeRuntime = null;

    const spanContext = span.spanContext();
    assert.equal(
      carrier.traceparent,
      `00-${spanContext.traceId}-${spanContext.spanId}-01`
    );

    trace.disable();
    metrics.disable();
    logs.disable();
  }
});

test("parents IPC perf spans to the cl-desktop activity root in relay OTLP output", async () => {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_relay_parenting",
    getDeviceId: () => "device_relay_parenting",
    getOperatingMode: () => "multiplayer",
    getOrganizationId: () => "org_relay_parenting",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();

  runtime.emitIpcPerfEvent({
    operation: DesktopIpcOperation.List,
    startTimeUnixMs: 1_700_000_000_000,
    durationMs: 37,
    payloadBytes: 4096,
    resultCount: 12,
    sessionCount: 34,
  });
  await runtime.shutdown();

  const spans = decodeExportedTraceSpans(transport);
  const rootSpan = spans.find((span) => span.name === "cl-desktop");
  const ipcSpan = spans.find((span) => span.name === "ipc.list");

  assert.equal(rootSpan?.parentSpanId, "");
  assert.equal(ipcSpan?.traceId, rootSpan?.traceId);
  assert.equal(ipcSpan?.parentSpanId, rootSpan?.spanId);
  assert.equal(
    rootSpan?.attributes[TelemetryAttribute.ServiceVersion],
    "9.9.9"
  );
  assert.equal(
    rootSpan?.attributes[TelemetryAttribute.DeviceId],
    "device_relay_parenting"
  );
  assert.equal(
    rootSpan?.attributes[TelemetryAttribute.AppOperatingMode],
    "multiplayer"
  );
  assert.equal(
    rootSpan?.attributes[TelemetryAttribute.AppOrganizationId],
    "org_relay_parenting"
  );
  assert.equal(
    ipcSpan?.attributes[TelemetryAttribute.IpcOperation],
    DesktopIpcOperation.List
  );
  assert.equal(ipcSpan?.attributes[TelemetryAttribute.DurationMs], 37);
  assert.equal(ipcSpan?.attributes[TelemetryAttribute.IpcPayloadBytes], 4096);
  assert.equal(ipcSpan?.attributes[TelemetryAttribute.IpcResultCount], 12);
  assert.equal(ipcSpan?.attributes[TelemetryAttribute.IpcSessionCount], 34);
  assert.equal(ipcSpan?.statusCode, SpanStatusCode.UNSET);
});

test("ships converted lifecycle sync and exception spans through relay OTLP output", async () => {
  const transport = createStubTransport();
  vi.spyOn(Date, "now").mockImplementation(() => 1_700_000_000_000);
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_relay_converted_spans",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();

  runtime.emitAppLifecycleEvent({
    event: DesktopAppLifecycleEvent.Start,
    operatingMode: DesktopAppOperatingMode.SinglePlayer,
  });
  runtime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.DeadLetter,
    payloadBytes: 300_000,
    latencyMs: 37,
    reason: "locally_oversized",
  });
  runtime.emitAppExceptionEvent({
    error: new Error("Relay exception"),
    origin: AppExceptionOrigin.Main,
  });
  await runtime.shutdown();

  const spans = decodeExportedTraceSpans(transport);
  const rootSpan = spans.find((span) => span.name === "cl-desktop");
  const lifecycleSpan = spans.find((span) => span.name === "app.lifecycle");
  const syncSpan = spans.find((span) => span.name === "sync.batch");
  const exceptionSpan = spans.find((span) => span.name === "exception");

  for (const span of [lifecycleSpan, syncSpan, exceptionSpan]) {
    assert.equal(span?.traceId, rootSpan?.traceId);
    assert.equal(span?.parentSpanId, rootSpan?.spanId);
  }
  assert.equal(
    lifecycleSpan?.attributes[TelemetryAttribute.AppLifecycleEvent],
    DesktopAppLifecycleEvent.Start
  );
  assert.equal(
    syncSpan?.attributes[TelemetryAttribute.SyncReason],
    "locally_oversized"
  );
  assert.equal(syncSpan?.startTimeUnixNano, "1699999999963000000");
  assert.equal(syncSpan?.endTimeUnixNano, "1700000000000000000");
  assert.equal(syncSpan?.statusCode, SpanStatusCode.ERROR);
  assert.equal(exceptionSpan?.statusCode, SpanStatusCode.ERROR);
  assert.equal(
    exceptionSpan?.attributes[TelemetryAttribute.AppExceptionOrigin],
    AppExceptionOrigin.Main
  );
});

test("keeps cl-desktop as a relay root when IPC emit has an active caller span", async () => {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_relay_foreign_parent",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();

  const callerSpan = trace
    .getTracer("relay-otel-foreign-parent-test")
    .startSpan("caller.parent", undefined, ROOT_CONTEXT);
  context.with(trace.setSpan(ROOT_CONTEXT, callerSpan), () => {
    runtime.emitIpcPerfEvent({
      operation: DesktopIpcOperation.List,
      startTimeUnixMs: 1_700_000_000_000,
      durationMs: 37,
      payloadBytes: 4096,
      resultCount: 12,
      sessionCount: 34,
    });
  });
  callerSpan.end();
  await runtime.shutdown();

  const spans = decodeExportedTraceSpans(transport);
  const rootSpan = spans.find((span) => span.name === "cl-desktop");
  const ipcSpan = spans.find((span) => span.name === "ipc.list");
  const unrelatedSpan = spans.find((span) => span.name === "caller.parent");

  assert.equal(rootSpan?.parentSpanId, "");
  assert.notEqual(rootSpan?.traceId, unrelatedSpan?.traceId);
  assert.equal(ipcSpan?.traceId, rootSpan?.traceId);
  assert.equal(ipcSpan?.parentSpanId, rootSpan?.spanId);
});

test("exports errored IPC perf spans with ERROR status in relay OTLP output", async () => {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_relay_error_status",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();

  runtime.emitIpcPerfEvent({
    operation: DesktopIpcOperation.Detail,
    startTimeUnixMs: 1_700_000_000_000,
    durationMs: 19,
    payloadBytes: 0,
    resultCount: 0,
    sessionCount: 34,
    errorType: "DesktopMigrationError",
  });
  await runtime.shutdown();

  const spans = decodeExportedTraceSpans(transport);
  const ipcSpan = spans.find((span) => span.name === "ipc.detail");

  assert.equal(ipcSpan?.statusCode, SpanStatusCode.ERROR);
  assert.equal(ipcSpan?.statusMessage, "DesktopMigrationError");
  assert.equal(
    ipcSpan?.attributes[TelemetryAttribute.ErrorType],
    "DesktopMigrationError"
  );
});

test("ships external renderer trace records through relay OTLP output", async () => {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_relay_renderer_records",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();

  const tracer = trace.getTracer("relay-renderer-test", "1.0.0");
  const mainSpan = tracer.startSpan("main.owner");
  const result = context.with(trace.setSpan(context.active(), mainSpan), () =>
    runtime.exportExternalRecords([
      {
        signal: DesktopOtelSignal.Trace,
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        kind: ContractSpanKind.Internal,
        status: { code: ContractSpanStatusCode.Unset },
        name: "renderer.parent",
        attributes: { "renderer.mode": "relay" },
      },
      {
        signal: DesktopOtelSignal.Trace,
        traceId: "11111111111111111111111111111111",
        spanId: "3333333333333333",
        parentSpanId: "2222222222222222",
        kind: ContractSpanKind.Internal,
        status: {
          code: ContractSpanStatusCode.Error,
          message: "renderer failed",
        },
        name: "renderer.child",
      },
    ])
  );
  mainSpan.end();

  assert.deepEqual(result, {
    ok: true,
    acceptedRecords: 2,
    droppedRecordsCount: 0,
  });
  await runtime.shutdown();

  const spans = decodeExportedTraceSpans(transport);
  const root = spans.find((span) => span.name === "cl-desktop");
  const parent = spans.find((span) => span.name === "renderer.parent");
  const child = spans.find((span) => span.name === "renderer.child");

  assert.equal(parent?.traceId, root?.traceId);
  assert.equal(parent?.spanId, "2222222222222222");
  assert.equal(parent?.parentSpanId, root?.spanId);
  assert.equal(parent?.attributes["renderer.mode"], "relay");
  assert.equal(child?.traceId, root?.traceId);
  assert.equal(child?.spanId, "3333333333333333");
  assert.equal(child?.parentSpanId, "2222222222222222");
  assert.equal(child?.statusCode, SpanStatusCode.ERROR);
  assert.equal(child?.statusMessage, "renderer failed");
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

type DecodedTraceSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, unknown>;
  statusCode: SpanStatusCode;
  statusMessage?: string;
};

function decodeExportedTraceSpans(
  transport: StubTransport
): DecodedTraceSpan[] {
  const traceRequestType = getOtlpRequestType(OtlpExportKind.Traces);
  const spans: DecodedTraceSpan[] = [];
  for (const shipment of transport.shipments.filter(
    (item) => item.signal === KeylessTelemetrySignal.Traces
  )) {
    const request = traceRequestType.toObject(
      traceRequestType.decode(shipment.body),
      { bytes: String, longs: String }
    ) as DecodedTraceRequest;

    for (const span of walkOtlpTraceSpans(
      asOtlpRecordArray(request.resourceSpans)
    )) {
      const statusMessage = optionalStringValue(asRecord(span.status).message);
      spans.push({
        name: stringValue(span.name),
        traceId: decodeOtlpBytesToHex(span.traceId, { bytes: "base64" }),
        spanId: decodeOtlpBytesToHex(span.spanId, { bytes: "base64" }),
        parentSpanId: decodeOtlpBytesToHex(span.parentSpanId, {
          bytes: "base64",
        }),
        startTimeUnixNano: stringValue(span.startTimeUnixNano),
        endTimeUnixNano: stringValue(span.endTimeUnixNano),
        attributes: decodeOtlpAttributes(asOtlpRecordArray(span.attributes)),
        statusCode: statusCodeValue(span.status),
        ...(statusMessage === undefined ? {} : { statusMessage }),
      });
    }
  }
  return spans;
}

type DecodedTraceRequest = {
  resourceSpans?: unknown;
};

function statusCodeValue(value: unknown): SpanStatusCode {
  const code = asRecord(value).code;
  return typeof code === "number" ? code : SpanStatusCode.UNSET;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

test("flush() ships a pending exception without shutting the runtime down (ISS-6328)", async () => {
  // The crash path: emit an exception, then flush. Production uses Batch
  // processors (~5s delay), so before ISS-6328 the span sat in the batch and
  // `app.exit()` — which skips `before-quit` — threw it away.
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: {},
    getAppInstallationId: () => "install_flush_test",
    isPackaged: false,
    telemetryTransport: transport,
  });
  activeRuntime = runtime;
  await runtime.start();

  runtime.emitAppExceptionEvent({
    error: new Error("crashed"),
    origin: AppExceptionOrigin.Main,
  });
  assert.equal(
    transport.shipments.length,
    0,
    "the Batch processor must still be holding the span before flush()"
  );

  await runtime.flush();

  assert.ok(
    transport.shipments.some(
      (shipment) => shipment.signal === KeylessTelemetrySignal.Traces
    ),
    "flush() must push the exception span through to the transport"
  );
  assert.ok(
    transport.flushCount > 0,
    "flush() must also drain the transport's in-flight sends"
  );
  assert.equal(
    transport.stopCount,
    0,
    "flush() must NOT tear the transport down — the app may survive this"
  );

  // Still usable afterwards: the non-Error unhandledRejection path flushes and
  // then lets the app keep running.
  const shipmentsAfterFlush = transport.shipments.length;
  runtime.emitAppExceptionEvent({
    error: new Error("crashed again"),
    origin: AppExceptionOrigin.Main,
  });
  await runtime.flush();
  assert.ok(
    transport.shipments.length > shipmentsAfterFlush,
    "the runtime must still export after a flush"
  );
});

test("flush() is a no-op before start and after shutdown", async () => {
  const transport = createStubTransport();
  const runtime = createDesktopOtelRuntime({
    appVersion: "9.9.9",
    env: {},
    getAppInstallationId: () => "install_flush_state_test",
    isPackaged: false,
    telemetryTransport: transport,
  });

  await runtime.flush();
  assert.equal(transport.flushCount, 0, "nothing to flush before start()");

  await runtime.start();
  await runtime.shutdown();
  const flushCountAfterShutdown = transport.flushCount;

  await runtime.flush();
  assert.equal(
    transport.flushCount,
    flushCountAfterShutdown,
    "a shut-down runtime must not reach the torn-down transport"
  );
});
