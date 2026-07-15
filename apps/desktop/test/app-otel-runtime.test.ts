import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  createDesktopOtelRuntime,
  type DesktopOtelBufferedRecord,
  type DesktopOtelRuntime,
  isOtelSdkDisabled,
  resolveDeploymentEnvironmentName,
} from "../src/main/app-otel-runtime.js";
import {
  createDesktopAppLifecycleTelemetry,
  DesktopAppLifecycleEvent,
  type DesktopAppLifecycleTimerHandle,
  DesktopAppOperatingMode,
  shutdownDesktopOtelRuntime,
  startDesktopOtelRuntimeForBoot,
} from "../src/main/app-otel-runtime-lifecycle.js";
import { getDesktopAppOperatingModeForTelemetry } from "../src/main/app-telemetry-operating-mode.js";
import { UNRESOLVED_DESKTOP_SERVICE_VERSION } from "../src/main/desktop-service-version.js";
import {
  DesktopOtelSignal,
  RendererOtelExportFailureReason,
} from "../src/shared/renderer-otel-bridge-constants.js";

let activeRuntime: DesktopOtelRuntime | null = null;

const RESOURCE_LEAK_ERROR_PATTERN = /resource leak/;
const TRANSIENT_INSTALLATION_ID_FAILURE_PATTERN =
  /transient installation id failure/;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

test("exports trace, log, and metric records to the local buffer with app resource attributes", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();

  trace
    .getTracer("desktop-otel-test", "1.0.0")
    .startSpan("desktop.boot", {
      attributes: {
        "test.signal": "trace",
      },
    })
    .end();
  logs.getLogger("desktop-otel-test", "1.0.0").emit({
    eventName: "desktop.log",
    body: "local log body",
    attributes: {
      "test.signal": "log",
    },
  });
  metrics
    .getMeter("desktop-otel-test", "1.0.0")
    .createCounter("desktop.boot.count")
    .add(1, { "test.signal": "metric" });

  await runtime.shutdown();

  const records = runtime.getBufferedRecords();
  const traceRecord = records.find(
    (record) => record.signal === DesktopOtelSignal.Trace
  );
  const logRecord = records.find(
    (record) => record.signal === DesktopOtelSignal.Log
  );
  const metricRecord = records.find(
    (record) => record.signal === DesktopOtelSignal.Metric
  );

  assert.equal(traceRecord?.name, "desktop.boot");
  assert.equal(logRecord?.name, "desktop.log");
  assert.equal(logRecord?.body, "local log body");
  assert.equal(metricRecord?.name, "desktop.boot.count");
  assert.deepEqual(
    collectResourceAttributeMismatches(traceRecord?.resourceAttributes),
    []
  );
  assert.deepEqual(
    collectResourceAttributeMismatches(logRecord?.resourceAttributes),
    []
  );
  assert.deepEqual(
    collectResourceAttributeMismatches(metricRecord?.resourceAttributes),
    []
  );
});

test("backstop guard rewrites an unusable service.version to the sentinel, never 0.0 (FEA-2199)", async () => {
  const runtime = createTestRuntime({
    appVersion: "0.0",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_unusable_version",
  });
  await runtime.start();
  logs.getLogger("desktop-otel-test", "1.0.0").emit({
    eventName: "desktop.log",
    attributes: { "test.signal": "log" },
  });
  await runtime.shutdown();

  const record = runtime
    .getBufferedRecords()
    .find((item) => item.signal === DesktopOtelSignal.Log);
  assert.equal(
    record?.resourceAttributes[TelemetryAttribute.ServiceVersion],
    UNRESOLVED_DESKTOP_SERVICE_VERSION
  );
  assert.notEqual(
    record?.resourceAttributes[TelemetryAttribute.ServiceVersion],
    "0.0"
  );
});

test("backstop guard passes a usable service.version through unchanged (FEA-2199)", async () => {
  const runtime = createTestRuntime({
    appVersion: "0.16.109",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_usable_version",
  });
  await runtime.start();
  logs.getLogger("desktop-otel-test", "1.0.0").emit({
    eventName: "desktop.log",
    attributes: { "test.signal": "log" },
  });
  await runtime.shutdown();

  const record = runtime
    .getBufferedRecords()
    .find((item) => item.signal === DesktopOtelSignal.Log);
  assert.equal(
    record?.resourceAttributes[TelemetryAttribute.ServiceVersion],
    "0.16.109"
  );
});

