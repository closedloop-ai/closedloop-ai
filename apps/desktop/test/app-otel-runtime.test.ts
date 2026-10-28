import assert from "node:assert/strict";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import { SpanStatusCode } from "@closedloop-ai/telemetry-contract/span";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ListQueryRefusal } from "@repo/api/src/types/list-query-expression";
import {
  ListQueryExecution,
  ListQuerySource,
} from "@repo/api/src/types/list-query-observability";
import { afterEach, test } from "vitest";
import {
  DESKTOP_ACTIVITY_ROOT_IDLE_TIMEOUT_MS,
  DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS,
} from "../src/main/telemetry/app-otel-runtime.js";
import { DesktopIpcOperation } from "../src/main/telemetry/app-otel-runtime-ipc.js";
import {
  createDesktopAppLifecycleTelemetry,
  DesktopAppLifecycleEvent,
  DesktopAppOperatingMode,
} from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import {
  isOtelSdkDisabled,
  resolveDeploymentEnvironmentName,
} from "../src/main/telemetry/app-otel-runtime-sdk.js";
import { UNRESOLVED_DESKTOP_SERVICE_VERSION } from "../src/main/util/desktop-service-version.js";
import { DesktopOtelSignal } from "../src/shared/renderer-otel-bridge-constants.js";
import {
  collectResourceAttributeMismatches,
  createManualTimers,
  createTrackedRuntimeFactory,
  ipcInputAt,
} from "./app-otel-runtime-test-helpers.js";

const { createTestRuntime, resetTrackedRuntime } =
  createTrackedRuntimeFactory();

const RESOURCE_LEAK_ERROR_PATTERN = /resource leak/;
const TRANSIENT_INSTALLATION_ID_FAILURE_PATTERN =
  /transient installation id failure/;

afterEach(resetTrackedRuntime);

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
  // ISS-7497: metrics are the one signal that does NOT get the full desktop
  // resource. Traces and logs are read one install at a time, so
  // `app.installation.id` and `device.id` are what make a retained record
  // useful; a metric is a fleet aggregate, and the same two keys would put a
  // stable per-device identifier into the metrics label space and shard every
  // counter into one time series per install. The two assertions above are the
  // positive control for this one — they require both identifiers on the trace
  // and log records emitted by this same runtime.
  assert.deepEqual(metricRecord?.resourceAttributes, {
    "service.name": "cl-desktop",
    "service.version": "1.2.3",
    "deployment.environment.name": "desktop-prod",
  });
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
  let deviceIdRequested = false;
  let organizationIdRequested = false;
  let operatingModeRequested = false;
  // Held on an object so TypeScript does not narrow the capture to `null`:
  // the assignment happens inside the injected `setIntervalFn`, which
  // control-flow analysis cannot see.
  const heartbeat: { callback: (() => void) | null } = { callback: null };
  const runtime = createTestRuntime({
    env: { OTEL_SDK_DISABLED: "TrUe" },
    getAppInstallationId: () => {
      installationIdRequested = true;
      return "install_disabled";
    },
    getDeviceId: () => {
      deviceIdRequested = true;
      return "device_disabled";
    },
    getOperatingMode: () => {
      operatingModeRequested = true;
      return DesktopAppOperatingMode.Multiplayer;
    },
    getOrganizationId: () => {
      organizationIdRequested = true;
      return "org_disabled";
    },
  });
  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    setIntervalFn: (callback) => {
      heartbeat.callback = callback;
      return {};
    },
    clearIntervalFn: () => {},
    logWarning: () => {},
  });

  await runtime.start();
  lifecycle.start();
  heartbeat.callback?.();
  lifecycle.emitShutdown();
  trace.getTracer("desktop-otel-test").startSpan("disabled").end();
  await runtime.shutdown();

  assert.equal(installationIdRequested, false);
  assert.equal(deviceIdRequested, false);
  assert.equal(organizationIdRequested, false);
  assert.equal(operatingModeRequested, false);
  assert.deepEqual(runtime.getBufferedRecords(), []);
  assert.equal(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "1" }), true);
  assert.equal(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "yes" }), true);
  assert.equal(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "0" }), false);
  assert.equal(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "false" }), false);
  assert.equal(isOtelSdkDisabled({ OTEL_SDK_DISABLED: "" }), false);
});

