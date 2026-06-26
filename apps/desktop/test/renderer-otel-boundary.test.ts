import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  createDesktopOtelRuntime,
  type DesktopOtelRuntime,
} from "../src/main/app-otel-runtime.js";
import { createRendererOtelExportHandler } from "../src/main/renderer-otel-ipc.js";
import {
  DesktopOtelSignal,
  RendererOtelAllowedAttributeKey,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
} from "../src/shared/renderer-otel-bridge-constants.js";

let activeRuntime: DesktopOtelRuntime | null = null;

const INSTALLATION_FAILURE_PATTERN = /installation failure/;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

test("preload API forwards renderer telemetry through the production handler into the main buffer", async () => {
  const runtime = createRuntime();
  await runtime.start();
  const handler = createRendererOtelExportHandler({
    isTrustedSender: () => true,
    runtime,
  });
  const desktopApi = await createBoundaryDesktopApi({
    invokeImpl: (_channel, payload) =>
      Promise.resolve(handler({ sender: { id: "trusted" } }, payload)),
  });

  const result = await desktopApi.exportOtelTelemetry({
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        instrumentationScope: { name: "renderer-boundary" },
        name: "renderer.boundary.span",
        attributes: { [RendererOtelAllowedAttributeKey.Mode]: "boundary" },
      },
    ],
  });

  assert.equal(result.ok, true);
  const record = runtime
    .getBufferedRecords()
    .find((item) => item.name === "renderer.boundary.span");
  assert.equal(
    record?.attributes?.[RendererOtelAllowedAttributeKey.Mode],
    "boundary"
  );
  assert.equal(
    record?.resourceAttributes[TelemetryAttribute.ServiceName],
    "closedloop-desktop"
  );
  assert.equal(
    record?.resourceAttributes[TelemetryAttribute.ServiceVersion],
    "9.8.7"
  );
  assert.equal(
    record?.resourceAttributes[TelemetryAttribute.AppInstallationId],
    "install_boundary"
  );
  assert.equal(record?.resourceAttributes["device.id"], undefined);
});

test("preload API forwards renderer exception telemetry through the production handler into the main buffer", async () => {
  const runtime = createRuntime();
  await runtime.start();
  const handler = createRendererOtelExportHandler({
    isTrustedSender: () => true,
    runtime,
  });
  const desktopApi = await createBoundaryDesktopApi({
    invokeImpl: (_channel, payload) =>
      Promise.resolve(handler({ sender: { id: "trusted" } }, payload)),
  });

  const result = await desktopApi.exportOtelTelemetry({
    records: [
      {
        signal: DesktopOtelSignal.Log,
        name: "exception",
        attributes: {
          [TelemetryAttribute.ExceptionType]: "Error",
          [TelemetryAttribute.ExceptionMessage]: "Renderer failed",
          [TelemetryAttribute.ExceptionStacktrace]:
            "Error: failed at /Users/example/project/app.ts",
          [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
        },
      },
    ],
  });

  assert.equal(result.ok, true);
  const record = runtime
    .getBufferedRecords()
    .find((item) => item.name === "exception");
  assert.equal(record?.attributes?.[TelemetryAttribute.ExceptionType], "Error");
  assert.equal(
    record?.attributes?.[TelemetryAttribute.ExceptionMessage],
    "Renderer failed"
  );
  assert.equal(
    record?.attributes?.[TelemetryAttribute.ExceptionStacktrace],
    "[redacted]"
  );
  assert.equal(
    record?.attributes?.[TelemetryAttribute.AppExceptionOrigin],
    AppExceptionOrigin.Renderer
  );
  assert.equal(
    record?.resourceAttributes[TelemetryAttribute.ServiceName],
    "closedloop-desktop"
  );
  assert.equal(record?.resourceAttributes["device.id"], undefined);
});

test("boundary failure cases fail closed without buffer append", async () => {
  const runtime = createRuntime();
  await runtime.start();
  const untrustedDesktopApi = await createBoundaryDesktopApi({
    runtime,
    trusted: false,
  });
  assert.deepEqual(
    await untrustedDesktopApi.exportOtelTelemetry({ records: [] }),
    {
      ok: false,
      reason: RendererOtelExportFailureReason.UntrustedSender,
    }
  );
  assert.deepEqual(runtime.getBufferedRecords(), []);

  const trustedDesktopApi = await createBoundaryDesktopApi({
    runtime,
    trusted: true,
  });
  assert.deepEqual(
    await trustedDesktopApi.exportOtelTelemetry({
      records: [{ signal: DesktopOtelSignal.Trace, body: "raw body" }],
    }),
    {
      ok: false,
      reason: RendererOtelExportFailureReason.InvalidPayload,
    }
  );
  assert.deepEqual(runtime.getBufferedRecords(), []);

  for (const record of [
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.secret.value",
      value: "sk-proj-secret",
    },
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.secret.attribute",
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "sk-proj-secret",
      },
    },
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.unknown.attribute",
      attributes: { "renderer.customer_segment": "enterprise" },
    },
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.absolute.path",
      value: "/var/folders/aa/bb/data.json",
    },
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.windows.drive.forward.path",
      value: "C:/Temp/cache/data.json",
    },
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.windows.drive.forward.attribute",
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "D:/work/cache/data.bin",
      },
    },
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.windows.unc.path",
      value: String.raw`\\server\share\data.json`,
    },
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.rooted.windows.path",
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: String.raw`\var\folders\aa\bb\data.json`,
      },
    },
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.relative.windows.path",
      value: String.raw`relative\project\data.json`,
    },
    {
      signal: DesktopOtelSignal.Trace,
      name: "renderer.dot.relative.windows.path",
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: String.raw`.\relative\project.json`,
      },
    },
  ]) {
    const invalidRecordDesktopApi = await createBoundaryDesktopApi({
      runtime,
      trusted: true,
    });
    assert.deepEqual(
      await invalidRecordDesktopApi.exportOtelTelemetry({ records: [record] }),
      {
        ok: false,
        reason: RendererOtelExportFailureReason.InvalidPayload,
      }
    );
    assert.deepEqual(runtime.getBufferedRecords(), []);
  }

  const disabledRuntime = createRuntime({ env: { OTEL_SDK_DISABLED: "1" } });
  await disabledRuntime.start();
  const disabledDesktopApi = await createBoundaryDesktopApi({
    runtime: disabledRuntime,
    trusted: true,
  });
  assert.deepEqual(
    await disabledDesktopApi.exportOtelTelemetry({
      records: [{ signal: DesktopOtelSignal.Trace, name: "renderer.disabled" }],
    }),
    {
      ok: false,
      reason: RendererOtelExportFailureReason.Disabled,
    }
  );
  assert.deepEqual(disabledRuntime.getBufferedRecords(), []);
});