test("OTEL_SDK_DISABLED disables startup without creating resource or buffer records", async () => {
  let installationIdRequested = false;
  let heartbeatCallback: (() => void) | null = null;
  const runtime = createTestRuntime({
    env: { OTEL_SDK_DISABLED: "TrUe" },
    getAppInstallationId: () => {
      installationIdRequested = true;
      return "install_disabled";
    },
  });
  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    setIntervalFn: (callback) => {
      heartbeatCallback = callback;
      return {};
    },
    clearIntervalFn: () => {},
    logWarning: () => {},
  });

  await runtime.start();
  lifecycle.start();
  heartbeatCallback?.();
  lifecycle.emitShutdown();
  trace.getTracer("desktop-otel-test").startSpan("disabled").end();
  await runtime.shutdown();

  assert.equal(installationIdRequested, false);
  assert.deepEqual(runtime.getBufferedRecords(), []);
  assert.equal(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "1" }), true);
  assert.equal(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "yes" }), true);
  assert.equal(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "0" }), false);
  assert.equal(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "false" }), false);
  assert.equal(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "" }), false);
});

test("emits app lifecycle records through the typed app schema channel", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();

  runtime.emitAppLifecycleEvent({
    event: DesktopAppLifecycleEvent.Start,
    operatingMode: DesktopAppOperatingMode.SinglePlayer,
  });
  runtime.emitAppLifecycleEvent({
    event: DesktopAppLifecycleEvent.Heartbeat,
    operatingMode: DesktopAppOperatingMode.Multiplayer,
  });
  runtime.emitAppLifecycleEvent({
    event: DesktopAppLifecycleEvent.Shutdown,
    operatingMode: DesktopAppOperatingMode.SinglePlayer,
  });
  await runtime.shutdown();

  const lifecycleRecords = runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.signal === DesktopOtelSignal.Log &&
        record.name === "app.lifecycle"
    );

  assert.deepEqual(
    lifecycleRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.AppLifecycleEvent]
    ),
    [
      DesktopAppLifecycleEvent.Start,
      DesktopAppLifecycleEvent.Heartbeat,
      DesktopAppLifecycleEvent.Shutdown,
    ]
  );
  assert.deepEqual(
    lifecycleRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.AppOperatingMode]
    ),
    [
      DesktopAppOperatingMode.SinglePlayer,
      DesktopAppOperatingMode.Multiplayer,
      DesktopAppOperatingMode.SinglePlayer,
    ]
  );

  for (const record of lifecycleRecords) {
    assert.equal(
      record.attributes?.[TelemetryEmitMetadataKey.SchemaName],
      TelemetrySchemaName.App
    );
    assert.deepEqual(
      collectResourceAttributeMismatches(record.resourceAttributes),
      []
    );
  }
});

test("emits IPC perf wide-event spans and no-ops before the runtime starts", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });

  // No-op before start: must not throw and must not buffer anything.
  runtime.emitIpcPerfEvent({
    operation: "usage",
    startTimeUnixMs: 1_700_000_000_000,
    durationMs: 5,
    payloadBytes: 16,
    resultCount: 1,
    sessionCount: 3,
  });

  await runtime.start();

  runtime.emitIpcPerfEvent({
    operation: "list",
    startTimeUnixMs: 1_700_000_000_000,
    durationMs: 1234,
    payloadBytes: 4096,
    resultCount: 50,
    sessionCount: 2048,
  });
  runtime.emitIpcPerfEvent({
    operation: "detail",
    startTimeUnixMs: 1_700_000_000_000,
    durationMs: 3000,
    payloadBytes: 0,
    resultCount: 0,
    sessionCount: 2048,
    errorType: "DesktopMigrationError",
  });

  await runtime.shutdown();

  const spans = runtime
    .getBufferedRecords()
    .filter((record) => record.signal === DesktopOtelSignal.Trace);
  const ipcSpans = spans.filter((record) => record.name?.startsWith("ipc."));

  // Only the two post-start spans — the pre-start emit was a no-op.
  assert.deepEqual(ipcSpans.map((record) => record.name).sort(), [
    "ipc.detail",
    "ipc.list",
  ]);

  const listSpan = ipcSpans.find((record) => record.name === "ipc.list");
  assert.equal(listSpan?.attributes?.[TelemetryAttribute.IpcOperation], "list");
  assert.equal(listSpan?.attributes?.[TelemetryAttribute.DurationMs], 1234);
  assert.equal(
    listSpan?.attributes?.[TelemetryAttribute.IpcPayloadBytes],
    4096
  );
  assert.equal(listSpan?.attributes?.[TelemetryAttribute.IpcResultCount], 50);
  assert.equal(
    listSpan?.attributes?.[TelemetryAttribute.IpcSessionCount],
    2048
  );
  assert.equal(listSpan?.attributes?.[TelemetryAttribute.ErrorType], undefined);
  assert.deepEqual(
    collectResourceAttributeMismatches(listSpan?.resourceAttributes),
    []
  );

  // Failed calls carry error.type (and the span is marked ERROR for tail
  // retention) with zeroed payload/result.
  const detailSpan = ipcSpans.find((record) => record.name === "ipc.detail");
  assert.equal(
    detailSpan?.attributes?.[TelemetryAttribute.ErrorType],
    "DesktopMigrationError"
  );
  assert.equal(detailSpan?.attributes?.[TelemetryAttribute.IpcPayloadBytes], 0);
});

