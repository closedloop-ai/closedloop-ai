import assert from "node:assert/strict";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { afterEach, test } from "vitest";
import type { DesktopOtelRuntime } from "../src/main/telemetry/app-otel-runtime.js";
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
import {
  collectAppLifecycleRecords,
  createLifecycleInputRecordingRuntime,
  createRecordingRuntime,
  createRejectingRuntime,
  createTrackedRuntimeFactory,
} from "./app-otel-runtime-test-helpers.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const { createTestRuntime, resetTrackedRuntime } =
  createTrackedRuntimeFactory();

afterEach(() => {
  nodeTestTimers.reset();
  return resetTrackedRuntime();
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
  nodeTestTimers.enable(["setTimeout"]);
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
  nodeTestTimers.tick(OBSERVABILITY_SHUTDOWN_DEADLINE_MS);

  // Resolves via the deadline even though runtime.shutdown() never settled.
  await shutdownPromise;
  assert.equal(shutdownStarted, true);
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