test("emits app lifecycle boundaries as spans and keeps heartbeat as a log", async () => {
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

  const lifecycleSpans = runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.signal === DesktopOtelSignal.Trace &&
        record.name === "app.lifecycle"
    );
  const heartbeat = runtime
    .getBufferedRecords()
    .find(
      (record) =>
        record.signal === DesktopOtelSignal.Log &&
        record.name === "app.lifecycle"
    );

  assert.deepEqual(
    lifecycleSpans.map(
      (record) => record.attributes?.[TelemetryAttribute.AppLifecycleEvent]
    ),
    [DesktopAppLifecycleEvent.Start, DesktopAppLifecycleEvent.Shutdown]
  );
  assert.deepEqual(
    lifecycleSpans.map(
      (record) => record.attributes?.[TelemetryAttribute.AppOperatingMode]
    ),
    [DesktopAppOperatingMode.SinglePlayer, DesktopAppOperatingMode.SinglePlayer]
  );
  assert.equal(
    heartbeat?.attributes?.[TelemetryAttribute.AppLifecycleEvent],
    DesktopAppLifecycleEvent.Heartbeat
  );
  assert.equal(
    heartbeat?.attributes?.[TelemetryEmitMetadataKey.SchemaName],
    TelemetrySchemaName.App
  );

  for (const record of [...lifecycleSpans, heartbeat]) {
    assert.deepEqual(
      collectResourceAttributeMismatches(record?.resourceAttributes),
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
    operation: DesktopIpcOperation.List,
    startTimeUnixMs: 1_700_000_000_000,
    durationMs: 1234,
    matchedCount: 125,
    payloadBytes: 4096,
    resultCount: 50,
    scannedCount: 500,
    sessionCount: 2048,
    source: ListQuerySource.Canonical,
    execution: ListQueryExecution.HydratedFallback,
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
  assert.equal(listSpan?.attributes?.[TelemetryAttribute.IpcMatchedCount], 125);
  assert.equal(
    listSpan?.attributes?.[TelemetryAttribute.IpcQueryExecution],
    ListQueryExecution.HydratedFallback
  );
  assert.equal(
    listSpan?.attributes?.[TelemetryAttribute.IpcQuerySource],
    ListQuerySource.Canonical
  );
  assert.equal(listSpan?.attributes?.[TelemetryAttribute.IpcScannedCount], 500);
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

test.each([
  {
    name: "unknown source",
    source: "future_source" as ListQuerySource,
    execution: ListQueryExecution.CursorPage,
    expectedSource: undefined,
    expectedExecution: ListQueryExecution.CursorPage,
  },
  {
    name: "unknown execution",
    source: ListQuerySource.Canonical,
    execution: "future_execution" as ListQueryExecution,
    expectedSource: ListQuerySource.Canonical,
    expectedExecution: undefined,
  },
])("omits $name without dropping valid IPC fields", async (testCase) => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_future_query_classification",
  });
  await runtime.start();

  runtime.emitIpcPerfEvent({
    operation: DesktopIpcOperation.List,
    startTimeUnixMs: 1_700_000_000_000,
    durationMs: 12,
    payloadBytes: 64,
    resultCount: 2,
    sessionCount: 9,
    source: testCase.source,
    execution: testCase.execution,
  });
  await runtime.shutdown();

  const ipcSpan = runtime
    .getBufferedRecords()
    .find((record) => record.name === "ipc.list");
  assert.equal(ipcSpan?.name, "ipc.list");
  assert.equal(
    ipcSpan?.attributes?.[TelemetryAttribute.IpcOperation],
    DesktopIpcOperation.List
  );
  assert.equal(ipcSpan?.attributes?.[TelemetryAttribute.IpcResultCount], 2);
  assert.equal(ipcSpan?.attributes?.[TelemetryAttribute.IpcSessionCount], 9);
  assert.equal(
    ipcSpan?.attributes?.[TelemetryAttribute.IpcQuerySource],
    testCase.expectedSource
  );
  assert.equal(
    ipcSpan?.attributes?.[TelemetryAttribute.IpcQueryExecution],
    testCase.expectedExecution
  );
});

test("keeps refusal code separate from the historical IPC error type", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_query_refusal",
  });
  await runtime.start();

  runtime.emitIpcPerfEvent({
    operation: DesktopIpcOperation.List,
    startTimeUnixMs: 1_700_000_000_000,
    durationMs: 12,
    payloadBytes: 0,
    resultCount: 0,
    sessionCount: 9,
    errorType: "SessionListQueryRefusedError",
    refusal: ListQueryRefusal.UnsupportedVersion,
    source: ListQuerySource.Canonical,
    execution: ListQueryExecution.Refused,
  });
  await runtime.shutdown();

  const ipcSpan = runtime
    .getBufferedRecords()
    .find((record) => record.name === "ipc.list");
  assert.equal(ipcSpan?.name, "ipc.list");
  assert.equal(
    ipcSpan?.attributes?.[TelemetryAttribute.ErrorType],
    "SessionListQueryRefusedError"
  );
  assert.equal(
    ipcSpan?.attributes?.[TelemetryAttribute.IpcQueryRefusal],
    ListQueryRefusal.UnsupportedVersion
  );
});

