/**
 * The `exportExternalRecords` half of the desktop OTel runtime — renderer-owned
 * records crossing into the main-process local buffer — split out of
 * `app-otel-runtime.test.ts`.
 *
 * Its own file because the parent suite is on the shrink-only
 * `noExcessiveLinesPerFile` grandfather list in `biome.jsonc`, and because
 * external-record ingest is a self-contained responsibility: it is the only
 * runtime surface that re-parents foreign trace ids under a main-owned
 * activity root, and the only one whose result reports a per-call
 * `droppedRecordsCount` distinct from the buffer's cumulative total.
 *
 * Relay/OTLP wire output for these same records lives in
 * `app-otel-runtime-relay.test.ts`; this file asserts the local-buffer path.
 */
import assert from "node:assert/strict";
import {
  SpanKind,
  SpanStatusCode,
} from "@closedloop-ai/telemetry-contract/span";
import { context, trace } from "@opentelemetry/api";
import { afterEach, test } from "vitest";
import {
  DesktopOtelSignal,
  RendererOtelExportFailureReason,
} from "../src/shared/renderer-otel-bridge-constants.js";
import {
  collectResourceAttributeMismatches,
  createThrowingTransport,
  createTrackedRuntimeFactory,
  rendererTraceRecord,
} from "./app-otel-runtime-test-helpers.js";

const { createTestRuntime, resetTrackedRuntime } =
  createTrackedRuntimeFactory();

afterEach(resetTrackedRuntime);

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

test("external renderer records no-op when runtime is not started or disabled", async () => {
  const idleRuntime = createTestRuntime();
  assert.deepEqual(idleRuntime.exportExternalRecords([]), {
    ok: false,
    reason: RendererOtelExportFailureReason.NotStarted,
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