test("attaches the organization id to multiplayer lifecycle records but never to single-player ones (FEA-1996)", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();

  runtime.emitAppLifecycleEvent({
    event: DesktopAppLifecycleEvent.Start,
    operatingMode: DesktopAppOperatingMode.Multiplayer,
    organizationId: "019c24db-a261-738f-8eff-ea275fb27470",
  });
  // Single-player: even if a caller passes no org, the record must omit it.
  runtime.emitAppLifecycleEvent({
    event: DesktopAppLifecycleEvent.Heartbeat,
    operatingMode: DesktopAppOperatingMode.SinglePlayer,
  });
  await runtime.shutdown();

  const lifecycleRecords = runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.signal === DesktopOtelSignal.Log &&
        record.name === "app.lifecycle"
    );

  const [multiplayer, singlePlayer] = lifecycleRecords;
  assert.equal(
    multiplayer?.attributes?.[TelemetryAttribute.AppOrganizationId],
    "019c24db-a261-738f-8eff-ea275fb27470"
  );
  assert.equal(
    Object.hasOwn(
      singlePlayer?.attributes ?? {},
      TelemetryAttribute.AppOrganizationId
    ),
    false,
    "single-player lifecycle records must not carry an organization id"
  );
});

test("the lifecycle driver threads the resolved organization id into emitted events (FEA-1996)", () => {
  const inputs: Array<{ event: DesktopAppLifecycleEvent; org?: string }> = [];
  const recordingRuntime: DesktopOtelRuntime = {
    start: () => Promise.resolve(),
    emitAppLifecycleEvent: (input) =>
      inputs.push({ event: input.event, org: input.organizationId }),
    emitAppExceptionEvent: () => {},
    shutdown: () => Promise.resolve(),
    getBufferedRecords: () => [],
    resetBuffer: () => {},
    exportExternalRecords: () => ({
      ok: false,
      reason: RendererOtelExportFailureReason.Unavailable,
    }),
  };

  let organizationId: string | undefined = "org_multiplayer";
  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime: recordingRuntime,
    getOperatingMode: () => DesktopAppOperatingMode.Multiplayer,
    getOrganizationId: () => organizationId,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
    logWarning: () => {},
  });

  lifecycle.start(); // multiplayer: org present
  organizationId = undefined; // simulate sign-out before shutdown
  lifecycle.emitShutdown(); // single-player: org omitted

  assert.deepEqual(inputs, [
    { event: DesktopAppLifecycleEvent.Start, org: "org_multiplayer" },
    { event: DesktopAppLifecycleEvent.Shutdown, org: undefined },
  ]);
});

