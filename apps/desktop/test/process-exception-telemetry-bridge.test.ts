import assert from "node:assert/strict";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { test } from "vitest";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
import { createProcessExceptionTelemetryBridge } from "../src/main/telemetry/process-exception-telemetry-bridge.js";
import type { SanitizedDesktopExceptionAttributes } from "../src/shared/exception-sanitizer.js";
import { RendererOtelExportFailureReason } from "../src/shared/renderer-otel-bridge-constants.js";

test("process exception bridge queues before runtime binding and emits main after binding", () => {
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
  // ISS-6330 behavior change: binding alone no longer opens the raw channel,
  // because the runtime it binds is not started yet and would discard the emit.
  bridge.emitProcessException(new Error("during bind to start"));
  assert.deepEqual(emitted, []);

  bridge.markRuntimeStarted();
  bridge.emitProcessException(mainError);

  // The two pre-start crashes left as sanitized attributes at drain, so only
  // the post-start one appears on this raw-input channel.
  assert.deepEqual(emitted, [
    {
      error: mainError,
      origin: AppExceptionOrigin.Main,
    },
  ]);
});

test("process exception bridge holds an explicit pre-init emission until the runtime starts", () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const sanitized: SanitizedDesktopExceptionAttributes[] = [];

  assert.doesNotThrow(() =>
    bridge.emitPreInitException(new Error("early crash"))
  );

  bridge.bindRuntime(
    createStubRuntime(
      () => undefined,
      (attributes) => sanitized.push(attributes)
    )
  );
  assert.deepEqual(sanitized, [], "binding alone must not drain");

  bridge.markRuntimeStarted();

  assert.equal(sanitized.length, 1);
  assert.equal(
    sanitized[0]?.[TelemetryAttribute.AppExceptionOrigin],
    AppExceptionOrigin.PreInit
  );
  assert.equal(
    sanitized[0]?.[TelemetryAttribute.ExceptionMessage],
    "early crash"
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
  bridge.markRuntimeStarted();
  bridge.emitPreInitException(preInitError);
  bridge.emitMainException(mainError);
  bridge.clearRuntime();
  bridge.emitProcessException(new Error("after clear"));

  // The pre-init window is one-way: after clearRuntime the shutdown-path
  // exception is a no-op again, NOT re-queued into a buffer nothing drains.
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
  emitAppExceptionEvent: DesktopOtelRuntime["emitAppExceptionEvent"],
  emitSanitizedAppExceptionEvent: DesktopOtelRuntime["emitSanitizedAppExceptionEvent"] = () => {}
): DesktopOtelRuntime {
  return {
    start: async () => {},
    emitAppLifecycleEvent: () => {},
    emitAppExceptionEvent,
    emitSanitizedAppExceptionEvent,
    emitIpcPerfEvent: () => {},
    emitSyncBatchEvent: () => {},
    emitImportHealthEvent: () => {},
    emitAuthFailureEvent: () => false,
    emitDeadEndEvent: () => true,
    emitGenAiRequestEvent: () => undefined,
    emitOnboardingEvent: () => {},
    emitOnboardingDiscardEvent: () => {},
    emitUpdateEvent: () => true,
    flush: async () => {},
    shutdown: async () => {},
    getBufferedRecords: () => [],
    resetBuffer: () => {},
    exportExternalRecords: () => ({
      ok: false,
      reason: RendererOtelExportFailureReason.Unavailable,
    }),
  };
}