test("creates cl-desktop activity roots around IPC spans with identity attributes", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
    getDeviceId: () => "device_0123456789abcdef",
    getOperatingMode: () => DesktopAppOperatingMode.Multiplayer,
    getOrganizationId: () => "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
  });
  await runtime.start();

  runtime.emitIpcPerfEvent({
    operation: "list",
    startTimeUnixMs: 1_700_000_000_000,
    durationMs: 25,
    payloadBytes: 32,
    resultCount: 2,
    sessionCount: 4,
  });
  await runtime.shutdown();

  const root = runtime
    .getBufferedRecords()
    .find((record) => record.name === "cl-desktop");
  assert.equal(root?.attributes?.[TelemetryAttribute.ServiceVersion], "1.2.3");
  assert.equal(
    root?.attributes?.[TelemetryAttribute.AppOperatingMode],
    DesktopAppOperatingMode.Multiplayer
  );
  assert.equal(
    root?.attributes?.[TelemetryAttribute.DeviceId],
    "device_0123456789abcdef"
  );
  assert.equal(
    root?.attributes?.[TelemetryAttribute.AppOrganizationId],
    "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f"
  );
  assert.equal(
    root?.resourceAttributes[TelemetryAttribute.DeviceId],
    "device_0123456789abcdef"
  );
});

test("rotates cl-desktop roots by max age, idle timeout, and shutdown", async () => {
  const timers = createManualTimers();
  let organizationId: string | undefined;
  const runtime = createTestRuntime({
    getOperatingMode: () => DesktopAppOperatingMode.Multiplayer,
    getOrganizationId: () => organizationId,
    setActivityRootTimeout: timers.set,
    clearActivityRootTimeout: timers.clear,
  });
  await runtime.start();

  runtime.emitIpcPerfEvent(ipcInputAt(1_700_000_000_000));
  organizationId = "org_after_rotation";
  runtime.emitIpcPerfEvent(
    ipcInputAt(1_700_000_000_000 + DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS + 1)
  );
  timers.fireLatest();
  runtime.emitIpcPerfEvent(ipcInputAt(1_700_000_100_000));
  await runtime.shutdown();

  const roots = runtime
    .getBufferedRecords()
    .filter((record) => record.name === "cl-desktop");
  assert.equal(roots.length, 3);
  assert.equal(
    roots[0]?.attributes?.[TelemetryAttribute.AppOrganizationId],
    undefined
  );
  assert.equal(
    roots[1]?.attributes?.[TelemetryAttribute.AppOrganizationId],
    "org_after_rotation"
  );
  assert.equal(
    roots[2]?.attributes?.[TelemetryAttribute.AppOrganizationId],
    "org_after_rotation"
  );
  assert.equal(timers.lastDelayMs, DESKTOP_ACTIVITY_ROOT_IDLE_TIMEOUT_MS);
  assert.equal(timers.activeCount(), 0);
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
    organizationId: "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f",
  });
  // Single-player: even if a caller passes no org, the record must omit it.
  runtime.emitAppLifecycleEvent({
    event: DesktopAppLifecycleEvent.Heartbeat,
    operatingMode: DesktopAppOperatingMode.SinglePlayer,
  });
  await runtime.shutdown();

  const lifecycleRecords = runtime
    .getBufferedRecords()
    .filter((record) => record.name === "app.lifecycle");

  const [multiplayer, singlePlayer] = lifecycleRecords;
  assert.equal(
    multiplayer?.attributes?.[TelemetryAttribute.AppOrganizationId],
    "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f"
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

test("emits scrubbed app exception records as error spans", async () => {
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
        item.signal === DesktopOtelSignal.Trace && item.name === "exception"
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
  assert.equal(record?.status?.code, SpanStatusCode.Error);
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
    "Error: failed at [redacted-path]"
  );
  // The redactor must OMIT an unsafe attribute, never emit an explicit `null` —
  // read the values untyped so the runtime check is meaningful.
  const attributeValues: unknown[] = Object.values(record?.attributes ?? {});
  assert.equal(attributeValues.includes(null), false);
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