test("emits scrubbed app exception records through the typed app schema channel", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();
  const error = new Error("Unexpected shutdown");
  error.stack = [
    "Error: Unexpected shutdown",
    "    at DesktopApplication.bootstrap (app.ts:12:3)",
  ].join("\n");

  runtime.emitAppExceptionEvent({
    error,
    origin: AppExceptionOrigin.Main,
  });
  await runtime.shutdown();

  const record = runtime
    .getBufferedRecords()
    .find(
      (item) =>
        item.signal === DesktopOtelSignal.Log && item.name === "exception"
    );

  assert.equal(record?.attributes?.[TelemetryAttribute.ExceptionType], "Error");
  assert.equal(
    record?.attributes?.[TelemetryAttribute.ExceptionMessage],
    "Unexpected shutdown"
  );
  assert.equal(
    record?.attributes?.[TelemetryAttribute.ExceptionStacktrace],
    "Error: Unexpected shutdown at DesktopApplication.bootstrap (app.ts:12:3)"
  );
  assert.equal(
    record?.attributes?.[TelemetryAttribute.AppExceptionOrigin],
    AppExceptionOrigin.Main
  );
  assert.equal(
    record?.attributes?.[TelemetryEmitMetadataKey.SchemaName],
    TelemetrySchemaName.App
  );
  assert.deepEqual(
    collectResourceAttributeMismatches(record?.resourceAttributes),
    []
  );
});

test("app exception sanitizer redacts unsafe optional fields without dropping the event", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();
  const error = new Error("failed with token sk-proj-secret");
  error.stack = "Error: failed at /Users/example/project/app.ts";

  runtime.emitAppExceptionEvent({
    error,
    origin: AppExceptionOrigin.Main,
  });
  await runtime.shutdown();

  const record = runtime
    .getBufferedRecords()
    .find((item) => item.name === "exception");

  assert.equal(record?.attributes?.[TelemetryAttribute.ExceptionType], "Error");
  assert.equal(
    record?.attributes?.[TelemetryAttribute.ExceptionMessage],
    "[redacted]"
  );
  assert.equal(
    record?.attributes?.[TelemetryAttribute.ExceptionStacktrace],
    "[redacted]"
  );
  assert.equal(Object.values(record?.attributes ?? {}).includes(null), false);
});

test("app exception emission no-ops when runtime is unavailable or disabled", async () => {
  const idleRuntime = createTestRuntime();
  idleRuntime.emitAppExceptionEvent({
    error: new Error("idle"),
    origin: AppExceptionOrigin.Main,
  });
  assert.deepEqual(idleRuntime.getBufferedRecords(), []);

  const disabledRuntime = createTestRuntime({
    env: { OTEL_SDK_DISABLED: "1" },
  });
  await disabledRuntime.start();
  disabledRuntime.emitAppExceptionEvent({
    error: new Error("disabled"),
    origin: AppExceptionOrigin.Main,
  });
  assert.deepEqual(disabledRuntime.getBufferedRecords(), []);
});

test("emits sync.batch records through the typed sync schema channel", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();

  runtime.emitSyncBatchEvent({
    outcome: "success",
    payloadBytes: 2048,
    latencyMs: 37,
  });
  runtime.emitSyncBatchEvent({
    outcome: "failure",
    payloadBytes: 512,
    latencyMs: 9,
  });
  // dead-lettered before any send → no latency to report.
  runtime.emitSyncBatchEvent({
    outcome: "dead_letter",
    payloadBytes: 300_000,
  });
  await runtime.shutdown();

  const syncRecords = runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.signal === DesktopOtelSignal.Log && record.name === "sync.batch"
    );

  assert.equal(syncRecords.length, 3);
  for (const record of syncRecords) {
    assert.equal(
      record.attributes?.[TelemetryEmitMetadataKey.SchemaName],
      TelemetrySchemaName.Sync
    );
    assert.equal(record.attributes?.[TelemetryAttribute.SyncEvent], "batch");
    assert.equal(record.instrumentationScope?.name, "closedloop-desktop-sync");
    assert.deepEqual(
      collectResourceAttributeMismatches(record.resourceAttributes),
      []
    );
  }
  assert.deepEqual(
    syncRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.SyncOutcome]
    ),
    ["success", "failure", "dead_letter"]
  );
  assert.deepEqual(
    syncRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.SyncPayloadBytes]
    ),
    [2048, 512, 300_000]
  );
  assert.deepEqual(
    syncRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.SyncLatencyMs]
    ),
    [37, 9, undefined]
  );
});

