/**
 * ISS-11099 — main-process `exception` spans carry `app.organization.id`, so
 * the Agent Monitor boot-failure monitor can be partitioned by org the way its
 * sibling desktop monitors are.
 *
 * Driven through the real process-exception bridge into a real runtime: the
 * bridge is what `startup.ts` routes uncaught exceptions into. Post-start
 * exceptions only. The pre-init drain runs inside
 * `startDesktopOtelRuntimeForBoot`, before `app.ts boot()` warms the org
 * provider, so a drained `pre_init` span ships without the org; monitor
 * 319264706 filters `@app.exception.origin:main` and never selects one.
 */
import assert from "node:assert/strict";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { afterEach, test } from "vitest";
import { DesktopAppOperatingMode } from "../src/main/telemetry/app-otel-runtime-lifecycle.js";
import { createProcessExceptionTelemetryBridge } from "../src/main/telemetry/process-exception-telemetry-bridge.js";
import { DesktopOtelSignal } from "../src/shared/renderer-otel-bridge-constants.js";
import { createTrackedRuntimeFactory } from "./app-otel-runtime-test-helpers.js";

const { createTestRuntime, resetTrackedRuntime } =
  createTrackedRuntimeFactory();

afterEach(resetTrackedRuntime);

const ORGANIZATION_ID = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";

function errorWithStack(message: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}`;
  return error;
}

function exceptionBag(message: string, origin: string) {
  return {
    "exception.type": "Error",
    "exception.message": message,
    "exception.stacktrace": `Error: ${message}`,
    "app.exception.origin": origin,
  };
}

test("a post-start exception span names the org when the install is signed in", async () => {
  const runtime = createTestRuntime({
    getOperatingMode: () => DesktopAppOperatingMode.Multiplayer,
    getOrganizationId: () => ORGANIZATION_ID,
  });
  const bridge = createProcessExceptionTelemetryBridge();
  bridge.bindRuntime(runtime);
  await runtime.start();
  bridge.markRuntimeStarted();
  bridge.emitMainException(errorWithStack("after start"));
  await runtime.shutdown();

  const exceptions = runtime
    .getBufferedRecords()
    .filter(
      (record) =>
        record.signal === DesktopOtelSignal.Trace && record.name === "exception"
    )
    .map((record) => record.attributes);

  assert.deepEqual(exceptions, [
    {
      ...exceptionBag("after start", AppExceptionOrigin.Main),
      "app.organization.id": ORGANIZATION_ID,
    },
  ]);
});

test("a post-start exception span omits the org before sign-in resolves one and in single-player, and still ships", async () => {
  let operatingMode: DesktopAppOperatingMode =
    DesktopAppOperatingMode.Multiplayer;
  let organizationId: string | undefined;
  const runtime = createTestRuntime({
    getOperatingMode: () => operatingMode,
    getOrganizationId: () => organizationId,
  });
  const bridge = createProcessExceptionTelemetryBridge();
  bridge.bindRuntime(runtime);
  await runtime.start();
  bridge.markRuntimeStarted();

  // Multiplayer, but no org resolved yet (no key, or `GET /me` pending).
  bridge.emitMainException(errorWithStack("unresolved"));
  // Single-player with a resolver that HAS an org, so the omission is proved
  // by the operating-mode gate rather than by an empty resolver.
  operatingMode = DesktopAppOperatingMode.SinglePlayer;
  organizationId = ORGANIZATION_ID;
  bridge.emitMainException(errorWithStack("single player"));
  await runtime.shutdown();

  const exceptions = runtime
    .getBufferedRecords()
    .filter((record) => record.name === "exception")
    .map((record) => record.attributes);

  // Whole-bag equality: an org serialized as `null` or `""` fails here too.
  assert.deepEqual(exceptions, [
    exceptionBag("unresolved", AppExceptionOrigin.Main),
    exceptionBag("single player", AppExceptionOrigin.Main),
  ]);
});
