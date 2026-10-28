import assert from "node:assert/strict";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { SpanStatusCode } from "@closedloop-ai/telemetry-contract/span";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, test } from "vitest";
import {
  type BootstrapErrorHandlerDeps,
  type BootstrapProcessEventTarget,
  handleBootstrapUncaughtException,
  handleBootstrapUnhandledRejection,
  registerBootstrapErrorHandlers,
} from "../src/main/lifecycle/error-handlers.js";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
import { startDesktopOtelRuntimeForBoot } from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import {
  createProcessExceptionTelemetryBridge,
  MAX_PRE_INIT_EXCEPTIONS,
  type ProcessExceptionTelemetryBridge,
} from "../src/main/telemetry/process-exception-telemetry-bridge.js";
import type { SanitizedDesktopExceptionAttributes } from "../src/shared/exception-sanitizer.js";
import {
  DesktopOtelSignal,
  RendererOtelExportFailureReason,
} from "../src/shared/renderer-otel-bridge-constants.js";
import { createRealTestRuntime } from "./app-otel-runtime-test-helpers.js";

/**
 * ISS-6330 — the pre-init crash path, driven end to end through the production
 * wiring: the bootstrap handlers `index.ts` registers, the module-global bridge
 * they emit into, and the boot-time start that drains it.
 */

type DrainRecorder = {
  runtime: DesktopOtelRuntime;
  sanitized: SanitizedDesktopExceptionAttributes[];
  startCalls: number;
};

/**
 * The cases below that drive a REAL runtime register global OTel providers, and
 * a second registration is silently ignored — so without this teardown the next
 * runtime's spans land in the previous one's buffer and its assertions read
 * another test's records.
 */
let activeRuntime: DesktopOtelRuntime | null = null;

afterEach(async () => {
  await activeRuntime?.shutdown();
  activeRuntime = null;
  trace.disable();
  metrics.disable();
  logs.disable();
});

/** A real runtime whose global provider registration this suite will undo. */
function createTrackedRuntime(
  options: Parameters<typeof createRealTestRuntime>[0] = {}
): DesktopOtelRuntime {
  activeRuntime = createRealTestRuntime(options);
  return activeRuntime;
}

const REALISTIC_CRASH_STACK = [
  "Error: ENOENT: no such file or directory, open '/Users/alice.smith/Library/Application Support/Closedloop/config.json'",
  "    at readConfig (file:///Users/alice.smith/Applications/Closedloop.app/Contents/Resources/app.asar/out/main/startup.js:12:9)",
  "    at reportTo (alice.smith@example.com)",
  "    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)",
].join("\n");

test("the bootstrap uncaught handler routes the crash to the bridge before exiting", () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const exitCodes: number[] = [];

  handleBootstrapUncaughtException(
    new Error("module evaluation failed"),
    createBootstrapDeps(bridge, { exit: (code) => exitCodes.push(code) })
  );

  // Production's `exit` is `app.exit`, which terminates here — so this test
  // deliberately does NOT go on to start a runtime and assert delivery. What is
  // reachable on this path is the capture, observable by draining the queue.
  assert.deepEqual(exitCodes, [1], "the crash path still exits");
  assert.deepEqual(drainQueue(bridge), ["module evaluation failed"]);
});

test("an exception in the bind-to-start window is queued, not dropped by the unstarted runtime", async () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const recorder = createDrainRecorder();

  // Composition binds the runtime it has just constructed. It is NOT started,
  // so `emitAppExceptionEvent` would discard anything handed to it here; the
  // bridge must queue instead of emitting.
  bridge.bindRuntime(recorder.runtime);
  bridge.emitProcessException(new Error("service composition failed"));
  assert.deepEqual(
    recorder.sanitized,
    [],
    "binding an unstarted runtime must not drain the queue"
  );

  await startDesktopOtelRuntimeForBoot({
    runtime: recorder.runtime,
    logWarning: () => undefined,
    exceptionBridge: bridge,
  });

  // Positive control: boot genuinely reached the point under test, so the
  // assertion below cannot pass on a path where the runtime was never started.
  assert.equal(recorder.startCalls, 1, "boot must have started the runtime");
  assert.equal(recorder.sanitized.length, 1);
  assert.equal(
    recorder.sanitized[0]?.[TelemetryAttribute.AppExceptionOrigin],
    AppExceptionOrigin.PreInit
  );
  assert.equal(
    recorder.sanitized[0]?.[TelemetryAttribute.ExceptionMessage],
    "service composition failed"
  );
});