test("sync batch emission no-ops when runtime is unavailable or disabled", async () => {
  const idleRuntime = createTestRuntime();
  idleRuntime.emitSyncBatchEvent({
    outcome: "success",
    payloadBytes: 1,
    latencyMs: 1,
  });
  assert.deepEqual(idleRuntime.getBufferedRecords(), []);

  const disabledRuntime = createTestRuntime({
    env: { OTEL_SDK_DISABLED: "1" },
  });
  await disabledRuntime.start();
  disabledRuntime.emitSyncBatchEvent({
    outcome: "dead_letter",
    payloadBytes: 999_999,
  });
  assert.deepEqual(disabledRuntime.getBufferedRecords(), []);
});

test("app lifecycle derives operating mode from DesktopApplication API-key status path", async () => {
  const statusReads: boolean[] = [];
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();

  for (const hasApiKey of [true, false]) {
    const lifecycle = createDesktopAppLifecycleTelemetry({
      runtime,
      getOperatingMode: () =>
        getDesktopAppOperatingModeForTelemetry({
          getStatus: () => {
            statusReads.push(hasApiKey);
            return { hasApiKey };
          },
        }),
      setIntervalFn: () => ({}),
      clearIntervalFn: () => {},
      logWarning: () => {},
    });

    lifecycle.start();
    lifecycle.stop();
  }
  await runtime.shutdown();

  const lifecycleRecords = collectAppLifecycleRecords(runtime);
  assert.deepEqual(statusReads, [true, false]);
  assert.deepEqual(
    lifecycleRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.AppOperatingMode]
    ),
    [DesktopAppOperatingMode.Multiplayer, DesktopAppOperatingMode.SinglePlayer]
  );

  for (const record of lifecycleRecords) {
    const attributes = record.attributes ?? {};
    const identityAttributeKeys = Object.keys(attributes).filter((key) => {
      const normalized = key.toLowerCase();
      return normalized.includes("org") || normalized.includes("user");
    });

    assert.deepEqual(identityAttributeKeys, []);
    assert.equal(Object.values(attributes).includes(null), false);
  }
});

test("app lifecycle controller emits start once and cleans heartbeat timers", () => {
  const emittedEvents: string[] = [];
  const clearedTimers: DesktopAppLifecycleTimerHandle[] = [];
  let heartbeatCallback: (() => void) | null = null;
  let unrefCalled = false;
  const timerHandle = {
    unref: () => {
      unrefCalled = true;
    },
  };
  const runtime = createRecordingRuntime((event) => emittedEvents.push(event));
  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.Multiplayer,
    heartbeatIntervalMs: 123,
    setIntervalFn: (callback, intervalMs) => {
      assert.equal(intervalMs, 123);
      heartbeatCallback = callback;
      return timerHandle;
    },
    clearIntervalFn: (handle) => clearedTimers.push(handle),
    logWarning: () => {},
  });

  lifecycle.start();
  lifecycle.start();

  assert.deepEqual(emittedEvents, [DesktopAppLifecycleEvent.Start]);
  assert.equal(unrefCalled, true);
  assert.equal(clearedTimers.length, 0);

  heartbeatCallback?.();
  assert.deepEqual(emittedEvents, [
    DesktopAppLifecycleEvent.Start,
    DesktopAppLifecycleEvent.Heartbeat,
  ]);

  lifecycle.stop();
  heartbeatCallback?.();
  lifecycle.stop();

  assert.deepEqual(clearedTimers, [timerHandle]);
  assert.deepEqual(emittedEvents, [
    DesktopAppLifecycleEvent.Start,
    DesktopAppLifecycleEvent.Heartbeat,
  ]);
});

test("app lifecycle shutdown emits before runtime shutdown and stays idempotent", async () => {
  const orderedCalls: string[] = [];
  const runtime = createRecordingRuntime(
    (event) => orderedCalls.push(event),
    () => orderedCalls.push("runtime.shutdown")
  );
  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    logWarning: () => {},
  });

  lifecycle.emitShutdown();
  lifecycle.emitShutdown();
  await shutdownDesktopOtelRuntime({
    runtime,
    logWarning: () => {},
  });

  assert.deepEqual(orderedCalls, [
    DesktopAppLifecycleEvent.Shutdown,
    "runtime.shutdown",
  ]);
});

