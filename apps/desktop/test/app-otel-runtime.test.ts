import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import {
  SpanKind,
  SpanStatusCode,
} from "@closedloop-ai/telemetry-contract/span";
import { context, metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  createDesktopOtelRuntime,
  DESKTOP_ACTIVITY_ROOT_IDLE_TIMEOUT_MS,
  DESKTOP_ACTIVITY_ROOT_MAX_AGE_MS,
  type DesktopOtelRuntime,
  DesktopSyncBatchOutcome,
  isOtelSdkDisabled,
  resolveDeploymentEnvironmentName,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  createDesktopAppLifecycleTelemetry,
  DesktopAppLifecycleEvent,
  type DesktopAppLifecycleTimerHandle,
  DesktopAppOperatingMode,
  shutdownDesktopOtelRuntime,
  startDesktopOtelRuntimeForBoot,
} from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import { getDesktopAppOperatingModeForTelemetry } from "../src/main/telemetry/app-telemetry-operating-mode.js";
import { OBSERVABILITY_SHUTDOWN_DEADLINE_MS } from "../src/main/telemetry/shutdown-deadline.js";
import { UNRESOLVED_DESKTOP_SERVICE_VERSION } from "../src/main/util/desktop-service-version.js";
import {
  DesktopOtelSignal,
  RendererOtelExportFailureReason,
} from "../src/shared/renderer-otel-bridge-constants.js";
import {
  collectAppLifecycleRecords,
  collectResourceAttributeMismatches,
  createLifecycleInputRecordingRuntime,
  createManualTimers,
  createRecordingRuntime,
  createRejectingRuntime,
  createThrowingTransport,
  ipcInputAt,
  rendererTraceRecord,
} from "./app-otel-runtime-test-helpers.js";

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

test("creates cl-desktop activity roots around IPC spans with identity attributes", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
    getDeviceId: () => "device_0123456789abcdef",
    getOperatingMode: () => DesktopAppOperatingMode.Multiplayer,
    getOrganizationId: () => "019c24db-a261-738f-8eff-ea275fb27470",
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
    "019c24db-a261-738f-8eff-ea275fb27470"
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
    .filter((record) => record.name === "app.lifecycle");

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
  const recordingRuntime = createLifecycleInputRecordingRuntime((input) =>
    inputs.push({ event: input.event, org: input.organizationId })
  );

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

test("emits sync.batch records as child spans", async () => {
  const runtime = createTestRuntime({
    appVersion: "1.2.3",
    env: {
      CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod",
    },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();

  runtime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.Success,
    payloadBytes: 2048,
    latencyMs: 37,
  });
  runtime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.Failure,
    payloadBytes: 512,
    latencyMs: 9,
    reason: "ack_timeout",
  });
  // dead-lettered before any send → no latency to report.
  runtime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.DeadLetter,
    payloadBytes: 300_000,
    reason: "locally_oversized",
  });
  await runtime.shutdown();

  const syncRecords = runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.signal === DesktopOtelSignal.Trace &&
        record.name === "sync.batch"
    );

  assert.equal(syncRecords.length, 3);
  for (const record of syncRecords) {
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
    [
      DesktopSyncBatchOutcome.Success,
      DesktopSyncBatchOutcome.Failure,
      DesktopSyncBatchOutcome.DeadLetter,
    ]
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
  // FEA-3426: `reason` maps to sync.reason on failure/dead_letter, and is
  // OMITTED (not null/empty) on success — the guard against a producer that
  // emits a reason the runtime silently drops.
  assert.deepEqual(
    syncRecords.map(
      (record) => record.attributes?.[TelemetryAttribute.SyncReason]
    ),
    [undefined, "ack_timeout", "locally_oversized"]
  );
  assert.deepEqual(
    syncRecords.map((record) => record.status?.code),
    [SpanStatusCode.Unset, SpanStatusCode.Error, SpanStatusCode.Error]
  );
  assert.deepEqual(
    syncRecords.map((record) => record.status?.message),
    [undefined, "ack_timeout", "locally_oversized"]
  );
});

