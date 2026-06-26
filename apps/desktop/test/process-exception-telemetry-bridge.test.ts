import assert from "node:assert/strict";
import { test } from "node:test";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import type { DesktopOtelRuntime } from "../src/main/app-otel-runtime.js";
import { createProcessExceptionTelemetryBridge } from "../src/main/process-exception-telemetry-bridge.js";
import { RendererOtelExportFailureReason } from "../src/shared/renderer-otel-bridge-constants.js";

test("process exception bridge is best-effort before runtime binding and emits main after binding", () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const preInitError = new Error("pre init");
  const mainError = new Error("main");
  const emitted: unknown[] = [];
  const runtime = createStubRuntime((input) => {
    emitted.push(input);
  });

  assert.doesNotThrow(() => bridge.emitProcessException(preInitError));
  assert.deepEqual(emitted, []);

  bridge.bindRuntime(runtime);
  bridge.emitProcessException(mainError);

  assert.deepEqual(emitted, [
    {
      error: mainError,
      origin: AppExceptionOrigin.Main,
    },
  ]);
});

test("process exception bridge explicit pre-init emission does not claim buffered events without runtime", () => {
  const bridge = createProcessExceptionTelemetryBridge();

  assert.doesNotThrow(() =>
    bridge.emitPreInitException(new Error("early crash"))
  );
});

test("process exception bridge preserves explicit origins and clearRuntime returns to no-buffer pre-init behavior", () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const emitted: unknown[] = [];
  const runtime = createStubRuntime((input) => {
    emitted.push(input);
  });
  const preInitError = new Error("pre-init while bound");
  const mainError = new Error("main while bound");

  bridge.bindRuntime(runtime);
  bridge.emitPreInitException(preInitError);
  bridge.emitMainException(mainError);
  bridge.clearRuntime();
  bridge.emitProcessException(new Error("after clear"));

  assert.deepEqual(emitted, [
    {
      error: preInitError,
      origin: AppExceptionOrigin.PreInit,
    },
    {
      error: mainError,
      origin: AppExceptionOrigin.Main,
    },
  ]);
});

function createStubRuntime(
  emitAppExceptionEvent: DesktopOtelRuntime["emitAppExceptionEvent"]
): DesktopOtelRuntime {
  return {
    start: async () => {},
    emitAppLifecycleEvent: () => {},
    emitAppExceptionEvent,
    shutdown: async () => {},
    getBufferedRecords: () => [],
    resetBuffer: () => {},
    exportExternalRecords: () => ({
      ok: false,
      reason: RendererOtelExportFailureReason.Unavailable,
    }),
  };
}