test("app lifecycle warnings are sanitized and do not block start heartbeat or shutdown", () => {
  const warnings: Array<{ tag: string; message: string }> = [];
  let heartbeatCallback: (() => void) | null = null;
  const runtime = createRecordingRuntime(() => {
    throw new Error(
      "app.installation.id=install_0123456789abcdef path=/Users/example stack=secret"
    );
  });
  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    setIntervalFn: (callback) => {
      heartbeatCallback = callback;
      return {};
    },
    clearIntervalFn: () => {},
    logWarning: (tag, message) => warnings.push({ tag, message }),
  });

  lifecycle.start();
  heartbeatCallback?.();
  lifecycle.emitShutdown();

  assert.deepEqual(warnings, [
    {
      tag: "otel",
      message:
        "OpenTelemetry app lifecycle start emit failed; continuing Desktop boot.",
    },
    {
      tag: "otel",
      message:
        "OpenTelemetry app lifecycle heartbeat emit failed; continuing Desktop runtime.",
    },
    {
      tag: "otel",
      message:
        "OpenTelemetry app lifecycle shutdown emit failed; continuing Desktop shutdown.",
    },
  ]);
  for (const warning of warnings) {
    assert.equal(warning.message.includes("install_0123456789abcdef"), false);
    assert.equal(warning.message.includes("/Users/example"), false);
    assert.equal(warning.message.includes("secret"), false);
  }
});

test("local buffer drops oldest records and exposes dropped count", async () => {
  const runtime = createTestRuntime({ bufferLimit: 2 });
  await runtime.start();
  const tracer = trace.getTracer("desktop-otel-test");

  tracer.startSpan("first").end();
  tracer.startSpan("second").end();
  tracer.startSpan("third").end();
  await runtime.shutdown();

  const records = runtime.getBufferedRecords();
  assert.deepEqual(
    records.map((record) => record.name),
    ["second", "third"]
  );
  assert.equal(records.at(-1)?.droppedRecordsCount, 1);
});

test("external renderer records append with main-owned resource attributes", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();

  const result = runtime.exportExternalRecords([
    {
      signal: DesktopOtelSignal.Trace,
      instrumentationScope: { name: "renderer-test" },
      name: "renderer.span",
      attributes: { "renderer.mode": "test" },
    },
  ]);

  assert.deepEqual(result, {
    ok: true,
    acceptedRecords: 1,
    droppedRecordsCount: 0,
  });
  const record = runtime
    .getBufferedRecords()
    .find((item) => item.name === "renderer.span");
  assert.equal(record?.attributes?.["renderer.mode"], "test");
  assert.deepEqual(
    collectResourceAttributeMismatches(record?.resourceAttributes),
    []
  );
  assert.equal(record?.resourceAttributes["device.id"], undefined);
});

test("exportExternalRecords reports per-call dropped count, not cumulative", async () => {
  const runtime = createTestRuntime({ bufferLimit: 2 });
  await runtime.start();

  const record = (name: string) => ({
    signal: DesktopOtelSignal.Trace,
    name,
  });

  // Fills the buffer to its limit without evicting anything.
  assert.deepEqual(
    runtime.exportExternalRecords([record("r1"), record("r2")]),
    {
      ok: true,
      acceptedRecords: 2,
      droppedRecordsCount: 0,
    }
  );

  // Evicts the two oldest; delta for THIS call is 2.
  assert.deepEqual(
    runtime.exportExternalRecords([record("r3"), record("r4")]),
    {
      ok: true,
      acceptedRecords: 2,
      droppedRecordsCount: 2,
    }
  );

  // Evicts two more. The buffer's cumulative dropped count is now 4, but the
  // per-call delta must still report 2 — proving the response is not the
  // cumulative since-reset total.
  assert.deepEqual(
    runtime.exportExternalRecords([record("r5"), record("r6")]),
    {
      ok: true,
      acceptedRecords: 2,
      droppedRecordsCount: 2,
    }
  );
});

test("exportExternalRecords dropped delta excludes pre-existing main-process drops", async () => {
  const runtime = createTestRuntime({ bufferLimit: 2 });
  await runtime.start();

  // Main-process spans overflow the buffer first, accumulating a cumulative
  // drop count that predates any renderer export.
  const tracer = trace.getTracer("desktop-otel-test");
  tracer.startSpan("m1").end();
  tracer.startSpan("m2").end();
  tracer.startSpan("m3").end();

  // This renderer export evicts exactly one record. The response must report
  // that single per-call eviction, NOT the buffer's cumulative total (which
  // already includes the main-process drop). A regression to returning the
  // cumulative count would surface here as droppedRecordsCount: 2.
  const result = runtime.exportExternalRecords([
    { signal: DesktopOtelSignal.Trace, name: "renderer.span" },
  ]);

  assert.deepEqual(result, {
    ok: true,
    acceptedRecords: 1,
    droppedRecordsCount: 1,
  });
});