test("a failed runtime start leaves the queue intact instead of draining it away", async () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const recorder = createDrainRecorder({
    start: () => Promise.reject(new Error("sdk start failed")),
  });
  const warnings: string[] = [];

  bridge.emitPreInitException(new Error("early"));
  bridge.bindRuntime(recorder.runtime);
  await startDesktopOtelRuntimeForBoot({
    runtime: recorder.runtime,
    logWarning: (_tag, message) => warnings.push(message),
    exceptionBridge: bridge,
  });

  assert.equal(warnings.length, 1, "a failed start must have been logged");
  assert.deepEqual(recorder.sanitized, []);
  // Still held, not spliced into a no-op.
  assert.deepEqual(drainQueue(bridge), ["early"]);
});

test("a non-Error bootstrap rejection does not exit, so its record reaches the transport", async () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const recorder = createDrainRecorder();
  const exitCodes: number[] = [];

  handleBootstrapUnhandledRejection(
    "startup contract violated",
    createBootstrapDeps(bridge, { exit: (code) => exitCodes.push(code) })
  );

  assert.deepEqual(exitCodes, [], "a non-Error rejection must not exit");

  bridge.bindRuntime(recorder.runtime);
  await startDesktopOtelRuntimeForBoot({
    runtime: recorder.runtime,
    logWarning: () => undefined,
    exceptionBridge: bridge,
  });

  assert.equal(recorder.startCalls, 1, "boot must have started the runtime");
  assert.equal(recorder.sanitized.length, 1);
  assert.equal(
    recorder.sanitized[0]?.[TelemetryAttribute.ExceptionMessage],
    "startup contract violated"
  );
});

test("the queued pre-init record carries no email and no absolute path", async () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const recorder = createDrainRecorder();
  const crash = new Error(
    "ENOENT: open '/Users/alice.smith/Library/Application Support/Closedloop/config.json' for alice.smith@example.com"
  );
  crash.stack = REALISTIC_CRASH_STACK;

  handleBootstrapUncaughtException(crash, createBootstrapDeps(bridge));
  bridge.bindRuntime(recorder.runtime);
  await startDesktopOtelRuntimeForBoot({
    runtime: recorder.runtime,
    logWarning: () => undefined,
    exceptionBridge: bridge,
  });

  const record = recorder.sanitized[0];
  assert.ok(record, "the crash must have been captured at all");
  const payload = JSON.stringify(record);
  assert.ok(
    !payload.includes("alice.smith@example.com"),
    `email survived sanitization: ${payload}`
  );
  assert.ok(
    !payload.includes("file://"),
    `file URL survived sanitization: ${payload}`
  );
  assert.ok(
    !payload.includes("/Users/alice.smith"),
    `absolute path survived sanitization: ${payload}`
  );
  // Anchors: the assertions above cannot pass merely because the payload is
  // empty or the whole field was blanked.
  assert.ok(
    record[TelemetryAttribute.ExceptionMessage]?.includes("ENOENT"),
    `non-PII message text was lost: ${payload}`
  );
  assert.ok(
    record[TelemetryAttribute.ExceptionStacktrace]?.includes("readConfig"),
    `non-PII frame names were lost: ${payload}`
  );
});

test("the pre-init queue is bounded and keeps the earliest crashes", async () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const recorder = createDrainRecorder();
  const offered = MAX_PRE_INIT_EXCEPTIONS + 3;

  for (let index = 0; index < offered; index += 1) {
    bridge.emitPreInitException(new Error(`crash ${index}`));
  }

  bridge.bindRuntime(recorder.runtime);
  await startDesktopOtelRuntimeForBoot({
    runtime: recorder.runtime,
    logWarning: () => undefined,
    exceptionBridge: bridge,
  });

  assert.equal(recorder.sanitized.length, MAX_PRE_INIT_EXCEPTIONS);
  assert.equal(
    recorder.sanitized[0]?.[TelemetryAttribute.ExceptionMessage],
    "crash 0"
  );
  assert.equal(
    recorder.sanitized.at(-1)?.[TelemetryAttribute.ExceptionMessage],
    `crash ${MAX_PRE_INIT_EXCEPTIONS - 1}`
  );
});