test("boundary rate limit fails closed after sustained valid batches", async () => {
  const runtime = createRuntime();
  await runtime.start();
  const desktopApi = await createBoundaryDesktopApi({
    now: () => 100,
    runtime,
    trusted: true,
  });
  const payload = {
    records: [{ signal: DesktopOtelSignal.Trace, name: "renderer.rate" }],
  };

  for (let index = 0; index < 8; index += 1) {
    assert.equal((await desktopApi.exportOtelTelemetry(payload)).ok, true);
  }
  assert.deepEqual(await desktopApi.exportOtelTelemetry(payload), {
    ok: false,
    reason: RendererOtelExportFailureReason.RateLimited,
  });
});

test("boundary unavailable runtime states fail closed without buffer append", async () => {
  const idleRuntime = createRuntime();
  const idleEvidence = await exportBoundaryFailure(idleRuntime);
  assert.deepEqual(idleEvidence.result, {
    ok: false,
    reason: RendererOtelExportFailureReason.Unavailable,
  });
  assert.deepEqual(idleEvidence.records, []);

  const failedRuntime = createRuntime({
    getAppInstallationId: () => {
      throw new Error("installation failure");
    },
  });
  await assert.rejects(failedRuntime.start(), INSTALLATION_FAILURE_PATTERN);
  const failedEvidence = await exportBoundaryFailure(failedRuntime);
  assert.deepEqual(failedEvidence.result, {
    ok: false,
    reason: RendererOtelExportFailureReason.Unavailable,
  });
  assert.deepEqual(failedEvidence.records, []);

  const shutdownRuntime = createRuntime();
  await shutdownRuntime.start();
  await shutdownRuntime.shutdown();
  const shutdownEvidence = await exportBoundaryFailure(shutdownRuntime);
  assert.deepEqual(shutdownEvidence.result, {
    ok: false,
    reason: RendererOtelExportFailureReason.Unavailable,
  });
  assert.deepEqual(shutdownEvidence.records, []);
});

function createRuntime(
  options: Partial<Parameters<typeof createDesktopOtelRuntime>[0]> = {}
): DesktopOtelRuntime {
  activeRuntime = createDesktopOtelRuntime({
    appVersion: "9.8.7",
    bufferLimit: 10,
    env: {},
    getAppInstallationId: () => "install_boundary",
    isPackaged: true,
    metricExportIntervalMs: 60_000,
    ...options,
  });
  return activeRuntime;
}

async function createBoundaryDesktopApi(
  options:
    | {
        invokeImpl: (channel: string, payload: unknown) => Promise<unknown>;
      }
    | {
        runtime: DesktopOtelRuntime;
        trusted: boolean;
        now?: () => number;
      }
) {
  const handler =
    "invokeImpl" in options
      ? null
      : createRendererOtelExportHandler({
          isTrustedSender: () => options.trusted,
          ...(options.now ? { now: options.now } : {}),
          runtime: options.runtime,
        });
  const invoke =
    "invokeImpl" in options
      ? mock.fn(options.invokeImpl)
      : mock.fn((_channel: string, payload: unknown) => {
          return Promise.resolve(
            handler?.({ sender: { id: "boundary" } }, payload)
          );
        });
  const send = mock.fn();
  const { createDesktopApi } = await import("../src/main/preload-common.js");
  return createDesktopApi({ invoke, send });
}

async function exportBoundaryFailure(runtime: DesktopOtelRuntime): Promise<{
  records: ReturnType<DesktopOtelRuntime["getBufferedRecords"]>;
  result: RendererOtelExportResult;
}> {
  const desktopApi = await createBoundaryDesktopApi({
    runtime,
    trusted: true,
  });

  const result = await desktopApi.exportOtelTelemetry({
    records: [
      { signal: DesktopOtelSignal.Trace, name: "renderer.unavailable" },
    ],
  });
  return {
    records: runtime.getBufferedRecords(),
    result,
  };
}