test("external renderer records no-op when runtime is unavailable or disabled", async () => {
  const idleRuntime = createTestRuntime();
  assert.deepEqual(idleRuntime.exportExternalRecords([]), {
    ok: false,
    reason: RendererOtelExportFailureReason.Unavailable,
  });

  const disabledRuntime = createTestRuntime({
    env: { OTEL_SDK_DISABLED: "1" },
  });
  await disabledRuntime.start();
  assert.deepEqual(disabledRuntime.exportExternalRecords([]), {
    ok: false,
    reason: RendererOtelExportFailureReason.Disabled,
  });
});

test("start and shutdown are idempotent", async () => {
  const runtime = createTestRuntime();

  await Promise.all([runtime.start(), runtime.start()]);
  trace.getTracer("desktop-otel-test").startSpan("single-export").end();
  await runtime.shutdown();
  await runtime.shutdown();

  const traceRecords = runtime
    .getBufferedRecords()
    .filter((record) => record.signal === DesktopOtelSignal.Trace);
  assert.equal(traceRecords.length, 1);
  assert.equal(traceRecords[0]?.name, "single-export");
});

test("shutdown resolves after startup failure without rethrowing the cached rejection", async () => {
  const runtime = createTestRuntime({
    getAppInstallationId: () => {
      throw new Error("install_0123456789abcdef resource leak");
    },
  });

  await assert.rejects(runtime.start(), RESOURCE_LEAK_ERROR_PATTERN);
  await runtime.shutdown();
  await runtime.shutdown();

  assert.deepEqual(runtime.getBufferedRecords(), []);
});

test("startup failure clears the cached promise so a later start can recover", async () => {
  let startAttempts = 0;
  const runtime = createTestRuntime({
    getAppInstallationId: () => {
      startAttempts += 1;
      if (startAttempts === 1) {
        throw new Error("transient installation id failure");
      }
      return "install_recovered";
    },
  });

  await assert.rejects(
    runtime.start(),
    TRANSIENT_INSTALLATION_ID_FAILURE_PATTERN
  );
  await runtime.start();
  trace.getTracer("desktop-otel-test").startSpan("recovered").end();
  await runtime.shutdown();

  assert.equal(startAttempts, 2);
  assert.equal(
    runtime.getBufferedRecords().some((record) => record.name === "recovered"),
    true
  );
});

test("boot lifecycle logs safe warning and continues after runtime start rejection", async () => {
  const warnings: Array<{ tag: string; message: string }> = [];
  let downstreamReached = false;
  const runtime = createRejectingRuntime({
    startError: new Error(
      "app.installation.id=install_0123456789abcdef resource={secret}"
    ),
  });

  await startDesktopOtelRuntimeForBoot({
    runtime,
    logWarning: (tag, message) => warnings.push({ tag, message }),
  });
  downstreamReached = true;

  assert.equal(downstreamReached, true);
  assert.deepEqual(warnings, [
    {
      tag: "otel",
      message: "OpenTelemetry bootstrap failed; continuing Desktop boot.",
    },
  ]);
  assert.equal(
    warnings[0]?.message.includes("install_0123456789abcdef"),
    false
  );
  assert.equal(warnings[0]?.message.includes("resource={secret}"), false);
});

test("shutdown lifecycle logs safe warning and preserves downstream shutdown result path", async () => {
  const warnings: Array<{ tag: string; message: string }> = [];
  let shutdownResultPathReached = false;
  const runtime = createRejectingRuntime({
    shutdownError: new Error(
      "app.installation.id=install_0123456789abcdef resource={secret}"
    ),
  });

  await shutdownDesktopOtelRuntime({
    runtime,
    logWarning: (tag, message) => warnings.push({ tag, message }),
  });
  shutdownResultPathReached = true;

  assert.equal(shutdownResultPathReached, true);
  assert.deepEqual(warnings, [
    {
      tag: "otel",
      message: "OpenTelemetry shutdown failed; continuing Desktop shutdown.",
    },
  ]);
  assert.equal(
    warnings[0]?.message.includes("install_0123456789abcdef"),
    false
  );
  assert.equal(warnings[0]?.message.includes("resource={secret}"), false);
});