test("marking started with no runtime bound keeps the queue instead of destroying it", () => {
  const bridge = createProcessExceptionTelemetryBridge();

  bridge.emitPreInitException(new Error("nowhere to go"));
  // No bindRuntime: the drain has nothing to emit into. Splicing the queue here
  // would discard the only account of this boot for a runtime that never came.
  bridge.markRuntimeStarted();

  assert.deepEqual(drainQueue(bridge), ["nowhere to go"]);
});

test("a shutdown-path exception after clearRuntime is a no-op, not re-queued forever", () => {
  const bridge = createProcessExceptionTelemetryBridge();

  bridge.bindRuntime(createStubRuntime({}));
  bridge.markRuntimeStarted();
  // Shutdown unbinds the runtime it is tearing down. The pre-init window is
  // one-way, so what follows must fall through to the no-op it was before this
  // queue existed — NOT back into a buffer nothing will ever drain again, held
  // until process exit and mislabelled pre_init.
  bridge.clearRuntime();
  bridge.emitProcessException(new Error("teardown failed"));

  assert.deepEqual(drainQueue(bridge), []);
});

test("a queued record is emitted with its CAPTURE time, not the drain time", () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const stamps: (number | undefined)[] = [];

  bridge.emitPreInitException(new Error("early"));
  bridge.bindRuntime(
    createStubRuntime({
      emitSanitizedAppExceptionEvent: (_attributes, capturedAtUnixMs) =>
        stamps.push(capturedAtUnixMs),
    })
  );
  bridge.markRuntimeStarted();

  // The drain can be seconds after the crash. Forwarding the capture stamp is
  // what stops every pre-init crash being dated to the moment OTel started and
  // collapsing their relative order; asserting the value itself would be a
  // real-clock timing assertion, so this asserts the plumbing exists.
  assert.equal(stamps.length, 1);
  assert.equal(typeof stamps[0], "number");
});

test("a runtime that throws while draining cannot break the remaining records", () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const sanitized: SanitizedDesktopExceptionAttributes[] = [];
  let first = true;
  const runtime = createStubRuntime({
    emitSanitizedAppExceptionEvent: (attributes) => {
      if (first) {
        first = false;
        throw new Error("exporter exploded");
      }
      sanitized.push(attributes);
    },
  });

  bridge.emitPreInitException(new Error("first"));
  bridge.emitPreInitException(new Error("second"));
  bridge.bindRuntime(runtime);

  assert.doesNotThrow(() => bridge.markRuntimeStarted());
  assert.equal(sanitized.length, 1);
  assert.equal(
    sanitized[0]?.[TelemetryAttribute.ExceptionMessage],
    "second",
    "a throwing export must not swallow the records behind it"
  );
});