test("sync batch emission no-ops when runtime is unavailable or disabled", async () => {
  const idleRuntime = createTestRuntime();
  idleRuntime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.Success,
    payloadBytes: 1,
    latencyMs: 1,
  });
  assert.deepEqual(idleRuntime.getBufferedRecords(), []);

  const disabledRuntime = createTestRuntime({
    env: { OTEL_SDK_DISABLED: "1" },
  });
  await disabledRuntime.start();
  disabledRuntime.emitSyncBatchEvent({
    outcome: DesktopSyncBatchOutcome.DeadLetter,
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
    // Read the values untyped so the "never an explicit null" check is a real
    // runtime assertion rather than a type-forbidden comparison.
    const attributeValues: unknown[] = Object.values(attributes);
    assert.equal(attributeValues.includes(null), false);
  }
});

test("app lifecycle controller emits start once and cleans heartbeat timers", () => {
  const emittedEvents: string[] = [];
  const clearedTimers: DesktopAppLifecycleTimerHandle[] = [];
  // Held on an object so TypeScript does not narrow the capture to `null`:
  // the assignment happens inside the injected `setIntervalFn`, which
  // control-flow analysis cannot see.
  const heartbeat: { callback: (() => void) | null } = { callback: null };
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
      heartbeat.callback = callback;
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

  heartbeat.callback?.();
  assert.deepEqual(emittedEvents, [
    DesktopAppLifecycleEvent.Start,
    DesktopAppLifecycleEvent.Heartbeat,
  ]);

  lifecycle.stop();
  heartbeat.callback?.();
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

test("shutdownDesktopOtelRuntime is bounded: a hung runtime.shutdown() cannot wedge exit (ISS-4585)", async () => {
  // The keyless OTel / collector_unavailable path can leave runtime.shutdown()
  // hung on a wedged exporter/keepalive socket. Because this await runs in
  // app.ts shutdown() BEFORE runShutdownSequence, its per-phase bound does not
  // cover it — an unbounded hang here force-killed desktop-dev with SIGKILL
  // (137). The internal deadline must resolve it. Drive the deadline with fake
  // timers so there is no wall-clock wait.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let shutdownStarted = false;
    const runtime = createRecordingRuntime(
      () => {},
      () => {
        shutdownStarted = true;
      }
    );
    const hungRuntime: DesktopOtelRuntime = {
      ...runtime,
      shutdown() {
        shutdownStarted = true;
        return new Promise<void>(() => {}); // never resolves
      },
    };

    const shutdownPromise = shutdownDesktopOtelRuntime({
      runtime: hungRuntime,
      logWarning: () => {},
    });
    // Let the hung shutdown start and the deadline timer register, then trip it.
    await Promise.resolve();
    mock.timers.tick(OBSERVABILITY_SHUTDOWN_DEADLINE_MS);

    // Resolves via the deadline even though runtime.shutdown() never settled.
    await shutdownPromise;
    assert.equal(shutdownStarted, true);
  } finally {
    mock.timers.reset();
  }
});

test("app lifecycle warnings are sanitized and do not block start heartbeat or shutdown", () => {
  const warnings: Array<{ tag: string; message: string }> = [];
  // Held on an object so TypeScript does not narrow the capture to `null`:
  // the assignment happens inside the injected `setIntervalFn`, which
  // control-flow analysis cannot see.
  const heartbeat: { callback: (() => void) | null } = { callback: null };
  const runtime = createRecordingRuntime(() => {
    throw new Error(
      "app.installation.id=install_0123456789abcdef path=/Users/example stack=secret"
    );
  });
  const lifecycle = createDesktopAppLifecycleTelemetry({
    runtime,
    getOperatingMode: () => DesktopAppOperatingMode.SinglePlayer,
    setIntervalFn: (callback) => {
      heartbeat.callback = callback;
      return {};
    },
    clearIntervalFn: () => {},
    logWarning: (tag, message) => warnings.push({ tag, message }),
  });

  lifecycle.start();
  heartbeat.callback?.();
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
});

test("external renderer relay failure still appends to local buffer", async () => {
  const runtime = createTestRuntime({
    telemetryTransport: createThrowingTransport(),
  });
  await runtime.start();

  const result = runtime.exportExternalRecords([
    {
      signal: DesktopOtelSignal.Trace,
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      kind: SpanKind.Internal,
      status: { code: SpanStatusCode.Unset },
      name: "renderer.relay.failure",
    },
  ]);

  assert.deepEqual(result, {
    ok: true,
    acceptedRecords: 1,
    droppedRecordsCount: 0,
  });
  assert.equal(
    runtime
      .getBufferedRecords()
      .some((record) => record.name === "renderer.relay.failure"),
    true
  );
});

test("external renderer records rebase roots under the active main span", async () => {
  const runtime = createTestRuntime();
  await runtime.start();
  const rendererParent = {
    signal: DesktopOtelSignal.Trace,
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    kind: SpanKind.Internal,
    status: { code: SpanStatusCode.Unset },
    name: "renderer.parent",
  };
  const rendererChild = {
    signal: DesktopOtelSignal.Trace,
    traceId: "11111111111111111111111111111111",
    spanId: "3333333333333333",
    parentSpanId: "2222222222222222",
    kind: SpanKind.Internal,
    status: { code: SpanStatusCode.Unset },
    name: "renderer.child",
  };

  const mainSpan = trace.getTracer("desktop-test").startSpan("main.parent");
  const result = context.with(trace.setSpan(context.active(), mainSpan), () =>
    runtime.exportExternalRecords([rendererParent, rendererChild])
  );
  mainSpan.end();
  await runtime.shutdown();

  assert.deepEqual(result, {
    ok: true,
    acceptedRecords: 2,
    droppedRecordsCount: 0,
  });
  const records = runtime.getBufferedRecords();
  const root = records.find((record) => record.name === "cl-desktop");
  const parent = records.find((record) => record.name === "renderer.parent");
  const child = records.find((record) => record.name === "renderer.child");
  assert.equal(parent?.traceId, root?.traceId);
  assert.equal(parent?.parentSpanId, root?.spanId);
  assert.equal(child?.traceId, root?.traceId);
  assert.equal(child?.parentSpanId, rendererParent.spanId);
});

test("external renderer records keep cached renderer trace under the activity root", async () => {
  const runtime = createTestRuntime();
  await runtime.start();
  const rendererTraceId = "11111111111111111111111111111111";

  assert.deepEqual(
    runtime.exportExternalRecords([
      rendererTraceRecord({
        name: "renderer.fallback.seed",
        spanId: "2222222222222222",
        traceId: rendererTraceId,
      }),
    ]),
    {
      ok: true,
      acceptedRecords: 1,
      droppedRecordsCount: 0,
    }
  );
  const fallbackSeed = runtime
    .getBufferedRecords()
    .find((record) => record.name === "renderer.fallback.seed");
  assert.ok(fallbackSeed);

  const mainSpan = trace.getTracer("desktop-test").startSpan("main.parent");
  const result = context.with(trace.setSpan(context.active(), mainSpan), () =>
    runtime.exportExternalRecords([
      rendererTraceRecord({
        name: "renderer.active.main",
        spanId: "3333333333333333",
        traceId: rendererTraceId,
      }),
    ])
  );
  mainSpan.end();
  await runtime.shutdown();

  assert.deepEqual(result, {
    ok: true,
    acceptedRecords: 1,
    droppedRecordsCount: 0,
  });
  const activeMainRecord = runtime
    .getBufferedRecords()
    .find((record) => record.name === "renderer.active.main");
  const root = runtime
    .getBufferedRecords()
    .find((record) => record.name === "cl-desktop");
  assert.equal(activeMainRecord?.traceId, root?.traceId);
  assert.equal(activeMainRecord?.parentSpanId, root?.spanId);
  assert.equal(activeMainRecord?.traceId, fallbackSeed.traceId);
});

test("external renderer records create a main-owned parent when no span is active", async () => {
  const runtime = createTestRuntime();
  await runtime.start();

  const result = runtime.exportExternalRecords([
    {
      signal: DesktopOtelSignal.Trace,
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
      kind: SpanKind.Internal,
      status: { code: SpanStatusCode.Unset },
      name: "renderer.root",
    },
  ]);

  assert.deepEqual(result, {
    ok: true,
    acceptedRecords: 1,
    droppedRecordsCount: 0,
  });
  await runtime.shutdown();
  const records = runtime.getBufferedRecords();
  const root = records.find((record) => record.name === "cl-desktop");
  const rendererRoot = records.find(
    (record) => record.name === "renderer.root"
  );
  assert.equal(rendererRoot?.traceId, root?.traceId);
  assert.equal(rendererRoot?.parentSpanId, root?.spanId);
});

test("external renderer records preserve parentage across split exports", async () => {
  const runtime = createTestRuntime();
  await runtime.start();
  const rendererParent = {
    signal: DesktopOtelSignal.Trace,
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    kind: SpanKind.Internal,
    status: { code: SpanStatusCode.Unset },
    name: "renderer.parent",
  };
  const rendererChild = {
    signal: DesktopOtelSignal.Trace,
    traceId: "11111111111111111111111111111111",
    spanId: "3333333333333333",
    parentSpanId: "2222222222222222",
    kind: SpanKind.Internal,
    status: { code: SpanStatusCode.Unset },
    name: "renderer.child",
  };

  assert.deepEqual(runtime.exportExternalRecords([rendererChild]), {
    ok: true,
    acceptedRecords: 1,
    droppedRecordsCount: 0,
  });
  assert.deepEqual(runtime.exportExternalRecords([rendererParent]), {
    ok: true,
    acceptedRecords: 1,
    droppedRecordsCount: 0,
  });
  await runtime.shutdown();

  const records = runtime.getBufferedRecords();
  const parent = records.find((record) => record.name === "renderer.parent");
  const child = records.find((record) => record.name === "renderer.child");
  const root = records.find((record) => record.name === "cl-desktop");
  assert.equal(child?.traceId, root?.traceId);
  assert.equal(parent?.traceId, root?.traceId);
  assert.equal(child?.parentSpanId, rendererParent.spanId);
  assert.equal(parent?.parentSpanId, root?.spanId);
});

test("external renderer records register every trace id in a mixed batch", async () => {
  const runtime = createTestRuntime();
  await runtime.start();
  const firstTraceRoot = rendererTraceRecord({
    name: "renderer.first.root",
    spanId: "2222222222222222",
    traceId: "11111111111111111111111111111111",
  });
  const secondTraceRoot = rendererTraceRecord({
    name: "renderer.second.root",
    spanId: "4444444444444444",
    traceId: "33333333333333333333333333333333",
  });
  const secondTraceChild = rendererTraceRecord({
    name: "renderer.second.child",
    parentSpanId: secondTraceRoot.spanId,
    spanId: "5555555555555555",
    traceId: secondTraceRoot.traceId,
  });

  assert.deepEqual(runtime.exportExternalRecords([firstTraceRoot]), {
    ok: true,
    acceptedRecords: 1,
    droppedRecordsCount: 0,
  });
  assert.deepEqual(
    runtime.exportExternalRecords([firstTraceRoot, secondTraceRoot]),
    {
      ok: true,
      acceptedRecords: 2,
      droppedRecordsCount: 0,
    }
  );
  assert.deepEqual(runtime.exportExternalRecords([secondTraceChild]), {
    ok: true,
    acceptedRecords: 1,
    droppedRecordsCount: 0,
  });

  const records = runtime.getBufferedRecords();
  const first = records.find((record) => record.name === firstTraceRoot.name);
  const second = records.find((record) => record.name === secondTraceRoot.name);
  const child = records.find((record) => record.name === secondTraceChild.name);

  assert.equal(second?.traceId, first?.traceId);
  assert.equal(child?.traceId, first?.traceId);
  assert.equal(child?.parentSpanId, secondTraceRoot.spanId);
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
    getDeviceId: () => "device_0123456789abcdef",
    isPackaged: false,
    metricExportIntervalMs: 60_000,
    ...options,
  });
  return activeRuntime;
}