test("deployment environment defaults are bounded and package-aware", () => {
  assert.equal(
    resolveDeploymentEnvironmentName({
      env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "stage" },
      isPackaged: true,
    }),
    "stage"
  );
  assert.equal(
    resolveDeploymentEnvironmentName({
      env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "bad\nvalue" },
      isPackaged: true,
    }),
    "production"
  );
  assert.equal(
    resolveDeploymentEnvironmentName({
      env: {},
      isPackaged: false,
    }),
    "development"
  );
});

function createTestRuntime(
  options: Partial<Parameters<typeof createDesktopOtelRuntime>[0]> = {}
): DesktopOtelRuntime {
  activeRuntime = createDesktopOtelRuntime({
    appVersion: "0.0.0-test",
    bufferLimit: 100,
    env: {},
    getAppInstallationId: () => "install_test",
    isPackaged: false,
    metricExportIntervalMs: 60_000,
    ...options,
  });
  return activeRuntime;
}

function createRejectingRuntime({
  startError,
  shutdownError,
}: {
  startError?: Error;
  shutdownError?: Error;
}): DesktopOtelRuntime {
  return {
    start() {
      if (startError) {
        return Promise.reject(startError);
      }
      return Promise.resolve();
    },
    emitAppLifecycleEvent() {},
    emitAppExceptionEvent() {},
    emitIpcPerfEvent() {},
    emitSyncBatchEvent() {},
    shutdown() {
      if (shutdownError) {
        return Promise.reject(shutdownError);
      }
      return Promise.resolve();
    },
    getBufferedRecords() {
      return [];
    },
    resetBuffer() {},
    exportExternalRecords() {
      return {
        ok: false,
        reason: RendererOtelExportFailureReason.Unavailable,
      };
    },
  };
}

function createRecordingRuntime(
  onEmit: (event: DesktopAppLifecycleEvent) => void,
  onShutdown: () => void = () => {}
): DesktopOtelRuntime {
  return {
    start() {
      return Promise.resolve();
    },
    emitAppLifecycleEvent(input) {
      onEmit(input.event);
    },
    emitAppExceptionEvent() {},
    emitIpcPerfEvent() {},
    emitSyncBatchEvent() {},
    shutdown() {
      onShutdown();
      return Promise.resolve();
    },
    getBufferedRecords() {
      return [];
    },
    resetBuffer() {},
    exportExternalRecords() {
      return {
        ok: false,
        reason: RendererOtelExportFailureReason.Unavailable,
      };
    },
  };
}

function collectAppLifecycleRecords(
  runtime: DesktopOtelRuntime
): DesktopOtelBufferedRecord[] {
  return runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.signal === DesktopOtelSignal.Log &&
        record.name === "app.lifecycle"
    );
}

function collectResourceAttributeMismatches(
  resourceAttributes: Record<string, unknown> | undefined
): string[] {
  if (!resourceAttributes) {
    return ["resource missing"];
  }

  const mismatches: string[] = [];
  if (
    resourceAttributes[TelemetryAttribute.ServiceName] !== "closedloop-desktop"
  ) {
    mismatches.push(TelemetryAttribute.ServiceName);
  }
  if (resourceAttributes[TelemetryAttribute.ServiceVersion] !== "1.2.3") {
    mismatches.push(TelemetryAttribute.ServiceVersion);
  }
  if (
    resourceAttributes[TelemetryAttribute.AppInstallationId] !==
    "install_0123456789abcdef"
  ) {
    mismatches.push(TelemetryAttribute.AppInstallationId);
  }
  if (
    resourceAttributes[TelemetryAttribute.DeploymentEnvironmentName] !==
    "desktop-prod"
  ) {
    mismatches.push(TelemetryAttribute.DeploymentEnvironmentName);
  }
  if (resourceAttributes["telemetry.sdk.name"] !== "opentelemetry") {
    mismatches.push("telemetry.sdk.name");
  }
  if ("device.id" in resourceAttributes) {
    mismatches.push("device.id");
  }
  return mismatches;
}