test("a pre-init crash reaches the transport with the pre_init origin once boot starts the runtime", async () => {
  const runtime = createTrackedRuntime({
    appVersion: "1.2.3",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  const crash = new Error("boot failed, notified alice.smith@example.com");
  crash.stack =
    "Error: boot failed at readConfig (/Users/alice.smith/Closedloop.app/out/main/startup.js:12:9)";
  // A bridge instance of its own rather than the module singleton `index.ts`
  // holds. Closing the pre-init window is deliberately ONE-WAY, so driving the
  // singleton made this case pass at most once per process: an ATR retry or an
  // EFD re-run found the window already shut, and the crash fell through to an
  // unbound runtime and was dropped. Same wiring, same assertions, no
  // dependence on module state surviving in a known position.
  const bridge = createProcessExceptionTelemetryBridge();

  try {
    // The production wiring, hop for hop: index.ts's bootstrap handler emits
    // into the bridge (ISS-6330) ...
    handleBootstrapUncaughtException(
      crash,
      createBootstrapDeps(bridge, { exit: () => undefined })
    );
    // ... desktop-services binds the runtime it has just constructed, which is
    // NOT started yet ...
    bridge.bindRuntime(runtime);
    assert.deepEqual(
      runtime.getBufferedRecords(),
      [],
      "an unstarted runtime must not have taken the record"
    );
    // ... and app.ts boot() starts it, which is where the queue drains.
    await startDesktopOtelRuntimeForBoot({
      runtime,
      logWarning: () => undefined,
      exceptionBridge: bridge,
    });
    await runtime.shutdown();
  } finally {
    bridge.clearRuntime();
  }

  const record = runtime
    .getBufferedRecords()
    .find(
      (item) =>
        item.signal === DesktopOtelSignal.Trace && item.name === "exception"
    );

  // Survives AppTelemetrySchema unstripped: the origin the producer has never
  // been able to emit until now is already a member of that closed enum.
  assert.equal(
    record?.attributes?.[TelemetryAttribute.AppExceptionOrigin],
    AppExceptionOrigin.PreInit
  );
  assert.equal(record?.status?.code, SpanStatusCode.Error);
  assert.equal(record?.attributes?.[TelemetryAttribute.ExceptionType], "Error");
  // Scrubbed at capture, so the record that crossed the wire carries neither
  // the address nor the install path, and still carries the diagnosis.
  assert.equal(
    record?.attributes?.[TelemetryAttribute.ExceptionMessage],
    "boot failed, notified [redacted-email]"
  );
  assert.equal(
    record?.attributes?.[TelemetryAttribute.ExceptionStacktrace],
    "Error: boot failed at readConfig ([redacted-path])"
  );
});

test("a sanitized exception is dated by its capture time, not by the emit clock", async () => {
  const runtime = createTrackedRuntime({
    appVersion: "1.2.3",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();
  // A fixed past instant, so this asserts value plumbing rather than a clock.
  const capturedAtUnixMs = 1_700_000_000_000;

  runtime.emitSanitizedAppExceptionEvent(
    {
      [TelemetryAttribute.ExceptionType]: "Error",
      [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.PreInit,
      [TelemetryAttribute.ExceptionMessage]: "queued before start",
    },
    capturedAtUnixMs
  );
  await runtime.shutdown();

  const record = runtime
    .getBufferedRecords()
    .find((item) => item.name === "exception");

  assert.equal(
    record?.timestampUnixNano,
    String(capturedAtUnixMs * 1_000_000),
    "a queued pre-init crash must not be dated to the moment OTel started"
  );
});

test("an exception origin the contract does not know drops the whole record", async () => {
  const runtime = createTrackedRuntime({
    appVersion: "1.2.3",
    env: { CLOSEDLOOP_DEPLOYMENT_ENVIRONMENT_NAME: "desktop-prod" },
    getAppInstallationId: () => "install_0123456789abcdef",
  });
  await runtime.start();
  // The failure mode that makes mirroring mandatory: AppTelemetrySchema's origin
  // enum is closed, so a producer-only value fails the parse and the WHOLE span
  // is dropped, silently, rather than the one attribute. `pre_init` needed no
  // mirror because it was already a member; a NEW origin would.
  const producerOnlyOrigin: string = "pre_init_v2";

  runtime.emitSanitizedAppExceptionEvent({
    [TelemetryAttribute.ExceptionType]: "Error",
    [TelemetryAttribute.AppExceptionOrigin]:
      producerOnlyOrigin as AppExceptionOrigin,
    [TelemetryAttribute.ExceptionMessage]: "unknown origin",
  });
  await runtime.shutdown();

  assert.equal(
    runtime.getBufferedRecords().find((item) => item.name === "exception"),
    undefined
  );
});

test("the registration index.ts performs is what routes a crash to the bridge", () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const target = createRecordingEventTarget();
  const exitCodes: number[] = [];

  registerBootstrapErrorHandlers(
    target,
    createBootstrapDeps(bridge, { exit: (code) => exitCodes.push(code) })
  );

  // Driving the callback the REGISTRATION installed, rather than rebuilding an
  // equivalent one here, is the whole point: a test that recreates the callback
  // stays green when this handoff is deleted or miswired, and real bootstrap
  // crashes go back to dialog-and-exit with no telemetry.
  target.emit("uncaughtException", new Error("module evaluation failed"));

  assert.deepEqual(exitCodes, [1], "the registered handler must still exit");
  assert.deepEqual(drainQueue(bridge), ["module evaluation failed"]);
});

test("the rejection event is registered too, not just the exception one", () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const target = createRecordingEventTarget();

  registerBootstrapErrorHandlers(target, createBootstrapDeps(bridge));
  target.emit("unhandledRejection", "startup contract violated");

  assert.deepEqual(drainQueue(bridge), ["startup contract violated"]);
});

test("dispose detaches exactly the listeners that were registered", () => {
  const bridge = createProcessExceptionTelemetryBridge();
  const target = createRecordingEventTarget();

  const registration = registerBootstrapErrorHandlers(
    target,
    createBootstrapDeps(bridge)
  );
  registration.dispose();

  // Removing by a different function reference — or naming a different event
  // than the registration did — leaks the bootstrap handler past startup, where
  // it would keep shadowing the full-featured pair startup.ts installs.
  assert.deepEqual(target.listenerCounts(), {
    uncaughtException: 0,
    unhandledRejection: 0,
  });

  target.emit("uncaughtException", new Error("after dispose"));
  assert.deepEqual(
    drainQueue(bridge),
    [],
    "a disposed handler must no longer capture"
  );
});

type RecordingEventTarget = BootstrapProcessEventTarget & {
  emit: (event: string, value: unknown) => void;
  listenerCounts: () => Record<string, number>;
};

/**
 * A stand-in for `process` that records what was registered, so a test can
 * invoke the real registered callback instead of a hand-built copy.
 */
function createRecordingEventTarget(): RecordingEventTarget {
  const listeners = new Map<string, ((value: unknown) => void)[]>();
  return {
    on(event, listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    removeListener(event, listener) {
      const existing = listeners.get(event) ?? [];
      listeners.set(
        event,
        existing.filter((candidate) => candidate !== listener)
      );
    },
    emit(event, value) {
      for (const listener of listeners.get(event) ?? []) {
        listener(value);
      }
    },
    listenerCounts() {
      const counts: Record<string, number> = {};
      for (const [event, registered] of listeners) {
        counts[event] = registered.length;
      }
      return counts;
    },
  };
}

function createBootstrapDeps(
  bridge: ProcessExceptionTelemetryBridge,
  overrides: Partial<BootstrapErrorHandlerDeps> = {}
): BootstrapErrorHandlerDeps {
  return {
    // The exact wiring index.ts installs.
    emitException: (error) => bridge.emitPreInitException(error),
    showDialog: () => undefined,
    exit: () => undefined,
    ...overrides,
  };
}

/**
 * Drains a bridge into a throwaway runtime and returns the messages it held, so
 * a test can observe the queue without a second public accessor.
 */
function drainQueue(
  bridge: ProcessExceptionTelemetryBridge
): (string | undefined)[] {
  const held: SanitizedDesktopExceptionAttributes[] = [];
  bridge.bindRuntime(
    createStubRuntime({
      emitSanitizedAppExceptionEvent: (attributes) => held.push(attributes),
    })
  );
  bridge.markRuntimeStarted();
  return held.map(
    (attributes) => attributes[TelemetryAttribute.ExceptionMessage]
  );
}

function createDrainRecorder(
  overrides: Partial<DesktopOtelRuntime> = {}
): DrainRecorder {
  const sanitized: SanitizedDesktopExceptionAttributes[] = [];
  let startCalls = 0;
  const runtime = createStubRuntime({
    start: () => {
      startCalls += 1;
      return Promise.resolve();
    },
    emitSanitizedAppExceptionEvent: (attributes) => {
      sanitized.push(attributes);
    },
    ...overrides,
  });
  return {
    runtime,
    sanitized,
    get startCalls() {
      return startCalls;
    },
  };
}

function createStubRuntime(
  overrides: Partial<DesktopOtelRuntime>
): DesktopOtelRuntime {
  return {
    start: () => Promise.resolve(),
    emitAppLifecycleEvent: () => undefined,
    emitAppExceptionEvent: () => undefined,
    emitSanitizedAppExceptionEvent: () => undefined,
    emitIpcPerfEvent: () => undefined,
    emitSyncBatchEvent: () => undefined,
    emitImportHealthEvent: () => undefined,
    emitAuthFailureEvent: () => false,
    emitDeadEndEvent: () => true,
    emitGenAiRequestEvent: () => undefined,
    emitOnboardingEvent: () => undefined,
    emitOnboardingDiscardEvent: () => undefined,
    emitUpdateEvent: () => true,
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    getBufferedRecords: () => [],
    resetBuffer: () => undefined,
    exportExternalRecords: () => ({
      ok: false,
      reason: RendererOtelExportFailureReason.Unavailable,
    }),
    ...overrides,
  };
}
